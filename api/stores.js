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

/* Race every mirror in parallel under one budget. Sequential tries at 25s
 * each could exceed the function's 60s maxDuration and get killed mid-flight;
 * a single 40s parallel wave always finishes inside it. */
async function raceMirrors(query, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    return await Promise.any(ENDPOINTS.map((e) => fetchEndpoint(e, query, ctrl.signal)));
  } catch (err) {
    const detail = err instanceof AggregateError
      ? err.errors.map((e, i) => `${new URL(ENDPOINTS[i]).host}: ${e.name === "AbortError" ? "timeout" : e.message}`)
      : [String(err && err.message)];
    const failure = new Error(ctrl.signal.aborted ? "all mirrors timed out" : "all mirrors failed");
    failure.detail = detail;
    throw failure;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
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
  try {
    const data = await raceMirrors(query, 40000);
    // Store locations change on the order of months — cache aggressively:
    // 7 days fresh at the edge, stale-while-revalidate for 30 more.
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=2592000");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message, detail: err.detail || [] });
  }
}

export const config = { maxDuration: 60 };
