/* USDA FSIS recall feed proxy, for the browser fallback path.
 *
 * Fetches server-side (which sidesteps CORS), retries the WAF a few times,
 * slims to the fields the app uses, and falls back to the cached copy rather
 * than returning nothing. Vercel edge-caches the slim result for 30 minutes.
 */
import { fsisFetch } from "../src/lib/feeds.js";
import { slimFsis } from "../src/lib/sources.js";
import { FEED_BLOBS, feedWithFallback } from "../src/lib/feed-cache.js";

export default async function handler(req, res) {
  try {
    const { list, note } = await feedWithFallback(
      FEED_BLOBS.fsis, () => fsisFetch({ attempts: 3, timeoutMs: 9000, budgetMs: 25000 }), slimFsis, "fsis");
    // The note rides along in a header: the body's shape is a plain array and
    // several callers depend on that.
    if (note) res.setHeader("X-Feed-Note", note.replace(/[^\x20-\x7E]/g, " "));
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json(list);
  } catch (err) {
    return res.status(502).json({ error: `FSIS unavailable: ${String(err.message || err).slice(0, 200)}` });
  }
}

export const config = { maxDuration: 30 };
