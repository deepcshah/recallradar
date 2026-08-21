/* Find nearby store locations for the retail chains named in active recalls.
 *
 * Primary path: same-origin serverless proxy (/api/stores) which queries the
 * Overpass mirrors server-side and is edge-cached by Vercel — this avoids
 * browser CORS issues and the aggressive per-IP rate limits on the public
 * mirrors. Fallback (e.g. running as a bare static site): query the mirrors
 * directly from the browser, racing them.
 */
import { distanceMiles } from "./geo.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_TTL_MS = 30 * 60 * 1000;

export function buildOverpassQuery(pattern, lat, lon, radiusMeters) {
  const around = `(around:${Math.round(radiusMeters)},${lat},${lon})`;
  // Name-only match on nodes and ways (no relations, no brand-only scans).
  return `
    [out:json][timeout:40];
    (
      node["shop"]["name"~"${pattern}",i]${around};
      way["shop"]["name"~"${pattern}",i]${around};
      node["amenity"="pharmacy"]["name"~"${pattern}",i]${around};
      way["amenity"="pharmacy"]["name"~"${pattern}",i]${around};
    );
    out center tags 120;
  `;
}

function fetchEndpoint(endpoint, query, signal) {
  return fetch(endpoint, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

/** Race the public Overpass mirrors; first success wins, losers are aborted. */
async function overpassDirect(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    return await Promise.any(ENDPOINTS.map((e) => fetchEndpoint(e, query, ctrl.signal)));
  } catch (_) {
    throw new Error(ctrl.signal.aborted
      ? "OpenStreetMap store search timed out — try again or use a smaller radius"
      : "OpenStreetMap store search is unavailable right now");
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function overpassViaProxy(pattern, lat, lon, radiusMeters) {
  const params = new URLSearchParams({
    lat: lat.toFixed(3),
    lon: lon.toFixed(3),
    radius: String(Math.round(radiusMeters)),
    pattern,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch(`/api/stores?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function findStores(chains, loc, radiusMeters) {
  if (!chains.length) return [];

  const cacheKey = "rr-stores:" + [
    loc.lat.toFixed(3), loc.lon.toFixed(3), Math.round(radiusMeters),
    chains.map((c) => c.id).sort().join(","),
  ].join("|");
  try {
    const hit = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  } catch (_) { /* cache is best-effort */ }

  const pattern = chains.map((c) => c.osm).join("|");
  let data;
  try {
    data = await overpassViaProxy(pattern, loc.lat, loc.lon, radiusMeters);
  } catch (_) {
    data = await overpassDirect(buildOverpassQuery(pattern, loc.lat, loc.lon, radiusMeters));
  }

  const seen = new Set();
  const stores = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const lat = el.lat ?? (el.center && el.center.lat);
    const lon = el.lon ?? (el.center && el.center.lon);
    if (lat == null || lon == null) continue;

    const name = tags.name || tags.brand || "Unnamed store";
    const hay = `${tags.name || ""} ${tags.brand || ""}`;
    const chainIds = chains
      .filter((c) => new RegExp(c.osm, "i").test(hay))
      .map((c) => c.id);
    if (!chainIds.length) continue;

    // Dedup same-name stores at nearly identical coordinates (node + way pairs).
    const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const address = [
      [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
      tags["addr:city"],
    ].filter(Boolean).join(", ");

    stores.push({
      name,
      brand: tags.brand || "",
      lat,
      lon,
      address,
      distanceMiles: distanceMiles(loc.lat, loc.lon, lat, lon),
      chainIds,
    });
  }

  stores.sort((a, b) => a.distanceMiles - b.distanceMiles);
  const result = stores.slice(0, 60);
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: result })); } catch (_) { /* quota */ }
  return result;
}
