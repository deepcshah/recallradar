/* Store-location lookup backed by Vercel Blob (lazy build-through dataset).
 *
 * Flow per area tile (snapped lat/lon + radius, chain-independent):
 *   1. Fresh Blob copy (< 30 days old)  -> serve it, Overpass never touched.
 *   2. Missing or stale                 -> query the Overpass mirrors once for
 *      ALL known chains, slim the result, write it to Blob, serve it.
 *   3. Overpass down and a stale copy exists -> serve the stale copy.
 *
 * The Vercel edge cache (1 day) sits in front of all of this, so Blob reads
 * are rare and Overpass reads are once-per-tile-per-month.
 */
import { head, put } from "@vercel/blob";
import { CHAINS } from "../src/lib/retailers.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const ALL_CHAINS_PATTERN = CHAINS.map((c) => c.osm).join("|");
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // refresh a tile monthly
const KEPT_TAGS = ["name", "brand", "addr:housenumber", "addr:street", "addr:city"];

function buildQuery(lat, lon, radius) {
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
function slimElements(data) {
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
 * exceed the function's 60s maxDuration and get killed mid-flight. */
async function raceMirrors(query, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    return await Promise.any(ENDPOINTS.map((e) => fetchEndpoint(e, query, ctrl.signal)));
  } catch (_) {
    throw new Error(ctrl.signal.aborted ? "all Overpass mirrors timed out" : "all Overpass mirrors failed");
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function readBlob(key) {
  try {
    const meta = await head(key); // throws BlobNotFoundError when missing
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    return { body: await res.json(), uploadedAt: new Date(meta.uploadedAt).getTime() };
  } catch (_) {
    return null; // missing blob, or Blob not configured — fall through to Overpass
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
  } catch (_) { /* Blob write is best-effort; the response still succeeds */ }
}

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseInt(req.query.radius, 10);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      !Number.isFinite(radius) || radius < 100 || radius > 45000) {
    return res.status(400).json({ error: "bad parameters" });
  }

  const key = `stores/v1/${lat.toFixed(2)}_${lon.toFixed(2)}_${radius}.json`;
  const cached = await readBlob(key);
  const fresh = cached && Date.now() - cached.uploadedAt < STALE_MS;

  const ok = (body, source) => {
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.setHeader("X-RR-Source", source);
    return res.status(200).json(body);
  };

  if (fresh) return ok(cached.body, "blob");

  try {
    const data = await raceMirrors(buildQuery(lat.toFixed(2), lon.toFixed(2), radius), 40000);
    const slim = slimElements(data);
    await writeBlob(key, slim);
    return ok(slim, "overpass");
  } catch (err) {
    if (cached) return ok(cached.body, "blob-stale"); // stale beats an error
    return res.status(502).json({ error: err.message });
  }
}

export const config = { maxDuration: 60 };
