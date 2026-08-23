/* One-shot recall aggregator: fetches all five government feeds server-side
 * in parallel (openFDA with the API key from the `openfda` env var),
 * normalizes them with the same code the client uses, and returns one small
 * ready-to-render payload. Edge-cached per state for 15 minutes, so most
 * page loads never touch a government API at all.
 */
import {
  normalizeFda, normalizeFsis, normalizeCpsc, sortRecalls,
  slimFsis, slimCpsc, fdaSearchQuery, CPSC_LOOKBACK_DAYS,
} from "../src/lib/sources.js";
import { FEED_HEADERS, FEED_HEADERS_REFERER, FSIS_ENDPOINTS, fetchFirstOk } from "../src/lib/feeds.js";

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
  return normalizeFda(kind, results, loc);
}

async function fetchFsis(loc) {
  const { data } = await fetchFirstOk(FSIS_ENDPOINTS, [FEED_HEADERS, FEED_HEADERS_REFERER], 20000);
  return normalizeFsis(slimFsis(data), loc);
}

async function fetchCpsc() {
  const start = new Date(Date.now() - CPSC_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const raw = await jfetch(
    `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${start}`, 30000);
  return normalizeCpsc(slimCpsc(raw));
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
      recalls.push(...s.value);
      return { name: jobs[i].name, ok: true, count: s.value.length };
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
