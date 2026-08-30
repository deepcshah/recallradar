/* Find nearby stores: the chains named in active recalls, the standing set of
 * grocery/pharmacy/big-box chains, and — via a POI category sweep — the
 * independent groceries, bodegas, co-ops and markets that no chain list can
 * name.
 *
 * All POI lookups go through /api/stores, which queries Mapbox Search with a
 * server-side token and caches results in Vercel Blob. There is deliberately
 * no direct browser fallback: the token must not ship to the client, and the
 * public keyless alternatives we used before proved unreliable.
 */
import { distanceMiles } from "./geo.js";
import { chainForName } from "./retailers.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_STORES = 80;

/** Categories to sweep alongside the chain list. Must match STORE_CATEGORIES
 *  in src/lib/mapbox-server.js — the server ignores anything it doesn't know. */
export const STORE_CATEGORY_IDS = ["grocery", "farmers_market"];

async function fetchStores(chains, cats, loc) {
  // Snap the center to a ~0.7 mi grid so everyone in the same neighborhood
  // shares one cached result per chain.
  const params = new URLSearchParams({
    lat: (Math.round(loc.lat * 100) / 100).toFixed(2),
    lon: (Math.round(loc.lon * 100) / 100).toFixed(2),
    chains: chains.map((c) => c.id).join(","),
    cats: cats.join(","),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch(`/api/stores?${params}`, { signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok) {
      throw new Error((body && body.error) || `store service returned HTTP ${res.status}`);
    }
    return body;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("the store search timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* Chain search and category search return the same storefront under slightly
 * different names ("Safeway", "Safeway #1234"), so match on the chain when we
 * know it and on the trimmed name when we don't. */
function dedupKey(name, chain, lat, lon) {
  const who = chain ? chain.id : name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${who}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
}

export async function findStores(chains, loc, radiusMeters, cats = STORE_CATEGORY_IDS) {
  if (!chains.length && !cats.length) return [];

  const cacheKey = "rr-stores:v3:" + [
    loc.lat.toFixed(3), loc.lon.toFixed(3), Math.round(radiusMeters),
    chains.map((c) => c.id).sort().join(","), cats.join(","),
  ].join("|");
  try {
    const hit = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  } catch (_) { /* cache is best-effort */ }

  const data = await fetchStores(chains, cats, loc);

  const merged = new Map();
  for (const s of (data && data.stores) || []) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !s.name) continue;

    let chain;
    if (s.chainId) {
      // Mapbox proximity search is fuzzy — keep only results whose name really
      // is the chain we asked for, using the chain's own matching regex.
      chain = chains.find((c) => c.id === s.chainId);
      if (!chain || !new RegExp(chain.osm, "i").test(s.name)) continue;
    } else {
      // A category hit: it may still be a chain we know, just found the other way.
      chain = chainForName(s.name);
    }

    const key = dedupKey(s.name, chain, lat, lon);
    const existing = merged.get(key);
    if (existing) {
      if (chain && !existing.chainIds.includes(chain.id)) existing.chainIds.push(chain.id);
      if (!existing.address && s.address) existing.address = s.address;
      continue;
    }
    merged.set(key, {
      name: s.name,
      brand: chain ? chain.label : "",
      lat,
      lon,
      address: s.address || "",
      distanceMiles: distanceMiles(loc.lat, loc.lon, lat, lon),
      chainIds: chain ? [chain.id] : [],
      // No recall notice will ever name this storefront by name, so the app
      // has to say something different about it than it does about a chain.
      independent: !chain,
    });
  }

  // The cached search covers a wider area than any single radius choice —
  // trim to what the user actually asked for.
  const maxMiles = radiusMeters / 1609.34 + 0.5;
  const result = [...merged.values()]
    .filter((s) => s.distanceMiles <= maxMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, MAX_STORES);
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: result })); } catch (_) { /* quota */ }
  return result;
}
