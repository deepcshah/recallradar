/* Daily cron (see vercel.json): re-warm the oldest store tiles in Blob so
 * the monthly refresh happens in the background instead of landing on a
 * user's request. Refreshes up to 3 tiles per run, oldest first, only ones
 * older than 20 days — a tile therefore stays perpetually fresh once any
 * user has ever searched its area.
 */
import { list, put } from "@vercel/blob";
import { buildTileQuery, raceMirrors, slimElements } from "../src/lib/overpass-server.js";

const REFRESH_AFTER_MS = 20 * 24 * 60 * 60 * 1000;
const MAX_TILES_PER_RUN = 3;
const KEY_RE = /^stores\/v1\/(-?\d+\.\d{2})_(-?\d+\.\d{2})_(\d+)\.json$/;

export default async function handler(req, res) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var
  // is set; enforce it when configured so strangers can't drive refreshes.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let blobs;
  try {
    ({ blobs } = await list({ prefix: "stores/v1/", limit: 1000 }));
  } catch (err) {
    return res.status(500).json({ error: `blob list failed: ${err.message}` });
  }

  const now = Date.now();
  const stale = blobs
    .filter((b) => now - new Date(b.uploadedAt).getTime() > REFRESH_AFTER_MS)
    .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt))
    .slice(0, MAX_TILES_PER_RUN);

  const refreshed = [];
  const failed = [];
  for (const blob of stale) {
    const m = KEY_RE.exec(blob.pathname);
    if (!m) continue;
    const [, lat, lon, radius] = m;
    try {
      const data = await raceMirrors(buildTileQuery(lat, lon, radius), 15000);
      await put(blob.pathname, JSON.stringify(slimElements(data)), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 3600,
      });
      refreshed.push(blob.pathname);
    } catch (err) {
      failed.push(`${blob.pathname}: ${err.message}`); // old copy stays; retried tomorrow
    }
  }

  return res.status(200).json({ tiles: blobs.length, stale: stale.length, refreshed, failed });
}

export const config = { maxDuration: 60 };
