/* recalls -> recall_index: the derived layer.
 *
 * Everything here is a pure function of a canonical row. Category and reason
 * come from classifyRecord (scripts/build-index.mjs), the same function the
 * committed index uses, reading the text at the loosest publishing cap — what
 * the index build classified on at its loosest tier — so the two agree.
 *
 * BUMP CLASSIFIER_VERSION whenever src/lib/category.js, src/lib/reason.js,
 * classifyRecord or deriveIndexRow change what they return. The next sync
 * (or `node scripts/sync/run.mjs --reindex`) derives every recall at the new
 * version from the stored canonical rows — no agency is asked for anything —
 * then drops the old version's rows. raw_records and recalls are untouched.
 */
import { classifyRecord } from "../build-index.mjs";
import { PUBLISH_CAPS, capText } from "../../src/lib/publication.js";

export const CLASSIFIER_VERSION = 1;

const arr = (v) => (Array.isArray(v) ? v : []);

/** One canonical row -> its recall_index row (minus bookkeeping columns). */
export function deriveIndexRow(r) {
  const forClassifier = {
    source: r.source,
    product: capText(r.product, PUBLISH_CAPS.text),
    reason: capText(r.reason, PUBLISH_CAPS.text),
    classification: r.classification || "",
  };
  const { category, reasonKey } = classifyRecord(forClassifier, r.hints || {});
  const searchText = [r.product, r.firm, r.reason, ...arr(r.upcs)]
    .join(" ").toLowerCase().replace(/\s+/g, " ").trim();
  const a = r.initiated || "";
  const b = r.posted || "";
  return { recall_id: r.id, category, reason_key: reasonKey, search_text: searchText, news_day: (b > a ? b : a) || null };
}

const BATCH = 1000;

/**
 * Derive every recall whose index row is missing at `version` or was derived
 * from an older canonical version; then drop rows of other versions.
 * @returns {Promise<{derived: number, removed: number, version: number}>}
 */
export async function deriveIndex(db, { version = CLASSIFIER_VERSION, now = new Date() } = {}) {
  const rows = await db.query(
    `select r.id, r.source, r.product, r.firm, r.reason, r.classification, r.hints, to_jsonb(r.upcs) as upcs,
            r.initiated::text as initiated, r.posted::text as posted, r.content_hash
       from recalls r
       left join recall_index i on i.recall_id = r.id and i.classifier_version = $1::int
      where i.recall_id is null or i.source_hash <> r.content_hash`, [version]);
  const out = rows.map((r) => ({ ...deriveIndexRow(r), source_hash: r.content_hash }));
  let removed = 0;
  await db.tx(async (t) => {
    for (let i = 0; i < out.length; i += BATCH) {
      await t.query(
        `insert into recall_index (recall_id, classifier_version, category, reason_key, search_text, news_day, source_hash, derived_at)
         select recall_id, $2::int, category, reason_key, search_text, news_day::date, source_hash, $3::timestamptz
           from jsonb_to_recordset($1::jsonb) as x(recall_id text, category text, reason_key text, search_text text, news_day text, source_hash text)
         on conflict (recall_id, classifier_version) do update set
           category = excluded.category, reason_key = excluded.reason_key, search_text = excluded.search_text,
           news_day = excluded.news_day, source_hash = excluded.source_hash, derived_at = excluded.derived_at`,
        [JSON.stringify(out.slice(i, i + BATCH)), version, now.toISOString()]);
    }
    const [d] = await t.query(
      `with gone as (delete from recall_index where classifier_version <> $1::int returning 1)
       select count(*)::int as n from gone`, [version]);
    removed = d.n;
  });
  return { derived: out.length, removed, version };
}
