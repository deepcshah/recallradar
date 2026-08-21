/* CPSC recall feed proxy: fetches the last 180 days server-side, slims to
 * the fields the app uses, and lets Vercel edge-cache it for 30 minutes.
 * Keep the slimming logic in sync with slimCpsc() in src/lib/sources.js.
 */
export default async function handler(req, res) {
  const start = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const upstream = await fetch(
    `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${start}`,
    { headers: { Accept: "application/json", "User-Agent": "RecallRadar/1.0" } }
  );
  if (!upstream.ok) return res.status(502).json({ error: `CPSC HTTP ${upstream.status}` });
  const raw = await upstream.json();
  const slim = (Array.isArray(raw) ? raw : []).map((r) => ({
    Image: (((r.Images || [])[0] || {}).URL) || "",
    RecallID: r.RecallID,
    RecallNumber: r.RecallNumber,
    RecallDate: r.RecallDate,
    Title: r.Title,
    URL: r.URL,
    Description: String(r.Description || "").slice(0, 400),
    Products: (r.Products || []).slice(0, 4).map((p) => ({ Name: p.Name })),
    Hazards: (r.Hazards || []).map((h) => ({ Name: h.Name || h.HazardType })),
    Manufacturers: (r.Manufacturers || []).slice(0, 3).map((m) => ({ Name: m.Name })),
    Retailers: (r.Retailers || []).map((x) => ({ Name: (x && x.Name) || "" })),
    SoldAtLabel: r.SoldAtLabel || "",
  }));
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json(slim);
}

export const config = { maxDuration: 30 };
