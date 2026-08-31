/* Last-good copies of the government feeds, in Vercel Blob.
 *
 * Two of the three agencies are unreliable in ways that have nothing to do
 * with this app:
 *
 *   USDA FSIS sits behind a WAF that scores datacenter egress and TLS
 *   fingerprints, and answers a Node fetch from a serverless function with a
 *   403 much of the time. The endpoint is correct and documented; the caller
 *   is what it objects to.
 *
 *   CPSC's saferproducts.gov returns the last 180 days as one large,
 *   uncompressed JSON document and regularly takes longer than the request
 *   budget to produce it.
 *
 * Either way, the failure is transient and the data is nearly static — recall
 * feeds change a handful of times a day. So every successful fetch is written
 * here, and a failed one falls back to the last copy with an explicit "as of"
 * note. A day-old list of meat recalls is worth immeasurably more than an
 * empty section labelled "unavailable", which is what the app showed before
 * and what made USDA look permanently missing.
 *
 * Blob is optional. Where no store is attached every function here fails
 * quietly and the app behaves exactly as it did before — which is worth
 * knowing when a source looks permanently down, so /api/diag reports whether
 * it is configured, and under which environment variable. See src/lib/blob.js:
 * the token is read from a prefixed name the SDK does not look for on its own.
 */
import { head, put } from "@vercel/blob";
import { blobAuth, blobPutOptions, blobConfigured } from "./blob.js";

export const FEED_BLOBS = {
  fsis: "feeds/fsis-v1.json",
  cpsc: "feeds/cpsc-v1.json",
};

/** How stale a cached feed may get before it stops being served at all.
 *  Past this the honest answer is "unavailable", not a month-old list. */
export const MAX_STALE_MS = 14 * 24 * 60 * 60 * 1000;

export { blobConfigured };

/** @returns {Promise<{list: any[], uploadedAt: number}|null>} */
export async function readFeedCache(path) {
  try {
    const meta = await head(path, blobAuth());
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    return { list, uploadedAt: new Date(meta.uploadedAt).getTime() };
  } catch (_) {
    return null; // never written, or Blob isn't configured here
  }
}

/** Best effort by design: a cache write must never fail a live answer. */
export async function writeFeedCache(path, list) {
  if (!Array.isArray(list) || !list.length) return false; // never cache an empty feed over a good one
  try {
    await put(path, JSON.stringify(list), blobPutOptions());
    return true;
  } catch (_) {
    return false;
  }
}

/** How old a cached copy is, in words a person can read on a card. */
export function staleness(uploadedAt) {
  const hours = Math.floor((Date.now() - uploadedAt) / 3600000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Serve a feed, preferring live and falling back to the last good copy.
 *
 *  @param path      Blob key for this feed.
 *  @param fetchLive async () => raw upstream payload
 *  @param slim      raw payload -> the small array we cache and normalize
 *  @returns {Promise<{list: any[], note?: string, cached: boolean}>}
 */
export async function feedWithFallback(path, fetchLive, slim) {
  try {
    const list = slim(await fetchLive());
    await writeFeedCache(path, list);
    return { list, cached: false };
  } catch (err) {
    const hit = await readFeedCache(path);
    if (!hit || Date.now() - hit.uploadedAt > MAX_STALE_MS) throw err;
    return {
      list: hit.list,
      cached: true,
      note: `Live fetch failed (${String(err.message || err).slice(0, 90)}) — showing the copy saved ${staleness(hit.uploadedAt)}.`,
    };
  }
}
