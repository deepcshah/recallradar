/* Cron (see vercel.json): pull USDA FSIS and CPSC and write the results to
 * Blob, so the request path always has a recent copy to fall back to.
 *
 * This is the actual fix for "USDA data never shows". The endpoint was never
 * wrong — USDA's WAF refuses datacenter egress much of the time, and the app's
 * only chance of catching a window when it does not was a user happening to
 * load the page during one. Since the cached copy was written only on that
 * same lucky request, a deployment could run for weeks with the cache empty
 * and USDA showing "unavailable" every single time.
 *
 * Moving the fetch off the request path inverts that. The cron can afford to
 * be patient in a way a person waiting on a page cannot: it retries across
 * most of a minute, and one success a day is enough, because recall feeds
 * change a handful of times a day and a copy hours old is a perfectly good
 * answer. The user-facing request then reads a warm cache instead of gambling.
 *
 * It is also safe to hit by hand — GET /api/refresh-feeds — when CRON_SECRET
 * is unset, which is how you check whether the pipeline works at all.
 */
import { slimFsis, slimCpsc, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";
import { FEED_HEADERS, fsisFetch, cpscUrl } from "../src/lib/feeds.js";
import { FEED_BLOBS, blobConfigured, writeFeedCache, readFeedCache, staleness } from "../src/lib/feed-cache.js";

/* The whole point of running off the request path is that we can wait. FSIS
 * gets the larger share because it is the one that refuses us. */
const FSIS_BUDGET_MS = 34000;
const CPSC_TIMEOUT_MS = 45000;

async function jfetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: FEED_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

async function warm(name, path, load) {
  const started = Date.now();
  try {
    const list = load ? await load() : [];
    if (!list.length) throw new Error("upstream returned no notices");
    const stored = await writeFeedCache(path, list);
    return { name, ok: true, count: list.length, stored, ms: Date.now() - started };
  } catch (err) {
    const hit = await readFeedCache(path);
    return {
      name, ok: false, ms: Date.now() - started,
      error: String((err && err.message) || err).slice(0, 200),
      // The previous copy is untouched and still serving; say how old it is.
      keeping: hit ? `${hit.list.length} notices saved ${staleness(hit.uploadedAt)}` : "nothing cached yet",
    };
  }
}

export default async function handler(req, res) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var
  // is set; enforce it when configured so strangers can't drive refreshes.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!blobConfigured()) {
    // Not an error the cron can fix, but the single most likely reason a
    // source looks permanently unavailable in production.
    return res.status(503).json({
      error: "BLOB_READ_WRITE_TOKEN is not set, so there is nowhere to cache these feeds. " +
             "Add a Vercel Blob store to the project and redeploy.",
    });
  }

  // In parallel: sequential budgets would outlive the function.
  const results = await Promise.all([
    warm("USDA FSIS", FEED_BLOBS.fsis,
      async () => slimFsis(await fsisFetch({ attempts: 4, timeoutMs: 8000, budgetMs: FSIS_BUDGET_MS }))),
    warm("CPSC", FEED_BLOBS.cpsc,
      async () => slimCpsc(await jfetch(cpscUrl(CPSC_LOOKBACK_DAYS), CPSC_TIMEOUT_MS))),
  ]);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ refreshedAt: new Date().toISOString(), results });
}

export const config = { maxDuration: 60 };
