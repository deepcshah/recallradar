/* Daily cron (see vercel.json): re-warm the oldest cached chain lookups so
 * the monthly refresh happens in the background instead of landing on a
 * user's request. Refreshes up to 8 entries per run, oldest first, only ones
 * older than 20 days — so any area someone has ever searched stays warm.
 */
import { list, put } from "@vercel/blob";
import { blobAuth, blobPutOptions } from "../src/lib/blob.js";
import { byId } from "../src/lib/retailers.js";
import { findChainLocations } from "../src/lib/mapbox-server.js";

const REFRESH_AFTER_MS = 20 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 8;
const KEY_RE = /^stores\/v2\/(-?\d+\.\d{2})_(-?\d+\.\d{2})\/([A-Za-z0-9_-]+)\.json$/;

export default async function handler(req, res) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var
  // is set; enforce it when configured so strangers can't drive refreshes.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) return res.status(503).json({ error: "MAPBOX_TOKEN is not configured" });

  let blobs;
  try {
    ({ blobs } = await list({ prefix: "stores/v2/", limit: 1000, ...blobAuth() }));
  } catch (err) {
    return res.status(500).json({ error: `blob list failed: ${err.message}` });
  }

  const now = Date.now();
  const stale = blobs
    .filter((b) => now - new Date(b.uploadedAt).getTime() > REFRESH_AFTER_MS)
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt))
    .slice(0, MAX_PER_RUN);

  const refreshed = [];
  const failed = [];
  for (const blob of stale) {
    const m = KEY_RE.exec(blob.pathname);
    if (!m) continue;
    const [, lat, lon, chainId] = m;
    const chain = byId(chainId);
    if (!chain) continue;
    try {
      const stores = await findChainLocations(token, chain, parseFloat(lat), parseFloat(lon));
      await put(blob.pathname,
        JSON.stringify({ fetchedAt: new Date(now).toISOString(), stores }),
        blobPutOptions());
      refreshed.push(blob.pathname);
    } catch (err) {
      failed.push(`${blob.pathname}: ${err.message}`); // old copy stays; retried tomorrow
    }
  }

  return res.status(200).json({ entries: blobs.length, stale: stale.length, refreshed, failed });
}

export const config = { maxDuration: 60 };
