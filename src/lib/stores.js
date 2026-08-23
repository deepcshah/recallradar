/* Find nearby store locations for the retail chains named in active recalls.
 *
 * All POI lookups go through /api/stores, which queries Mapbox Search with a
 * server-side token and caches results in Vercel Blob. There is deliberately
 * no direct browser fallback: the token must not ship to the client, and the
 * public keyless alternatives we used before proved unreliable.
 */
import { distanceMiles } from "./geo.js";

const CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchStores(chains, loc) {
  // Snap the center to a ~0.7 mi grid so everyone in the same neighborhood
  // shares one cached result per chain.
  const params = new URLSearchParams({
    lat: (Math.round(loc.lat * 100) / 100).toFixed(2),
    lon: (Math.round(loc.lon * 100) / 100).toFixed(2),
    chains: chains.map((c) => c.id).join(","),
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

export async function findStores(chains, loc, radiusMeters) {
  if (!chains.length) return [];

  const cacheKey = "rr-stores:v2:" + [
    loc.lat.toFixed(3), loc.lon.toFixed(3), Math.round(radiusMeters),
    chains.map((c) => c.id).sort().join(","),
  ].join("|");
  try {
    const hit = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  } catch (_) { /* cache is best-effort */ }

  const data = await fetchStores(chains, loc);

  const seen = new Set();
  const stores = [];
  for (const s of (data && data.stores) || []) {
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !s.name) continue;

    // Mapbox proximity search is fuzzy — keep only results whose name really
    // is the chain we asked for, using the chain's own matching regex.
    const chain = chains.find((c) => c.id === s.chainId);
    if (!chain || !new RegExp(chain.osm, "i").test(s.name)) continue;

    // Dedup the same storefront returned at nearly identical coordinates.
    const key = `${s.name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    stores.push({
      name: s.name,
      brand: "",
      lat,
      lon,
      address: s.address || "",
      distanceMiles: distanceMiles(loc.lat, loc.lon, lat, lon),
      chainIds: [s.chainId],
    });
  }

  // The cached search covers a wider area than any single radius choice —
  // trim to what the user actually asked for.
  const maxMiles = radiusMeters / 1609.34 + 0.5;
  stores.sort((a, b) => a.distanceMiles - b.distanceMiles);
  const result = stores.filter((s) => s.distanceMiles <= maxMiles).slice(0, 60);
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: result })); } catch (_) { /* quota */ }
  return result;
}
