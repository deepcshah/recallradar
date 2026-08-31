/* CPSC recall feed proxy, for the browser fallback path.
 *
 * saferproducts.gov serves the whole window as one large uncompressed
 * document and is regularly slower than a page load will wait for, so this
 * slims it, caches every success, and falls back to the last good copy.
 */
import { FEED_HEADERS, cpscUrl } from "../src/lib/feeds.js";
import { slimCpsc, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";
import { FEED_BLOBS, feedWithFallback } from "../src/lib/feed-cache.js";

async function fetchCpsc() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const upstream = await fetch(cpscUrl(CPSC_LOOKBACK_DAYS), {
      headers: FEED_HEADERS, signal: ctrl.signal,
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    return await upstream.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  try {
    const { list, note } = await feedWithFallback(FEED_BLOBS.cpsc, fetchCpsc, slimCpsc);
    if (note) res.setHeader("X-Feed-Note", note.replace(/[^\x20-\x7E]/g, " "));
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json(list);
  } catch (err) {
    return res.status(502).json({ error: `CPSC unavailable: ${String(err.message || err).slice(0, 200)}` });
  }
}

export const config = { maxDuration: 30 };
