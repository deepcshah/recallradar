/* openFDA enforcement proxy. Attaches the API key (env var `openfda`) so it
 * never ships in client code, lifting the shared keyless quota (1,000/day per
 * IP) to 120,000/day. Responses are edge-cached per kind+state for 30 minutes.
 * openFDA's "no matches" 404 is normalized to an empty result set so it can
 * be cached like any other answer.
 */
const KINDS = new Set(["food", "drug", "device"]);
const DAY_MS = 86400000;
const LOOKBACK_DAYS = 365;

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export default async function handler(req, res) {
  const kind = String(req.query.kind || "");
  const state = String(req.query.state || "");
  const abbr = String(req.query.abbr || "");

  if (!KINDS.has(kind) ||
      (state && !/^[A-Za-z ]{2,30}$/.test(state)) ||
      (abbr && !/^[A-Za-z]{2}$/.test(abbr))) {
    return res.status(400).json({ error: "bad parameters" });
  }

  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const parts = [`distribution_pattern:"nationwide"`];
  if (abbr) parts.push(`distribution_pattern:"${abbr.toUpperCase()}"`);
  if (state) parts.push(`distribution_pattern:"${state}"`);
  const search =
    `status:"Ongoing"+AND+report_date:[${fmtDate(start)}+TO+${fmtDate(now)}]` +
    `+AND+(${parts.join("+OR+")})`;

  const key = process.env.openfda;
  const url =
    `https://api.fda.gov/${kind}/enforcement.json?search=${search.replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=100` + (key ? `&api_key=${key}` : "");

  const upstream = await fetch(url, { headers: { Accept: "application/json" } });
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  if (upstream.status === 404) return res.status(200).json({ results: [] }); // no matches
  if (!upstream.ok) return res.status(502).json({ error: `openFDA HTTP ${upstream.status}` });
  return res.status(200).json(await upstream.json());
}

export const config = { maxDuration: 30 };
