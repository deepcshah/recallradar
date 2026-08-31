/* The committed feed snapshot, read from the server.
 *
 * `public/feeds/*.json` is written by a GitHub runner (see
 * scripts/refresh-feeds.mjs) and committed, so it ships inside the deployment.
 * The browser has always been able to read it — it is a static asset on the
 * CDN — but the server could not, and that gap is why USDA could still come
 * back empty on a run where the Action had succeeded hours earlier:
 *
 *   /api/recalls asks USDA        -> 403, this deployment's egress is refused
 *   /api/recalls asks Blob        -> cold, or no token attached at all
 *   /api/recalls gives up         -> "USDA FSIS: unavailable"
 *   the browser then recovers it  -> a second round trip, and only if the
 *                                    client-side fallback path is reached
 *
 * The data was sitting in the same deployment the whole time. This module is
 * the server reading its own copy, which makes the runner's fetch the thing it
 * was always meant to be: the tier that works when nothing else does, in every
 * environment rather than only in the browser.
 *
 * Node-only — it touches `node:fs`. Import it from `api/` and from
 * `src/lib/feed-cache.js` (which is itself server-only); never from anything
 * the Vite client build can reach.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/feeds");

/* Past this the honest answer is "unavailable", not a month-old list. Matches
 * MAX_STALE_MS in feed-cache.js — the two tiers age out on the same terms. */
export const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/* Two ways in, because each one fails in a way the other survives.
 *
 * Disk is the real path and needs no network, but a serverless bundler only
 * ships files it knows about — hence `functions.includeFiles` in vercel.json.
 * If that config is ever dropped or silently stops matching, the fetch below
 * reads the same file off this deployment's own CDN, where it certainly is,
 * because that is how the browser has always read it. Belt and braces on the
 * one tier whose entire job is to still be there. */
async function fromDisk(name) {
  return JSON.parse(await readFile(resolve(FEED_DIR, `${name}.json`), "utf8"));
}

async function fromOwnCdn(name) {
  // The immutable per-deployment host, not a project alias: it always resolves
  // to *this* build, which is the build whose snapshot we want.
  const host = process.env.VERCEL_URL;
  if (!host) throw new Error("not on Vercel (no VERCEL_URL)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://${host}/feeds/${name}.json`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

/** The committed snapshot for one feed.
 *  @returns {Promise<{list: any[], fetchedAt: number, via: string}|null>}
 *           null when there is no readable, non-empty, in-date copy — which
 *           includes the normal state before the workflow has ever run.
 */
export async function readSnapshot(name) {
  const tried = [];
  for (const [via, load] of [["disk", fromDisk], ["cdn", fromOwnCdn]]) {
    let snap;
    try {
      snap = await load(name);
    } catch (err) {
      tried.push(`${via}: ${String((err && err.message) || err)}`);
      continue;
    }
    if (!snap || !Array.isArray(snap.notices) || !snap.notices.length) {
      tried.push(`${via}: no notices in the file`);
      continue;
    }
    const fetchedAt = new Date(snap.fetchedAt).getTime();
    if (!Number.isFinite(fetchedAt)) {
      tried.push(`${via}: unreadable fetchedAt`);
      continue;
    }
    return { list: snap.notices, fetchedAt, via, tried };
  }
  return null;
}

/** Same shape as readSnapshot, but refuses anything past SNAPSHOT_MAX_AGE_MS. */
export async function readFreshSnapshot(name) {
  const snap = await readSnapshot(name);
  if (!snap) return null;
  return Date.now() - snap.fetchedAt > SNAPSHOT_MAX_AGE_MS ? null : snap;
}
