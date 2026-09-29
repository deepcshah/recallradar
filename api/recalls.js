/* One-shot recall aggregator: fetches all five government feeds server-side
 * in parallel (openFDA with the API key from the `openfda` env var),
 * normalizes them with the same code the client uses, and returns one small
 * ready-to-render payload. Edge-cached per state for 15 minutes, so most
 * page loads never touch a government API at all.
 */
import {
  normalizeFda, normalizeFsis, normalizeCpsc, sortRecalls,
  slimFsis, slimCpsc, fdaSearchQuery, unscopedSearchQuery, CPSC_LOOKBACK_DAYS,
  fdaLastUpdated, fdaTotal, needsUnscopedDepth,
} from "../src/lib/sources.js";
import { FEED_HEADERS, fsisFetch, cpscUrl } from "../src/lib/feeds.js";
import { isInArea } from "../src/lib/verdict.js";
import { FEED_BLOBS, feedWithFallback } from "../src/lib/feed-cache.js";

async function jfetch(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: FEED_HEADERS,
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

const FDA_PAGE = 100;      // openFDA's hard per-request maximum
/* 5 pages = the newest 500 per kind. The state-scoped query is small now that
 * ambiguous codes are not queried as words (fdaDistributionClause in
 * src/lib/sources.js), so this rarely binds there; it is the depth of the
 * unscoped pass for Indiana, Oregon, Maine & co., whose abbreviation-only
 * notices are found there. Pages run sequentially; both passes run in
 * parallel, inside the 60s budget. */
const FDA_MAX_PAGES = 5;

/* Newest-first paging with `skip` until a short page comes back or the page
 * cap is hit. Returns what was fetched plus what openFDA said about it:
 * `total` (all matches), `lastUpdated` (meta.last_updated) and `truncated`
 * when total exceeded what was fetched. */
async function pageFda(kind, search, key, maxPages) {
  const base =
    `https://api.fda.gov/${kind}/enforcement.json?search=${search.replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=${FDA_PAGE}` + (key ? `&api_key=${key}` : "");
  const results = [];
  let total = null;
  let lastUpdated = null;
  let short = false;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await jfetch(page === 0 ? base : `${base}&skip=${page * FDA_PAGE}`);
    } catch (err) {
      if (err.status === 404) { short = true; break; } // openFDA's "no (more) matches"
      if (page > 0) break;           // keep whatever earlier pages returned
      throw err;
    }
    if (page === 0) {
      total = fdaTotal(data);
      lastUpdated = fdaLastUpdated(data);
    }
    const batch = (data && data.results) || [];
    results.push(...batch);
    if (batch.length < FDA_PAGE) { short = true; break; }
  }
  const truncated = total != null ? total > results.length : !short;
  return { results, total, lastUpdated, truncated };
}

/* openFDA caps a response at 100 records, so a single call silently truncates
 * to the newest 100 and hides everything else — hence paging, and hence the
 * `truncated` flag, so the UI can say "showing the newest N" rather than
 * presenting a cut list as the whole answer. */
async function fetchFda(kind, loc) {
  const key = process.env.openfda;
  if (!loc) return fetchFdaNational(kind, key);

  /* The second pass has no distribution clause at all.
   *
   * The scoped query can only match text that names your state or says
   * nationwide, so a notice whose distribution reads "Sold at Trader Joe's
   * stores" — a chain and no geography — is invisible to it. That is exactly
   * the class this app exists to surface. openFDA has no way to ask for
   * "names no state", so the filtering happens in the handler below, through
   * isInArea: everything here that names a state other than yours comes back
   * from normalizeFda as scope 'elsewhere' and is dropped there, and what is
   * left with no geography has to name a retailer to survive.
   *
   * For an ambiguous code (IN, OR, ME, …) the scoped query asks only for the
   * full name, so this pass is also what finds "IL, IN, IA" — it goes as deep
   * as the scoped pass, and its truncation is reported. Otherwise one page,
   * best-effort: a widening, not a correctness requirement. */
  const deep = needsUnscopedDepth(loc);
  const [scoped, loose] = await Promise.all([
    pageFda(kind, fdaSearchQuery(loc), key, FDA_MAX_PAGES),
    pageFda(kind, unscopedSearchQuery(), key, deep ? FDA_MAX_PAGES : 1)
      .catch(() => (deep ? { results: [], truncated: true, total: null, lastUpdated: null } : null)),
  ]);

  const raw = [...scoped.results, ...((loose && loose.results) || [])];
  // Both passes can return the same notice; normalizeFda's ids are stable.
  const seen = new Set();
  const recalls = normalizeFda(kind, raw, loc).filter((r) => !seen.has(r.id) && seen.add(r.id));

  const truncated = scoped.truncated || (deep && !!loose && loose.truncated);
  /* How far back a truncated list reaches: the oldest report_date among the
   * pass that was cut, so the UI can say "showing notices since …". */
  const cut = scoped.truncated ? scoped.results : (loose && loose.results) || [];
  const oldestRaw = truncated
    ? cut.map((r) => String(r.report_date || "")).filter((d) => /^\d{8}$/.test(d)).sort()[0]
    : null;
  if (truncated) console.log(`fda ${kind}: truncated (scoped ${scoped.results.length}/${scoped.total}, loose ${loose ? `${loose.results.length}/${loose.total}` : "failed"})`);

  return {
    recalls,
    lastUpdated: scoped.lastUpdated || (loose && loose.lastUpdated) || null,
    truncated,
    ...(oldestRaw ? { oldest: `${oldestRaw.slice(0, 4)}-${oldestRaw.slice(4, 6)}-${oldestRaw.slice(6, 8)}` } : null),
    fetchedAt: new Date().toISOString(),
  };
}

/* All US (`?scope=us`): every active notice in the lookback window, wherever
 * it went — one unscoped pass, as deep as the scoped one, with the same
 * truncation report. Records keep their `states`; with no reader their scope
 * is 'nationwide', 'elsewhere' or 'unstated', never 'state'. */
async function fetchFdaNational(kind, key) {
  const all = await pageFda(kind, unscopedSearchQuery(), key, FDA_MAX_PAGES);
  const seen = new Set();
  const recalls = normalizeFda(kind, all.results, null).filter((r) => !seen.has(r.id) && seen.add(r.id));
  const oldestRaw = all.truncated
    ? all.results.map((r) => String(r.report_date || "")).filter((d) => /^\d{8}$/.test(d)).sort()[0]
    : null;
  return {
    recalls,
    lastUpdated: all.lastUpdated || null,
    truncated: all.truncated,
    ...(oldestRaw ? { oldest: `${oldestRaw.slice(0, 4)}-${oldestRaw.slice(4, 6)}-${oldestRaw.slice(6, 8)}` } : null),
    fetchedAt: new Date().toISOString(),
  };
}

/* Both of these go through the same shape: try live, cache every success,
 * and fall back to the last good copy rather than dropping a whole agency out
 * of the answer. See src/lib/feed-cache.js for why each one needs it.
 *
 * The budgets are what is left of the 60s function after openFDA's three
 * paged kinds, which run in parallel with these. */

async function fetchFsis(loc) {
  const { list, note, fetchedAt } = await feedWithFallback(
    FEED_BLOBS.fsis, () => fsisFetch({ attempts: 3, timeoutMs: 9000, budgetMs: 34000 }), slimFsis, "fsis");
  return { recalls: normalizeFsis(list, loc), note, fetchedAt };
}

async function fetchCpsc() {
  const { list, note, fetchedAt } = await feedWithFallback(
    FEED_BLOBS.cpsc, () => jfetch(cpscUrl(CPSC_LOOKBACK_DAYS), 34000), slimCpsc, "cpsc");
  return { recalls: normalizeCpsc(list), note, fetchedAt };
}

export default async function handler(req, res) {
  const state = String(req.query.state || "");
  const abbr = String(req.query.abbr || "");
  const scope = req.query.scope == null ? "" : String(req.query.scope);
  if ((state && !/^[A-Za-z ]{2,30}$/.test(state)) || (abbr && !/^[A-Za-z]{2}$/.test(abbr))) {
    return res.status(400).json({ error: "bad parameters" });
  }
  /* `scope=us` is the All US list: no state, no area filter. It is one URL
   * for everybody, so the CDN caches it once. A state alongside it is a
   * contradiction, not a hint. */
  if (scope && scope !== "us") return res.status(400).json({ error: "bad parameters" });
  const national = scope === "us";
  if (national && (state || abbr)) return res.status(400).json({ error: "scope=us takes no state" });
  const loc = national ? null : { state: state || null, stateAbbr: abbr ? abbr.toUpperCase() : null };
  /* Every record passes in the national list; the area list keeps its rule. */
  const keep = national ? () => true : (r) => isInArea(r, loc);

  const jobs = [
    { name: "FDA Food enforcement", fn: () => fetchFda("food", loc) },
    { name: "FDA Drug enforcement", fn: () => fetchFda("drug", loc) },
    { name: "FDA Device enforcement", fn: () => fetchFda("device", loc) },
    { name: "USDA FSIS (meat, poultry, egg)", fn: () => fetchFsis(loc) },
    { name: "CPSC consumer products", fn: () => fetchCpsc() },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.fn()));
  const recalls = [];
  const sources = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      // A job may return a plain array, or {recalls, note} when it served a
      // cached copy because the upstream feed was unreachable.
      /* The normalizers now keep every notice and label it — 'elsewhere' for
       * one naming only other states — so this response, which is the area
       * list, filters through isInArea before anything is counted. A source's
       * count keeps meaning "notices covering your area". */
      const v = Array.isArray(s.value) ? { recalls: s.value } : s.value;
      const list = v.recalls.filter(keep);
      recalls.push(...list);
      /* Freshness, per source (see freshnessOf in src/lib/search-index.js):
       *   fetchedAt   when this list was fetched upstream (a cached copy's
       *               own time, not now)
       *   lastUpdated FDA only: openFDA's meta.last_updated — the data's date
       *   newest      the newest recall date in the whole fetched list
       *   truncated   only the newest notices were fetched, back to `oldest` */
      const newest = v.recalls.reduce((m, r) => {
        const t = r.date ? new Date(r.date).getTime() : NaN;
        const d = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
        return d > m ? d : m;
      }, "");
      return {
        name: jobs[i].name, ok: true, count: list.length, note: v.note,
        fetchedAt: v.fetchedAt || null,
        ...(v.lastUpdated ? { lastUpdated: v.lastUpdated } : null),
        ...(newest ? { newest } : null),
        ...(v.truncated ? { truncated: true } : null),
        ...(v.oldest ? { oldest: v.oldest } : null),
      };
    }
    return { name: jobs[i].name, ok: false, error: s.reason && s.reason.message ? s.reason.message : "failed" };
  });

  sortRecalls(recalls); // Date objects serialize to ISO strings in the JSON below

  // Paging lifts the count into the hundreds; trim the long free-text fields
  // so the payload stays small enough to cache and parse quickly.
  const clip = (v, n) => (typeof v === "string" && v.length > n ? v.slice(0, n) + "…" : v);
  const slim = recalls.map((r) => ({
    ...r,
    reason: clip(r.reason, 300),
    distribution: clip(r.distribution, 200),
    codeInfo: clip(r.codeInfo, 400),
    product: clip(r.product, 300),
  }));

  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=86400");
  return res.status(200).json({ recalls: slim, sources, ...(national ? { scope: "us" } : null) });
}

export const config = { maxDuration: 60 };
