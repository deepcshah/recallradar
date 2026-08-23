/* Mapbox Search helpers. Server-side ONLY — the access token lives in the
 * MAPBOX_TOKEN environment variable and must never reach the browser.
 *
 * Two kinds of lookup, both one cheap request per neighborhood cached for a
 * month: by chain ("where are the nearest Safeways?"), which is what recall
 * notices name, and by POI category ("every grocery store around here"),
 * which is the only way independents show up at all.
 */

const SEARCHBOX = "https://api.mapbox.com/search/searchbox/v1/forward";
const CATEGORY = "https://api.mapbox.com/search/searchbox/v1/category";
const GEOCODE_V6 = "https://api.mapbox.com/search/geocode/v6/forward";

/** Fixed cache radius: results are stored per neighborhood regardless of the
 *  radius the user picked, then trimmed to their choice client-side. */
export const CACHE_RADIUS_M = 40000;

export function bboxAround(lat, lon, radiusM = CACHE_RADIUS_M) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return [
    clamp(lon - dLon, -180, 180), clamp(lat - dLat, -90, 90),
    clamp(lon + dLon, -180, 180), clamp(lat + dLat, -90, 90),
  ].map((n) => n.toFixed(5)).join(",");
}

/* Both Search Box forward and Geocoding v6 return GeoJSON FeatureCollections
 * with the fields we need in the same places, so one parser covers both and
 * we can fall back between them without a second code path. */
function parseFeatures(data, extra = {}) {
  const out = [];
  for (const f of (data && data.features) || []) {
    const p = f.properties || {};
    const coords = (f.geometry && f.geometry.coordinates) || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const ctx = p.context || {};
    const address =
      p.full_address || p.place_formatted || p.address ||
      [ctx.address && ctx.address.name, ctx.place && ctx.place.name].filter(Boolean).join(", ") ||
      "";
    const name = p.name || p.name_preferred || (f.text || "");
    if (!name) continue;

    out.push({ name, address, lat, lon, ...extra });
  }
  return out;
}

async function getJSON(url, signal, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "RecallRadar/1.0" },
    });
    const text = await res.text();
    if (!res.ok) {
      // Mapbox explains rejections (bad token, bad scope, rate limit) in the body.
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); } catch (_) { throw new Error("non-JSON response"); }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Build the Search Box forward-search URL for one chain near a point. */
export function searchUrl(token, query, lat, lon, limit = 10) {
  const qs = new URLSearchParams({
    q: query,
    proximity: `${lon},${lat}`,
    bbox: bboxAround(lat, lon),
    limit: String(limit),
    types: "poi",
    country: "us",
    access_token: token,
  });
  return `${SEARCHBOX}?${qs}`;
}

function geocodeUrl(token, query, lat, lon, limit = 10) {
  const qs = new URLSearchParams({
    q: query,
    proximity: `${lon},${lat}`,
    bbox: bboxAround(lat, lon),
    limit: String(limit),
    types: "poi",
    country: "us",
    access_token: token,
  });
  return `${GEOCODE_V6}?${qs}`;
}

/**
 * Find nearby locations of one chain. Tries Search Box, then Geocoding v6 —
 * they accept the same token and return the same shape, so the second is a
 * free safety net if the first endpoint is unavailable to this account.
 */
export async function findChainLocations(token, chain, lat, lon, signal) {
  const q = chain.label;
  try {
    return parseFeatures(await getJSON(searchUrl(token, q, lat, lon), signal), { chainId: chain.id });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    const data = await getJSON(geocodeUrl(token, q, lat, lon), signal);
    return parseFeatures(data, { chainId: chain.id });
  }
}

/* ------------------------------------------------------------ categories --
 * Chain search answers "where is the nearest Safeway?". It cannot answer
 * "where do people around here actually buy groceries?" — the corner bodega,
 * the co-op, the halal market. Those are the stores most likely to be selling
 * an affected lot without anyone noticing, so we also sweep by POI category.
 */
export const STORE_CATEGORIES = [
  { id: "grocery", label: "Grocery", queries: ["grocery store", "supermarket"] },
  { id: "farmers_market", label: "Market", queries: ["farmers market"] },
];

export function categoryUrl(token, categoryId, lat, lon, limit = 25) {
  const qs = new URLSearchParams({
    proximity: `${lon},${lat}`,
    bbox: bboxAround(lat, lon),
    limit: String(limit),
    language: "en",
    access_token: token,
  });
  return `${CATEGORY}/${encodeURIComponent(categoryId)}?${qs}`;
}

/**
 * Every store of one POI category near a point — chains and independents
 * alike. Falls back to plain forward search if the category endpoint is not
 * available to this token, so a narrower Mapbox plan degrades instead of
 * failing.
 */
export async function findCategoryPlaces(token, cat, lat, lon, signal) {
  try {
    const data = await getJSON(categoryUrl(token, cat.id, lat, lon), signal);
    const found = parseFeatures(data, { category: cat.id });
    if (found.length) return found;
  } catch (err) {
    if (err.name === "AbortError") throw err;
  }

  const byQuery = await Promise.all(
    (cat.queries || []).map(async (q) => {
      try {
        return parseFeatures(await getJSON(searchUrl(token, q, lat, lon, 10), signal), { category: cat.id });
      } catch (err) {
        if (err.name === "AbortError") throw err;
        return [];
      }
    })
  );
  return byQuery.flat();
}

/** Run jobs with bounded concurrency so one lookup can't open 24 sockets. */
export async function pooled(items, worker, size = 6) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = { ok: true, value: await worker(items[i], i) };
        } catch (err) {
          results[i] = { ok: false, error: err && err.message ? err.message : "failed" };
        }
      }
    })
  );
  return results;
}
