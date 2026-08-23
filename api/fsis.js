/* USDA FSIS recall feed proxy: fetches server-side (avoids any browser CORS
 * restriction), keeps only active notices and the fields the app uses, and
 * lets Vercel edge-cache the slim result for 30 minutes.
 * Keep the slimming logic in sync with slimFsis() in src/lib/sources.js.
 */
import { FEED_HEADERS } from "../src/lib/feeds.js";

export default async function handler(req, res) {
  const upstream = await fetch("https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json", {
    headers: FEED_HEADERS,
  });
  if (!upstream.ok) return res.status(502).json({ error: `FSIS HTTP ${upstream.status}` });
  const raw = await upstream.json();
  const all = Array.isArray(raw) ? raw : (raw && raw.results) || [];
  const slim = all
    .filter((r) => String(r.field_active_notice).toLowerCase() === "true")
    .map((r) => ({
      field_title: r.field_title,
      field_recall_number: r.field_recall_number,
      field_states: r.field_states,
      field_recall_date: r.field_recall_date,
      field_risk_level: r.field_risk_level,
      field_recall_reason: r.field_recall_reason,
      field_recall_classification: r.field_recall_classification,
      field_summary: String(r.field_summary || "").slice(0, 500),
      field_product_items: String(r.field_product_items || "").slice(0, 500),
      field_recall_url: r.field_recall_url,
      field_establishment: r.field_establishment,
      field_qty_recovered: r.field_qty_recovered,
    }));
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json(slim);
}

export const config = { maxDuration: 30 };
