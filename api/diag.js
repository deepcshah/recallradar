/* Diagnostic probe: verifies the Mapbox token and the store pipeline end to
 * end, and reports exactly what Mapbox said. Visit
 *   /api/diag?lat=40.65&lon=-73.96
 * and read the JSON. Nothing here echoes the token — only whether it is
 * present, its public prefix, and the upstream status codes and messages.
 */
import { byId } from "../src/lib/retailers.js";
import { findChainLocations, searchUrl } from "../src/lib/mapbox-server.js";
import { FEED_HEADERS, FSIS_ENDPOINTS, FSIS_HEADER_SETS } from "../src/lib/feeds.js";
import { fdaSearchQuery, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";

const PROBE_CHAINS = ["cvs", "safeway", "walmart"];
const PROBE_TIMEOUT_MS = 8000;

/* Hit each recall feed exactly as api/recalls.js does and report the raw
 * outcome, so a WAF block (403) or a bad key is visible instead of just
 * showing up as a missing source in the UI. */
async function probeFeeds() {
  const key = process.env.openfda;
  const cpscStart = new Date(Date.now() - CPSC_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const loc = { state: "California", stateAbbr: "CA" };
  const targets = [
    ["USDA FSIS", "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json"],
    ["CPSC", `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${cpscStart}`],
    ["openFDA food", `https://api.fda.gov/food/enforcement.json?search=${fdaSearchQuery(loc).replace(/ /g, "+")}` +
      `&limit=1` + (key ? `&api_key=${key}` : "")],
  ];

  // In parallel: three sequential 12s timeouts could outlive the function.
  return Promise.all(targets.map(async ([name, url]) => {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: FEED_HEADERS, signal: ctrl.signal });
      const text = await res.text();
      let count = null;
      try {
        const j = JSON.parse(text);
        count = Array.isArray(j) ? j.length : Array.isArray(j.results) ? j.results.length : null;
      } catch (_) { /* not JSON */ }
      return {
        name, status: res.status, ok: res.ok, ms: Date.now() - started, count,
        // openFDA answers "no matches" with 404; that is not a failure.
        note: res.status === 404 ? "no matches (normal for openFDA)" : undefined,
        body: res.ok ? undefined : text.slice(0, 200),
      };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - started,
               error: err.name === "AbortError" ? "timed out" : err.message };
    } finally {
      clearTimeout(timer);
    }
  }));
}

/* Every FSIS endpoint x header combination, so a persistent 403 tells us
 * which variant (if any) the WAF will accept. Run together: walking nine
 * combinations one at a time timed the whole function out, which is why this
 * endpoint appeared to be broken. */
async function probeFsisMatrix() {
  const combos = FSIS_ENDPOINTS.flatMap((url) =>
    FSIS_HEADER_SETS.map(([label, headers]) => ({ url, label, headers })));

  return Promise.all(combos.map(async ({ url, label, headers }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      const text = await res.text();
      let count = null;
      try { const j = JSON.parse(text); count = Array.isArray(j) ? j.length : null; } catch (_) { /* html */ }
      return {
        url, headers: label, status: res.status, ok: res.ok, ms: Date.now() - started, count,
        server: res.headers.get("server") || undefined,
        body: res.ok ? undefined : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220),
      };
    } catch (err) {
      return { url, headers: label, ok: false, ms: Date.now() - started,
               error: err.name === "AbortError" ? "timed out" : err.message };
    } finally {
      clearTimeout(timer);
    }
  }));
}

export default async function handler(req, res) {
  // /api/diag?probe=fsis runs just the FSIS matrix and returns early.
  if (String(req.query.probe || "") === "fsis") {
    const matrix = await probeFsisMatrix();
    const win = matrix.find((r) => r.ok && r.count);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      verdict: win
        ? `FSIS works via ${win.url} (${win.headers} headers), ${win.count} notices.`
        : "No FSIS endpoint answered with JSON — see rows[].status and rows[].body.",
      rows: matrix,
    });
  }

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "pass ?lat=<number>&lon=<number>" });
  }

  const token = process.env.MAPBOX_TOKEN;
  const report = {
    checkedAt: new Date().toISOString(),
    at: { lat, lon },
    token: {
      present: Boolean(token),
      // A public token starts "pk."; a secret one starts "sk." and should NOT be used here.
      kind: token ? String(token).slice(0, 3) : null,
      looksPublic: Boolean(token && String(token).startsWith("pk.")),
    },
    openFdaKey: {
      // Read from the env var literally named "openfda".
      present: Boolean(process.env.openfda),
      length: process.env.openfda ? String(process.env.openfda).length : 0,
    },
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    feeds: await probeFeeds(),
    probes: [],
  };

  if (!token) {
    report.verdict = "MAPBOX_TOKEN is not set in this environment. Add it in Vercel " +
      "project settings and redeploy.";
    return res.status(200).json(report);
  }

  // Show the request shape with the token redacted, so a bad URL is visible.
  report.sampleRequest = searchUrl("REDACTED", "CVS", lat, lon).replace(/access_token=[^&]*/, "access_token=REDACTED");

  for (const id of PROBE_CHAINS) {
    const chain = byId(id);
    if (!chain) continue;
    const started = Date.now();
    try {
      const stores = await findChainLocations(token, chain, lat, lon);
      report.probes.push({
        chain: chain.label,
        ok: true,
        found: stores.length,
        ms: Date.now() - started,
        sample: stores.slice(0, 3).map((s) => ({ name: s.name, address: s.address })),
      });
    } catch (err) {
      report.probes.push({
        chain: chain.label,
        ok: false,
        ms: Date.now() - started,
        error: err && err.message ? err.message : "failed",
      });
    }
  }

  const good = report.probes.filter((p) => p.ok).length;
  report.verdict = good === 0
    ? "Every Mapbox probe failed — see probes[].error for the upstream message."
    : `${good}/${report.probes.length} probes succeeded; the store pipeline is working.`;

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(report);
}

export const config = { maxDuration: 30 };
