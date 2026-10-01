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

/* Only ids built from a real recall number ("fda-food-H-1339-2026"); ids
 * made for "N/A" records (fda-food-e<event>-<hash>) have no number to ask by. */
const FDA_ID = /^fda-(food|drug|device)-([A-Z]-\d{3,5}-\d{4})$/;

async function fromOpenFda(kind, recallNumber) {
  const key = process.env.openfda;
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
 *  @returns {Promise<{record: object|null, from: 'index'|'openfda'|null, index: object|null}>} */
export async function resolveRecall(id) {
  const clean = String(id || "").slice(0, 120);
  const idx = await readIndex();
  const index = idx ? { builtAt: idx.builtAt || null, recalls: idx.recalls.length } : null;
  if (!clean) return { record: null, from: null, index };
  const hit = findRecall(idx, clean);
  if (hit) return { record: hit, from: "index", index };
  const m = clean.match(FDA_ID);
  if (m) {
    const live = await fromOpenFda(m[1], m[2]);
    if (live) return { record: live, from: "openfda", index };
  }
  return { record: null, from: null, index };
}
