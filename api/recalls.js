/* One-shot recall aggregator: fetches all five government feeds server-side
 * in parallel (openFDA with the API key from the `openfda` env var),
 * normalizes them with the same code the client uses, and returns one small
 * ready-to-render payload. Edge-cached per state for 15 minutes, so most
 * page loads never touch a government API at all.
 */
import {
  normalizeFda, normalizeFsis, normalizeCpsc, sortRecalls,
  slimFsis, slimCpsc, fdaSearchQuery, unscopedSearchQuery, CPSC_LOOKBACK_DAYS,
} from "../src/lib/sources.js";
import { FEED_HEADERS, fsisFetch, cpscUrl } from "../src/lib/feeds.js";
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
const FDA_MAX_PAGES = 3;   // 300 per kind is plenty and keeps the payload sane

/* openFDA caps a response at 100 records, so a single call silently truncates
 * to the newest 100 and hides everything else. Page with `skip` until a short
 * page comes back. */
async function fetchFda(kind, loc) {
  const key = process.env.openfda;
  const base =
    `https://api.fda.gov/${kind}/enforcement.json?search=${fdaSearchQuery(loc).replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=${FDA_PAGE}` + (key ? `&api_key=${key}` : "");

  const results = [];
  for (let page = 0; page < FDA_MAX_PAGES; page++) {
    let data;
    try {
      data = await jfetch(page === 0 ? base : `${base}&skip=${page * FDA_PAGE}`);
    } catch (err) {
      if (err.status === 404) break; // openFDA's "no (more) matches"
      if (page > 0) break;           // keep whatever earlier pages returned
      throw err;
    }
    const batch = (data && data.results) || [];
    results.push(...batch);
    if (batch.length < FDA_PAGE) break;
  }

  /* One more page, with no distribution clause at all.
   *
   * The query above can only match text that names your state or says
   * nationwide, so a notice whose distribution reads "Sold at Trader Joe's
   * stores" — a chain and no geography — is invisible to it. That is exactly
   * the class this app exists to surface. openFDA has no way to ask for
   * "names no state", so the filtering happens in normalizeFda: everything
   * here that names a state other than yours is dropped, and what is left
   * has to name a retailer to survive.
   *
   * Deliberately one page, and deliberately best-effort: it is a widening,
   * not a correctness requirement, and it must never fail the whole fetch. */
  try {
    const loose = await jfetch(
      `https://api.fda.gov/${kind}/enforcement.json?search=${unscopedSearchQuery().replace(/ /g, "+")}` +
      `&sort=report_date:desc&limit=${FDA_PAGE}` + (key ? `&api_key=${key}` : ""));
    results.push(...((loose && loose.results) || []));
  } catch (_) { /* the state-scoped pages above still stand on their own */ }

  // Both passes can return the same notice; normalizeFda's ids are stable.
  const seen = new Set();
  return normalizeFda(kind, results, loc).filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/* Both of these go through the same shape: try live, cache every success,
 * and fall back to the last good copy rather than dropping a whole agency out
 * of the answer. See src/lib/feed-cache.js for why each one needs it.
 *
 * The budgets are what is left of the 60s function after openFDA's three
 * paged kinds, which run in parallel with these. */

async function fetchFsis(loc) {
  const { list, note } = await feedWithFallback(
    FEED_BLOBS.fsis, () => fsisFetch({ attempts: 3, timeoutMs: 9000, budgetMs: 34000 }), slimFsis);
  return { recalls: normalizeFsis(list, loc), note };
}

async function fetchCpsc() {
  const { list, note } = await feedWithFallback(
    FEED_BLOBS.cpsc, () => jfetch(cpscUrl(CPSC_LOOKBACK_DAYS), 34000), slimCpsc);
  return { recalls: normalizeCpsc(list), note };
}

export default async function handler(req, res) {
  const state = String(req.query.state || "");
  const abbr = String(req.query.abbr || "");
  if ((state && !/^[A-Za-z ]{2,30}$/.test(state)) || (abbr && !/^[A-Za-z]{2}$/.test(abbr))) {
    return res.status(400).json({ error: "bad parameters" });
  }
  const loc = { state: state || null, stateAbbr: abbr ? abbr.toUpperCase() : null };

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
      const list = Array.isArray(s.value) ? s.value : s.value.recalls;
      const note = Array.isArray(s.value) ? undefined : s.value.note;
      recalls.push(...list);
      return { name: jobs[i].name, ok: true, count: list.length, note };
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
  return res.status(200).json({ recalls: slim, sources });
}

export const config = { maxDuration: 60 };
