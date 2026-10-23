/* One shared recall id -> the recall, for /r/:id links and their preview card.
 *
 * The national index is the first place to look, and for most links the only
 * one needed. It is not enough on its own, which is how shared links came to
 * land on the homepage: until the refresh job first ran with FDA data (Oct 1,
 * 2026), the index held no FDA records at all, so every FDA recall someone
 * shared resolved to nothing and api/share.js forwarded to "/". The index can
 * also lag the live lists by a refresh, or simply not hold an id.
 *
 * So an FDA id the index lacks is asked of openFDA directly, by its recall
 * number — an exact field, any status, no date window, one request. USDA and
 * CPSC ids are only ever resolved from the index: their whole feeds are in it.
 */
import { readIndex, findRecall } from "../../src/lib/index-server.js";
import { normalizeFda } from "../../src/lib/sources.js";
import { sharedDb } from "../../src/lib/db.js";
import { toIndexRecord } from "../../src/lib/publication.js";

/* When the recall database is configured (DATABASE_URL), it is asked first:
 * it holds every recall the sync has ever seen, not only the published
 * window. Any failure there falls through to the committed index. */
async function fromDatabase(id) {
  try {
    const db = await sharedDb();
    if (!db) return null;
    const [row] = await db.query(
      `select r.id, r.source, r.product, r.firm, r.reason, r.classification, r.severity, r.status,
              r.distribution, to_jsonb(r.states) as states, r.coverage, r.initiated::text as initiated,
              r.posted::text as posted, r.ended::text as ended, r.url, to_jsonb(r.upcs) as upcs, r.image,
              r.announcement, i.category, i.reason_key
         from recalls r
         join lateral (select category, reason_key from recall_index
                        where recall_id = r.id order by classifier_version desc limit 1) i on true
        where r.id = $1 and r.initiated is not null`, [id]);
    return row ? toIndexRecord(row) : null;
  } catch (err) {
    console.error(`resolve-recall: database unavailable — ${(err && err.message) || err}`);
    return null;
  }
}

/* Only ids built from a real recall number ("fda-food-H-1339-2026"); ids
 * made for "N/A" records (fda-food-e<event>-<hash>) have no number to ask by. */
const FDA_ID = /^fda-(food|drug|device)-([A-Z]-\d{3,5}-\d{4})$/;

async function fromOpenFda(kind, recallNumber) {
  const key = (process.env.OPENFDA_KEY || process.env.openfda);
  const url = `https://api.fda.gov/${kind}/enforcement.json?search=recall_number:"${recallNumber}"&limit=1` +
    (key ? `&api_key=${key}` : "");
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null; // 404 is openFDA's "no match"; anything else, we just don't know
    const body = await res.json();
    const [record] = normalizeFda(kind, (body && body.results) || [], null);
    return record ? { ...record, date: record.date ? new Date(record.date).toISOString().slice(0, 10) : null } : null;
  } catch (_) {
    return null;
  }
}

/** `index` says whether the national index could be read at all, so a "not
 *  found" can be told apart from "this function cannot see the index" — the
 *  second would break every shared link and look exactly like the first.
 *  @returns {Promise<{record: object|null, from: 'database'|'index'|'openfda'|null, index: object|null}>} */
export async function resolveRecall(id) {
  const clean = String(id || "").slice(0, 120);
  const idx = await readIndex();
  const index = idx ? { builtAt: idx.builtAt || null, recalls: idx.recalls.length } : null;
  if (!clean) return { record: null, from: null, index };
  const stored = await fromDatabase(clean);
  if (stored) return { record: stored, from: "database", index };
  const hit = findRecall(idx, clean);
  if (hit) return { record: hit, from: "index", index };
  const m = clean.match(FDA_ID);
  if (m) {
    const live = await fromOpenFda(m[1], m[2]);
    if (live) return { record: live, from: "openfda", index };
  }
  return { record: null, from: null, index };
}
