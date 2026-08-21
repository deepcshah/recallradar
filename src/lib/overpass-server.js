/* Overpass helpers shared by the serverless functions (api/stores.js and
 * api/refresh-tiles.js). Server-side only — nothing here touches the DOM.
 */
import { CHAINS, osmPosix } from "./retailers.js";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export const ALL_CHAINS_PATTERN = CHAINS.map((c) => osmPosix(c.osm)).join("|");
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
    out center 400;
  `;
  // NB: "out center 400", not "out center tags 400" — the tags verbosity level
  // omits node coordinates entirely, which silently drops every point store.
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
  }).then(async (res) => {
    if (!res.ok) {
      // Overpass explains rejections (rate limit, parse error) in the body.
      const text = await res.text().catch(() => "");
      const detail = (text.match(/error[^<\n]*/i) || [])[0];
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
    }
    return res.json();
  });
}

function describe(err) {
  const details = (err && err.errors ? err.errors : [])
    .map((e, i) => `${new URL(OVERPASS_ENDPOINTS[i]).host}: ${e.message}`)
    .join("; ");
  return details ? ` (${details})` : "";
}

/* Race every mirror in parallel under one budget — sequential tries could
 * exceed the function's maxDuration and get killed mid-flight. If the first
 * wave fails fast (rate limits are the usual reason) and there is budget
 * left, wait a few seconds and race once more. */
export async function raceMirrors(query, budgetMs) {
  const started = Date.now();
  let lastErr = null;
  for (let wave = 0; wave < 2; wave++) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining < 8000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      return await Promise.any(OVERPASS_ENDPOINTS.map((e) => fetchEndpoint(e, query, ctrl.signal)));
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error("all Overpass mirrors timed out");
      lastErr = new Error(`all Overpass mirrors failed${describe(err)}`);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw lastErr || new Error("all Overpass mirrors failed");
}
