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

async function jfetch(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "RecallRadar/1.0" },
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return await res.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFda(kind, loc) {
  const key = process.env.openfda;
  const url =
    `https://api.fda.gov/${kind}/enforcement.json?search=${fdaSearchQuery(loc).replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=100` + (key ? `&api_key=${key}` : "");
  try {
    const data = await jfetch(url);
    return normalizeFda(kind, data.results || [], loc);
  } catch (err) {
    if (err.status === 404) return []; // openFDA's "no matches"
    throw err;
  }
}

async function fetchFsis(loc) {
  const raw = await jfetch("https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json", 30000);
  return normalizeFsis(slimFsis(raw), loc);
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
  res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=86400");
  return res.status(200).json({ recalls, sources });
}

export const config = { maxDuration: 60 };
