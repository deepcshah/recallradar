/* Serverless Overpass proxy. Queries the public mirrors server-side (no
 * browser CORS, no per-visitor rate limits) and lets Vercel's edge cache
 * the result per lat/lon/radius/pattern for 30 minutes.
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Chain regex fragments only contain these characters (see src/lib/retailers.js).
const PATTERN_RE = /^[a-z0-9 |^$?*+.()\\\[\]&'-]+$/i;

function buildQuery(pattern, lat, lon, radius) {
  const around = `(around:${radius},${lat},${lon})`;
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

async function tryEndpoint(endpoint, query, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "RecallRadar/1.0 (recall lookup; github.com/deepcshah/recallradar)",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseInt(req.query.radius, 10);
  const pattern = String(req.query.pattern || "");

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      !Number.isFinite(radius) || radius < 100 || radius > 45000 ||
      !pattern || pattern.length > 1500 || !PATTERN_RE.test(pattern)) {
    return res.status(400).json({ error: "bad parameters" });
  }

  const query = buildQuery(pattern, lat, lon, radius);
  const errors = [];
  for (const endpoint of ENDPOINTS) {
    try {
      const data = await tryEndpoint(endpoint, query, 25000);
      res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
      return res.status(200).json(data);
    } catch (err) {
      errors.push(`${new URL(endpoint).host}: ${err.name === "AbortError" ? "timeout" : err.message}`);
    }
  }
  return res.status(502).json({ error: "all Overpass mirrors failed", detail: errors });
}

export const config = { maxDuration: 60 };
