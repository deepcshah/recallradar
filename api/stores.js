/* Store-location lookup, backed by Mapbox Search and cached in Vercel Blob.
 *
 * The Mapbox token (env var MAPBOX_TOKEN) is read here and never leaves the
 * server. Results are cached per (neighborhood, chain) so a given chain in a
 * given area costs exactly one Mapbox request per month, shared by everyone:
 *
 *   key: stores/v2/{lat2}_{lon2}/{chainId}.json      (lat2/lon2 = 2 decimals)
 *
 * A chain that fails degrades on its own — the rest of the lookup still
 * returns — and a stale cached copy always beats an error.
 */
import { head, put } from "@vercel/blob";
import { byId } from "../src/lib/retailers.js";
import { findChainLocations, pooled } from "../src/lib/mapbox-server.js";

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // refresh a chain's tile monthly
const MAX_CHAINS = 24;

export function tileKey(lat, lon, chainId) {
  return `stores/v2/${lat.toFixed(2)}_${lon.toFixed(2)}/${chainId}.json`;
}

async function readBlob(key) {
  try {
    const meta = await head(key); // throws BlobNotFoundError when missing
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    return { body: await res.json(), uploadedAt: new Date(meta.uploadedAt).getTime() };
  } catch (_) {
    return null; // missing, or Blob not configured — fall through to Mapbox
  }
}

async function writeBlob(key, body) {
  try {
    await put(key, JSON.stringify(body), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 3600,
    });
  } catch (_) { /* best-effort; the response still succeeds */ }
}

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const ids = String(req.query.chains || "")
    .split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_CHAINS);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: "bad coordinates" });
  }
  const chains = ids.map(byId).filter(Boolean);
  if (!chains.length) return res.status(400).json({ error: "no valid chains requested" });

  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    return res.status(503).json({
      error: "Mapbox is not configured on the server (missing MAPBOX_TOKEN environment variable).",
    });
  }

  const now = Date.now();
  const settled = await pooled(chains, async (chain) => {
    const key = tileKey(lat, lon, chain.id);
    const cached = await readBlob(key);
    if (cached && now - cached.uploadedAt < STALE_MS) {
      return { stores: cached.body.stores || [], source: "blob" };
    }
    try {
      const stores = await findChainLocations(token, chain, lat, lon);
      await writeBlob(key, { fetchedAt: new Date(now).toISOString(), stores });
      return { stores, source: "mapbox" };
    } catch (err) {
      if (cached) return { stores: cached.body.stores || [], source: "blob-stale" };
      throw err;
    }
  });

  const stores = [];
  const perChain = {};
  let failures = 0;
  settled.forEach((r, i) => {
    const id = chains[i].id;
    if (r.ok) {
      stores.push(...r.value.stores);
      perChain[id] = { ok: true, count: r.value.stores.length, source: r.value.source };
    } else {
      failures++;
      perChain[id] = { ok: false, error: r.error };
    }
  });

  // Every chain failing means the token or the API is broken, not the data.
  if (failures === chains.length) {
    const sample = Object.values(perChain).find((c) => c.error);
    return res.status(502).json({
      error: `Mapbox lookup failed for all ${chains.length} chains — ${sample ? sample.error : "unknown error"}`,
      chains: perChain,
    });
  }

  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  return res.status(200).json({ stores, chains: perChain });
}

export const config = { maxDuration: 60 };
