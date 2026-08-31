/* Diagnostic probe: verifies the Mapbox token and the store pipeline end to
 * end, and reports exactly what Mapbox said. Visit
 *   /api/diag?lat=40.65&lon=-73.96
 * and read the JSON. Nothing here echoes the token — only whether it is
 * present, its public prefix, and the upstream status codes and messages.
 *
 * /api/diag?probe=feeds skips all of that and reports on the recall feeds
 * alone: what each one answered just now, whether a cached copy is standing in
 * for it, and whether Blob is configured to hold one. That is the probe the
 * app's own "Check the feeds" button calls.
 */
import { byId } from "../src/lib/retailers.js";
import { findChainLocations, searchUrl } from "../src/lib/mapbox-server.js";
import { FEED_HEADERS, FSIS_ENDPOINTS, DIAG_HEADER_SETS, cpscUrl } from "../src/lib/feeds.js";
import { fdaSearchQuery, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";
import { FEED_BLOBS, readFeedCache, staleness } from "../src/lib/feed-cache.js";
import { readFreshSnapshot } from "../src/lib/snapshot.js";
import { blobConfigured, blobTokenVar } from "../src/lib/blob.js";

const PROBE_CHAINS = ["cvs", "safeway", "walmart"];
const PROBE_TIMEOUT_MS = 8000;

/* Hit each recall feed exactly as api/recalls.js does and report the raw
 * outcome, so a WAF block (403) or a bad key is visible instead of just
 * showing up as a missing source in the UI. */
async function probeFeeds() {
  const key = process.env.openfda;
  const loc = { state: "California", stateAbbr: "CA" };
  const targets = [
    ["USDA FSIS", FSIS_ENDPOINTS[0]],
    ["CPSC", cpscUrl(CPSC_LOOKBACK_DAYS)],
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

/* Every FSIS endpoint x header variant, in parallel, so one request settles
 * the question the repository has answered two contradictory ways: is the 403
 * about the headers, or about the caller?
 *
 * Read it like an experiment, because that is what it is. If "browser-ua" or
 * "browser-full" comes back 200 and "honest" comes back 403, the header theory
 * holds and the request path is sending the wrong thing. If all four fail
 * identically — including "no-ua", the control — headers are irrelevant and
 * the decision is being made about the IP or the TLS handshake, which no
 * header can change. Anything else (mixed, or intermittent across repeats)
 * means it is rate limiting or load, not a policy about us at all.
 *
 * Run together deliberately: walking the combinations one at a time is what
 * timed this endpoint out and made it look broken. */
async function probeFsisMatrix() {
  const combos = FSIS_ENDPOINTS.flatMap((url) =>
    DIAG_HEADER_SETS.map(([label, headers]) => ({ url, label, headers })));

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
  /* /api/diag?probe=feeds checks every recall feed, live, plus the cache that
   * covers for them. This used to be FSIS-only, which is why "CPSC is missing
   * too" had nowhere to be answered from — the one button in the app tested a
   * single agency and reported on a single agency. */
  if (["feeds", "fsis"].includes(String(req.query.probe || ""))) {
    /* Both fallback tiers are read from here, not just Blob. The snapshot
     * committed by the GitHub Action is now served by the server as well as
     * the browser, so a diagnosis that only looked at Blob would report a
     * source as doomed while a perfectly good copy sat in the deployment. */
    const [feeds, matrix, fsisCache, cpscCache, fsisSnap, cpscSnap] = await Promise.all([
      probeFeeds(),
      probeFsisMatrix(),
      readFeedCache(FEED_BLOBS.fsis),
      readFeedCache(FEED_BLOBS.cpsc),
      readFreshSnapshot("fsis"),
      readFreshSnapshot("cpsc"),
    ]);

    const cacheFor = (name) => (name === "USDA FSIS" ? fsisCache : name === "CPSC" ? cpscCache : null);
    const snapFor = (name) => (name === "USDA FSIS" ? fsisSnap : name === "CPSC" ? cpscSnap : null);

    const rows = feeds.map((f) => {
      const cache = cacheFor(f.name);
      const snap = snapFor(f.name);
      return {
        url: f.name,
        headers: f.ok ? `${f.count ?? "?"} notices` : "live fetch failed",
        status: f.status ?? f.error,
        ok: f.ok,
        ms: f.ms,
        body: f.body,
        cached: cache ? `${cache.list.length} saved ${staleness(cache.uploadedAt)}` : undefined,
        snapshot: snap
          ? `${snap.list.length} committed ${staleness(snap.fetchedAt)} (read from ${snap.via})`
          : undefined,
      };
    });

    const down = feeds.filter((f) => !f.ok && f.status !== 404);
    const covered = down.filter((f) => cacheFor(f.name) || snapFor(f.name));

    /* The matrix's own conclusion, stated rather than left to be inferred from
     * four rows. This is the whole point of restoring it: the question "is it
     * the headers or the caller" has a different answer for each shape of
     * result, and reading it wrong is exactly how this repo ended up with two
     * commits asserting opposite causes. */
    const fsisVerdict = (() => {
      const rows = matrix.filter((r) => r.status != null || r.error);
      if (!rows.length) return null;
      const by = (label) => rows.find((r) => r.headers === label);
      const ladder = ["product", "default", "bare"].map(by).filter(Boolean);
      const passing = ladder.filter((r) => r.ok);
      const crawler = by("crawler-ua");
      const browser = by("browser-ua");

      if (passing.length) {
        const first = passing[0];
        const note = crawler && !crawler.ok
          ? " The old crawler-style User-Agent is still refused, which matches what a laptop " +
            "measured: it is the string, not the address."
          : "";
        return `USDA answered the "${first.headers}" rung of the identity ladder, which is what ` +
          `the request path sends first.${note} Nothing further is needed.`;
      }

      // Nothing truthful got through. Distinguish "our address" from "any client".
      if (browser && browser.ok) {
        return "Every honest identity was refused and only a spoofed browser User-Agent got " +
          "through. That is a finding, not a fix — impersonating a browser to a government API " +
          "is not something this app does. Use the committed snapshot in public/feeds/.";
      }
      const codes = [...new Set(rows.map((r) => r.status ?? r.error))];
      return `USDA refused all ${rows.length} variants` +
        (codes.length === 1 ? ` identically (${codes[0]})` : ` (${codes.join(", ")})`) +
        ". A bare request with no User-Agent at all was refused too, and that same request " +
        "succeeds from a laptop — so this is a second block on top of the User-Agent one, and " +
        "it is about this deployment's address. No header can fix it; the committed snapshot can.";
    })();

    const names = down.map((f) => f.name).join(" and ");
    const blobNote = blobConfigured()
      ? ""
      : " No Vercel Blob token is set in this environment, so the Blob tier is doing nothing at " +
        "all here — expected RR_BLOB_READ_WRITE_TOKEN (this project's store uses the RR_BLOB_ " +
        "prefix) or a plain BLOB_READ_WRITE_TOKEN.";

    let verdict;
    if (!down.length) {
      verdict = "Every feed answered live. Nothing is being served from cache." + blobNote;
    } else if (covered.length === down.length) {
      /* Which tier answered matters: Blob means this deployment reached the
       * agency at some point, the snapshot means it never had to. */
      const how = down
        .map((f) => `${f.name} from ${cacheFor(f.name) ? "the Blob cache" : "the committed snapshot"}`)
        .join(", ");
      verdict = `${names} refused us just now, but a stored copy is being served instead — ${how}.` + blobNote;
    } else {
      const stranded = down.filter((f) => !cacheFor(f.name) && !snapFor(f.name)).map((f) => f.name);
      verdict = `${names} refused us, and ${stranded.join(" and ")} has no usable stored copy ` +
        "at either tier, so it will show as unavailable. Run /api/refresh-feeds to try warming " +
        "the cache, and check that the Refresh recall feeds GitHub Action is green — the " +
        "snapshot it commits is the tier that does not need USDA to answer this deployment." +
        blobNote;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      blobConfigured: blobConfigured(),
      blobTokenVar: blobTokenVar(),
      verdict,
      fsisVerdict,
      rows,
      fsisMatrix: matrix,
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
    blobConfigured: blobConfigured(),
    blobTokenVar: blobTokenVar(),
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
