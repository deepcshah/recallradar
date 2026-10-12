/* Look one product up across openFDA — including recalls that are over.
 *
 * Every other path in this app asks openFDA for `status:"Ongoing"`, which is
 * right for "what should I worry about near me" and wrong for the question
 * people actually arrive with after seeing a headline: *is that thing still
 * recalled?* Under the ongoing-only query, a notice that has since been
 * terminated and a notice we never had look identical — both absent.
 *
 * `status` is openFDA's own lifecycle field (Ongoing / Completed / Terminated
 * / Pending), so "resolved" is public data we were filtering away rather than
 * a gap in the feeds. This endpoint drops the filter and reports the status
 * instead, which turns silence into an answer.
 *
 *   GET /api/lookup?upc=012345678905
 *   GET /api/lookup?q=romaine%20lettuce
 *
 * A text query searches product_description, recalling_firm and
 * reason_for_recall, 100 per kind (openFDA's maximum), and is then ranked
 * here — see api/_lib/lookup-rank.js — because "sugar" otherwise returns
 * every product with sugar in its ingredients. When a kind has more matches
 * than one page, a second firm-only query (always precise) is added so a
 * firm's recall cannot be crowded out by ingredient mentions.
 *
 * Response (all older fields unchanged):
 *   { query, matches: [...top 40, each with `relevance` 1–3],
 *     total        relevant matches the 40 were drawn from
 *     dropped      ingredient-list-only matches left out
 *     upstreamTotal  openFDA's own match count, summed over kinds
 *     truncated    true when openFDA had more matches than were fetched
 *     lastUpdated  newest openFDA meta.last_updated across kinds (YYYY-MM-DD)
 *     lastUpdatedByKind, activeCount, resolvedCount, partial? }
 */
import { rankMatches } from "./_lib/lookup-rank.js";
import { fdaId } from "../src/lib/sources.js";

const KINDS = ["food", "drug", "device"];
const LOOKBACK_DAYS = 1095; // three years: long enough to cover "I saw it on the news"
const LIMIT = 100; // openFDA's per-request maximum
const RETURN = 40;

function fmt(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/* openFDA's Lucene syntax treats most punctuation as a term separator, so a
 * quoted phrase is the only reliable way to search free text. Anything that
 * could break out of the quotes is stripped rather than escaped. */
function phrase(s) {
  return String(s).replace(/["\\()\[\]{}:~^]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function jfetch(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (res.status === 404) return { results: [], meta: { results: { total: 0 } } }; // openFDA's "no matches"
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* openFDA's "no matches" is a 404 with no meta, so a miss carries no
 * last_updated — and "nothing matched" is only an answer if you know how old
 * the data was. One unfiltered request returns it; it changes weekly, so it is
 * kept for an hour per warm instance. Best-effort: null when it fails. */
let lastUpdatedProbe = { at: 0, value: null };
async function openFdaLastUpdated(key) {
  if (Date.now() - lastUpdatedProbe.at < 3600000) return lastUpdatedProbe.value;
  try {
    const data = await jfetch(`https://api.fda.gov/food/enforcement.json?limit=1${key ? `&api_key=${key}` : ""}`, 8000);
    lastUpdatedProbe = { at: Date.now(), value: (data && data.meta && data.meta.last_updated) || null };
  } catch (_) {
    return null; // not cached: worth asking again next time
  }
  return lastUpdatedProbe.value;
}

/* The phrase clause misses when the words are not adjacent in that order —
 * "acme sugar" against a firm filed as "Acme Sugars Corporation", or
 * "brown sugar powdered" against "powdered and light brown sugar". This is
 * the fallback: every word must appear, each in any of the three fields. */
function wordsClause(q) {
  const ws = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2).slice(0, 6);
  if (ws.length < 2) return null;
  return ws.map((w) => `(product_description:${w}+OR+recalling_firm:${w}+OR+reason_for_recall:${w})`).join("+AND+");
}

export default async function handler(req, res) {
  const upc = String(req.query.upc || "").replace(/\D/g, "").slice(0, 14);
  const q = phrase(req.query.q || "");
  if (!upc && !q) return res.status(400).json({ error: "pass ?upc= or ?q=" });

  const key = process.env.openfda;
  const since = fmt(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
  const until = fmt(new Date());

  /* A barcode is printed several ways — UPC-A, EAN-13, GTIN-14 — and which
   * one a notice used is arbitrary. Search the forms that carry real
   * information rather than the zero-padded canonical one. */
  const forms = upc
    ? [...new Set([upc, upc.replace(/^0+/, ""), upc.padStart(13, "0"), upc.padStart(12, "0")])].filter((f) => f.length >= 11)
    : [];

  const clause = upc
    ? `(${forms.map((f) => `code_info:"${f}"+OR+product_description:"${f}"`).join("+OR+")})`
    : `(product_description:"${q}"+OR+recalling_firm:"${q}"+OR+reason_for_recall:"${q}")`;
  const window = `+AND+report_date:[${since}+TO+${until}]`;
  const urlFor = (kind, c) =>
    `https://api.fda.gov/${kind}/enforcement.json?search=${(c + window).replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=${LIMIT}` + (key ? `&api_key=${key}` : "");

  const toMatch = (kind) => (r) => ({
    id: fdaId(kind, r),
    source: { food: "FDA Food", drug: "FDA Drug", device: "FDA Device" }[kind],
    product: r.product_description || "",
    firm: r.recalling_firm || "",
    reason: r.reason_for_recall || "",
    classification: r.classification || "",
    // The whole point of this endpoint.
    status: r.status || "Unknown",
    terminationDate: r.termination_date || "",
    reportDate: r.report_date || "",
    distribution: r.distribution_pattern || "",
    codeInfo: r.code_info || "",
  });

  const runKind = (c) => async (kind) => {
    const data = await jfetch(urlFor(kind, c));
    const results = (data && data.results) || [];
    const total = (data && data.meta && data.meta.results && data.meta.results.total) || results.length;
    const lastUpdated = (data && data.meta && data.meta.last_updated) || null;
    /* More matches than one page: add the firm-only query, which cannot be
     * flooded by ingredient lists. Best-effort — the first page stands alone. */
    if (!upc && total > results.length) {
      try {
        const firm = await jfetch(urlFor(kind, `recalling_firm:"${q}"`));
        results.push(...((firm && firm.results) || []));
      } catch (_) { /* keep the first page */ }
    }
    return { matches: results.map(toMatch(kind)), total, fetched: results.length, lastUpdated };
  };

  let settled = await Promise.allSettled(KINDS.map(runKind(clause)));
  let matchedOn = upc ? "barcode" : "phrase";
  const nothing = (ss) => ss.every((s) => s.status === "fulfilled" && s.value.total === 0);
  const loose = upc ? null : wordsClause(q);
  if (loose && nothing(settled)) {
    settled = await Promise.allSettled(KINDS.map(runKind(`(${loose})`)));
    matchedOn = "words";
  }
  const all = [];
  const failed = [];
  const lastUpdatedByKind = {};
  let upstreamTotal = 0;
  let truncated = false;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      all.push(...s.value.matches);
      upstreamTotal += s.value.total;
      if (s.value.total > s.value.fetched) truncated = true;
      if (s.value.lastUpdated) lastUpdatedByKind[KINDS[i]] = s.value.lastUpdated;
    } else failed.push(KINDS[i]);
  });

  // Every source failing is an outage, not an answer — say so rather than
  // returning an empty list that reads as "nothing found".
  if (failed.length === KINDS.length) {
    return res.status(502).json({ error: "openFDA is unreachable right now — try again shortly." });
  }

  // The firm-only query overlaps the first; ids are stable.
  const seen = new Set();
  const unique = all.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const { ranked, dropped } = upc
    ? { ranked: unique.sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate))).map((m) => ({ ...m, relevance: 3 })), dropped: 0 }
    : rankMatches(unique, q);
  const active = ranked.filter((m) => /ongoing|pending/i.test(m.status));
  const lastUpdated = Object.values(lastUpdatedByKind).sort().pop() || (await openFdaLastUpdated(key));

  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json({
    query: upc ? { upc } : { q },
    matchedOn,
    matches: ranked.slice(0, RETURN),
    total: ranked.length,
    dropped,
    upstreamTotal,
    truncated,
    lastUpdated,
    lastUpdatedByKind,
    activeCount: active.length,
    resolvedCount: ranked.length - active.length,
    partial: failed.length ? failed : undefined,
  });
}

export const config = { maxDuration: 30 };
