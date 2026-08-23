/* Diagnostic probe: verifies the Mapbox token and the store pipeline end to
 * end, and reports exactly what Mapbox said. Visit
 *   /api/diag?lat=40.65&lon=-73.96
 * and read the JSON. Nothing here echoes the token — only whether it is
 * present, its public prefix, and the upstream status codes and messages.
 */
import { byId } from "../src/lib/retailers.js";
import { findChainLocations, searchUrl } from "../src/lib/mapbox-server.js";

const PROBE_CHAINS = ["cvs", "safeway", "walmart"];

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "pass ?lat=<number>&lon=<number>" });
  }

  const token = process.env.MAPBOX_TOKEN;
  const report = {
    checkedAt: new Date().toISOString(),
    at: { lat, lon },
    token: {
      present: Boolean(token),
      // A public token starts "pk."; a secret one starts "sk." and should NOT be used here.
      kind: token ? String(token).slice(0, 3) : null,
      looksPublic: Boolean(token && String(token).startsWith("pk.")),
    },
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    probes: [],
  };

  if (!token) {
    report.verdict = "MAPBOX_TOKEN is not set in this environment. Add it in Vercel " +
      "project settings and redeploy.";
    return res.status(200).json(report);
  }

  // Show the request shape with the token redacted, so a bad URL is visible.
  report.sampleRequest = searchUrl("REDACTED", "CVS", lat, lon).replace(/access_token=[^&]*/, "access_token=REDACTED");

  for (const id of PROBE_CHAINS) {
    const chain = byId(id);
    if (!chain) continue;
    const started = Date.now();
    try {
      const stores = await findChainLocations(token, chain, lat, lon);
      report.probes.push({
        chain: chain.label,
        ok: true,
        found: stores.length,
        ms: Date.now() - started,
        sample: stores.slice(0, 3).map((s) => ({ name: s.name, address: s.address })),
      });
    } catch (err) {
      report.probes.push({
        chain: chain.label,
        ok: false,
        ms: Date.now() - started,
        error: err && err.message ? err.message : "failed",
      });
    }
  }

  const good = report.probes.filter((p) => p.ok).length;
  report.verdict = good === 0
    ? "Every Mapbox probe failed — see probes[].error for the upstream message."
    : `${good}/${report.probes.length} probes succeeded; the store pipeline is working.`;

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(report);
}

export const config = { maxDuration: 30 };
