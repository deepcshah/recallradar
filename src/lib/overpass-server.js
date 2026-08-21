/* Overpass helpers shared by the serverless functions (api/stores.js and
 * api/refresh-tiles.js). Server-side only — nothing here touches the DOM.
 */
import { CHAINS } from "./retailers.js";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export const ALL_CHAINS_PATTERN = CHAINS.map((c) => c.osm).join("|");
const KEPT_TAGS = ["name", "brand", "addr:housenumber", "addr:street", "addr:city"];

export function buildTileQuery(lat, lon, radius) {
  const around = `(around:${radius},${lat},${lon})`;
  return `
    [out:json][timeout:40];
    (
      node["shop"]["name"~"${ALL_CHAINS_PATTERN}",i]${around};
      way["shop"]["name"~"${ALL_CHAINS_PATTERN}",i]${around};
      node["amenity"="pharmacy"]["name"~"${ALL_CHAINS_PATTERN}",i]${around};
      way["amenity"="pharmacy"]["name"~"${ALL_CHAINS_PATTERN}",i]${around};
    );
    out center tags 400;
  `;
}

/** Keep the overpass element shape the client parses, minus unused tags. */
export function slimElements(data) {
  const elements = (data.elements || []).map((el) => {
    const tags = {};
    for (const k of KEPT_TAGS) if (el.tags && el.tags[k] != null) tags[k] = el.tags[k];
    const out = { tags };
    if (el.lat != null) { out.lat = el.lat; out.lon = el.lon; }
    else if (el.center) { out.center = { lat: el.center.lat, lon: el.center.lon }; }
    return out;
  });
  return { fetchedAt: new Date().toISOString(), elements };
}

function fetchEndpoint(endpoint, query, signal) {
  return fetch(endpoint, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RecallRadar/1.0 (recall lookup; github.com/deepcshah/recallradar)",
    },
    signal,
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

/* Race every mirror in parallel under one budget — sequential tries could
 * exceed the function's maxDuration and get killed mid-flight. */
export async function raceMirrors(query, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map((e) => fetchEndpoint(e, query, ctrl.signal)));
  } catch (_) {
    throw new Error(ctrl.signal.aborted ? "all Overpass mirrors timed out" : "all Overpass mirrors failed");
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}
