/* raw -> canonical, using the app's EXISTING mappers (scripts/build-index.mjs,
 * src/lib/sources.js). Nothing here decides what a field means; it only says
 * which mapper reads which payload format, and records what changed.
 *
 * Canonical text is kept WHOLE (the mappers run with no caps). Trimming is a
 * publishing concern (src/lib/publication.js PUBLISH_CAPS), not a storage one.
 */
import { createHash } from "node:crypto";

import { fdaToIndex, fsisToIndex, cpscToIndex, announcementToIndex, announcementHints } from "../build-index.mjs";
import { slimFsis, slimCpsc } from "../../src/lib/sources.js";

const UNCAPPED = { text: Infinity, firm: Infinity, dist: Infinity };

/** JSON with object keys sorted, so one payload has one hash however the
 *  upstream happened to order its keys today. */
export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

export function hashOf(v) {
  return createHash("sha256").update(stableStringify(v)).digest("hex");
}

const FEED_OF_FORMAT = (format) =>
  format.startsWith("openfda:") ? "fda"
    : format.startsWith("fsis") ? "fsis"
    : format.startsWith("cpsc") ? "cpsc"
    : format === "rss-item" ? "announcements"
    : null;

/**
 * One raw payload -> canonical row (plain object, column names), or throws.
 *
 *   openfda:<kind>   a raw openFDA enforcement result      -> fdaToIndex
 *   fsis-api         a raw USDA record (slimmed first, exactly as the
 *                    snapshot job does; a record slimFsis drops — closed and
 *                    over a year old — is mapped as received)  -> fsisToIndex
 *   fsis-snapshot    a record of public/feeds/fsis.json (already slim)
 *   cpsc-api         a raw CPSC record (slimCpsc first)    -> cpscToIndex
 *   cpsc-snapshot    a record of public/feeds/cpsc.json (already slim)
 *   rss-item         a parsed FDA recalls RSS item         -> announcementToIndex
 *   index-record     a record of the committed public/feeds/index.json (the
 *                    bootstrap path, --from-snapshots): already canonical in
 *                    shape, so it is taken as it is.
 */
export function rawToCanonical(format, payload, feedHint = null) {
  let rec;
  let hints = {};
  if (format.startsWith("openfda:")) {
    rec = fdaToIndex(format.slice(8), payload, UNCAPPED);
  } else if (format === "fsis-api") {
    rec = fsisToIndex(slimFsis([payload])[0] || payload, UNCAPPED);
  } else if (format === "fsis-snapshot") {
    rec = fsisToIndex(payload, UNCAPPED);
  } else if (format === "cpsc-api") {
    rec = cpscToIndex(slimCpsc([payload])[0], UNCAPPED); // slimCpsc keeps Images[0].URL as Image
  } else if (format === "cpsc-snapshot") {
    rec = cpscToIndex(payload, UNCAPPED);
  } else if (format === "rss-item") {
    rec = announcementToIndex(payload, UNCAPPED);
    hints = announcementHints(payload);
  } else if (format === "index-record") {
    rec = payload;
    /* The release body is not in the committed index; its title (product)
     * and the start of its text (reason) are the nearest thing. Replaced by
     * the real item on the first live sync. */
    if (rec.announcement) hints = announcementHints({ title: rec.product, description: rec.reason });
  } else {
    throw new Error(`unknown raw format ${format}`);
  }
  const feed = FEED_OF_FORMAT(format) || feedHint;
  return {
    id: rec.id,
    feed,
    source: rec.source,
    product: rec.product || "",
    firm: rec.firm || "",
    reason: rec.reason || "",
    classification: rec.classification || "",
    severity: rec.severity || "med",
    status: rec.status || "active",
    distribution: rec.distribution || "",
    states: rec.states || [],
    coverage: rec.coverage || "unstated",
    initiated: rec.date || null,
    // FDA's report date is kept even when it equals the start date; the
    // published record omits it then, as the index does.
    posted: rec.posted || (feed === "fda" ? rec.date || null : null),
    ended: rec.endDate || null,
    url: rec.url || "",
    upcs: rec.upcs || [],
    image: rec.image || null,
    announcement: !!rec.announcement,
    hints,
  };
}

/* The fields whose change is worth a history row. */
export const TRACKED_FIELDS = ["status", "states", "coverage", "classification", "severity", "ended"];

const RECALL_COLS = `id text, feed text, source text, source_key text, product text, firm text, reason text,
  classification text, severity text, status text, distribution text, states jsonb, coverage text,
  initiated text, posted text, ended text, url text, upcs jsonb, image text, announcement boolean,
  hints jsonb, raw_hash text, content_hash text`;

const BATCH = 1000;

/**
 * Re-normalize every recall of `feed` from its newest raw version. Cheap
 * (thousands of rows) and deliberately total: a USDA notice can turn from
 * active to ended by age alone (fsisStatus), with no new payload at all.
 *
 * @returns {Promise<{inserted, updated, unchanged, rehashed, failed, changes}>}
 */
export async function normalizeFeed(db, { feed, runId, now }) {
  const at = now.toISOString();
  const raws = await db.query(
    `select distinct on (source_key) source_key, format, payload, payload_hash
       from raw_records where source = $1
      order by source_key, last_run_id desc, id desc`, [feed]);
  const existing = new Map((await db.query(
    `select id, content_hash, raw_hash, status, to_jsonb(states) as states, coverage, classification, severity,
            ended::text as ended
       from recalls where feed = $1`, [feed])).map((r) => [r.id, r]));

  const stats = { inserted: 0, updated: 0, unchanged: 0, rehashed: 0, failed: 0, changes: 0 };
  const upserts = [];
  const rehash = [];
  const changes = [];
  for (const raw of raws) {
    let c;
    try {
      c = rawToCanonical(raw.format, raw.payload, feed);
    } catch (err) {
      stats.failed++;
      continue;
    }
    if (!c.id) { stats.failed++; continue; }
    const content_hash = hashOf(c).slice(0, 32);
    const row = { ...c, source_key: raw.source_key, raw_hash: raw.payload_hash, content_hash };
    const prev = existing.get(c.id);
    if (!prev) {
      stats.inserted++;
      upserts.push(row);
    } else if (prev.content_hash !== content_hash) {
      stats.updated++;
      upserts.push(row);
      for (const f of TRACKED_FIELDS) {
        const old = prev[f] == null ? null : prev[f];
        const nu = c[f] == null ? null : c[f];
        if (stableStringify(old) !== stableStringify(nu)) changes.push({ recall_id: c.id, field: f, old, new: nu });
      }
    } else {
      stats.unchanged++;
      if (prev.raw_hash !== raw.payload_hash) rehash.push({ id: c.id, raw_hash: raw.payload_hash });
    }
  }

  await db.tx(async (t) => {
    for (let i = 0; i < upserts.length; i += BATCH) {
      await t.query(
        `insert into recalls (id, feed, source, source_key, product, firm, reason, classification, severity, status,
           distribution, states, coverage, initiated, posted, ended, url, upcs, image, announcement, hints,
           raw_hash, content_hash, first_seen, updated_at)
         select id, feed, source, source_key, product, firm, reason, classification, severity, status,
           distribution, array(select jsonb_array_elements_text(states)), coverage, initiated::date, posted::date,
           ended::date, url, array(select jsonb_array_elements_text(upcs)), image, announcement, hints,
           raw_hash, content_hash, $2::timestamptz, $2::timestamptz
           from jsonb_to_recordset($1::jsonb) as x(${RECALL_COLS})
         on conflict (id) do update set
           feed = excluded.feed, source = excluded.source, source_key = excluded.source_key,
           product = excluded.product, firm = excluded.firm, reason = excluded.reason,
           classification = excluded.classification, severity = excluded.severity, status = excluded.status,
           distribution = excluded.distribution, states = excluded.states, coverage = excluded.coverage,
           initiated = excluded.initiated, posted = excluded.posted, ended = excluded.ended, url = excluded.url,
           upcs = excluded.upcs, image = excluded.image, announcement = excluded.announcement,
           hints = excluded.hints, raw_hash = excluded.raw_hash, content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
        [JSON.stringify(upserts.slice(i, i + BATCH)), at]);
    }
    if (rehash.length) {
      await t.query(
        `update recalls r set raw_hash = x.raw_hash
           from jsonb_to_recordset($1::jsonb) as x(id text, raw_hash text) where r.id = x.id`,
        [JSON.stringify(rehash)]);
    }
    if (changes.length) {
      await t.query(
        `insert into recall_changes (recall_id, at, field, old, new, sync_run_id)
         select recall_id, $2::timestamptz, field, old, new, $3::bigint
           from jsonb_to_recordset($1::jsonb) as x(recall_id text, field text, old jsonb, new jsonb)`,
        [JSON.stringify(changes), at, runId]);
    }
  });
  stats.rehashed = rehash.length;
  stats.changes = changes.length;
  return stats;
}

/**
 * Store one fetch's payloads. A payload identical to one already stored for
 * that record only moves its last_seen; a different one is a new version.
 * @param {{key: string, format: string, payload: object}[]} items
 * @returns {Promise<{raw_new: number, seen: number}>}
 */
export async function writeRaw(db, { source, runId, now, items }) {
  const at = now.toISOString();
  let rawNew = 0;
  let seen = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH).map((it) => ({
      source_key: it.key, format: it.format, payload: it.payload, payload_hash: hashOf(it.payload),
    }));
    const [r] = await db.query(
      `with ins as (
         insert into raw_records (source, source_key, format, payload, payload_hash, first_seen, last_seen, fetch_run_id, last_run_id)
         select $2, source_key, format, payload, payload_hash, $3::timestamptz, $3::timestamptz, $4::bigint, $4::bigint
           from jsonb_to_recordset($1::jsonb) as x(source_key text, format text, payload jsonb, payload_hash text)
         on conflict (source, source_key, payload_hash) do update set last_seen = excluded.last_seen, last_run_id = excluded.last_run_id
         returning (xmax = 0) as fresh)
       select count(*) filter (where fresh)::int as raw_new, count(*)::int as seen from ins`,
      [JSON.stringify(batch), source, at, runId]);
    rawNew += r.raw_new;
    seen += r.seen;
  }
  return { raw_new: rawNew, seen };
}
