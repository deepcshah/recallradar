/* ─────────────────────────────────────────────────────────────────────────
 * A RECALL AT A GLANCE — the four facts a person checks first
 *
 *   hazard   "Fire and burn hazard"
 *   soldAt   ["Amazon"]
 *   when     "Jul 2024 – Aug 2026"
 *   price    "$346"
 *
 * CPSC writes all of these into prose. The title names the hazard ("…Due to
 * Risk of Serious Injury or Death from Fire and Burn Hazards") and the "Sold
 * At" line names the stores, the dates and the price. The index clips titles
 * at ~90 characters, which usually cuts off exactly the hazard, but the
 * notice URL is the full title as a slug — so the hazard is read from there
 * first. Every word shown comes from the notice; a fact that can't be read
 * is left out, never guessed.
 *
 * FDA and USDA records get the hazard only: their distribution text is a
 * shipping list, already summarised as "Nationwide" / "8 states".
 * ───────────────────────────────────────────────────────────────────────── */

import { ABBR_TO_NAME } from "./states.js";

const STATE_NAMES = new Set(Object.values(ABBR_TO_NAME).map((n) => n.toLowerCase()));

const MONTHS = {
  january: "Jan", february: "Feb", march: "Mar", april: "Apr", may: "May", june: "Jun",
  july: "Jul", august: "Aug", september: "Sep", october: "Oct", november: "Nov", december: "Dec",
};
const MONTH = "(January|February|March|April|May|June|July|August|September|October|November|December)";

function titleText(r) {
  let slug = "";
  try {
    const path = new URL(String(r.url || "")).pathname;
    slug = decodeURIComponent(path.split("/").filter(Boolean).pop() || "").replace(/-/g, " ");
  } catch (_) { /* no URL */ }
  const product = String(r.product || "").replace(/…$/, "");
  return slug.length > product.length ? slug : product;
}

/** "Fire and Burn" -> "Fire and burn hazard". */
function hazardPhrase(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim().replace(/[,;.]+$/, "");
  if (!t || t.length > 48) return "";
  const s = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  return /hazard|risk/i.test(s) ? s : `${s} hazard`;
}

/** The hazard a CPSC title names, or "". */
export function cpscHazard(r) {
  const t = titleText(r || {});
  const END = String.raw`(?:\s+hazards?\b|\s+violat\w*\b|\s+recalled\b|\s+sold\b|\s+imported\b|\s+manufactured\b|\s+distributed\b|$)`;
  const m =
    t.match(new RegExp(String.raw`\b(?:death|injur\w*|illness)\b.{0,25}?\bfrom\s+(.+?)` + END, "i")) ||
    t.match(new RegExp(String.raw`\bdue\s+to\s+(?!risk\b)(.+?)` + END, "i")) ||
    t.match(new RegExp(String.raw`\brisk\s+of\s+(?:serious\s+)?(?!injury\b)(.+?)` + END, "i"));
  return m ? hazardPhrase(m[1]) : "";
}

/** True when the title says the product fails a mandatory federal standard. */
export function failsStandard(r) {
  return /\bviolat\w*\s+(?:the\s+)?(?:mandatory|federal)\b/i.test(titleText(r || {}));
}

function soldAtList(dist) {
  let s = String(dist || "").replace(/\s+/g, " ").trim();
  const pre = s.match(/\bSold\b[^:]{0,40}:\s*(.+)/i);
  if (pre) s = pre[1];
  s = s.replace(/^(?:sold\s+)?(?:online\s+)?(?:exclusively\s+)?(?:at|on)\s+/i, "");
  s = s
    .split(new RegExp(`\\s(?:from|in|during|between|since)\\s+(?:${MONTH}\\s+)?\\d{4}|\\s(?:from|for)\\s+(?:about\\s+|between\\s+|around\\s+)?\\$|\\s+for\\s+`, "i"))[0]
    .split(/[.;]\s|\s·\s/)[0];
  s = s
    .replace(/\b(?:and\s+)?other\b.*$/i, "")
    .replace(/\bincluding\b.*$/i, "")
    .replace(/\b(?:stores?|retailers?|dealers?)\s+nationwide\b/gi, (w) => w.split(/\s+/)[0])
    .replace(/\bnationwide\b/gi, "")
    .replace(/\b(?:and\s+)?online\s+at\b/gi, ",")
    .replace(/\bexclusively\s+(?:at|on)\b/gi, "")
    .replace(/\band\b/gi, ",");
  const seen = new Set();
  const out = [];
  for (let p of s.split(",")) {
    p = p.trim().replace(/^(?:at|on)\s+/i, "").replace(/\s+/g, " ");
    if (!p || p.length > 32 || /https?:|www\.|^in\s|^\$/i.test(p) || STATE_NAMES.has(p.toLowerCase())) continue;
    p = p.replace(/^(amazon|walmart|target|temu|wayfair|ebay|etsy|shein)\.com$/i, (_, n) => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase());
    p = p.charAt(0).toUpperCase() + p.slice(1);
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length === 3) break;
  }
  return out;
}

function whenSold(dist) {
  const d = String(dist || "");
  let m = d.match(new RegExp(`\\bfrom\\s+${MONTH}\\s+(\\d{4})\\s+(?:through|to|until)\\s+${MONTH}\\s+(\\d{4})`, "i"));
  if (m) {
    const a = `${MONTHS[m[1].toLowerCase()]} ${m[2]}`;
    const b = `${MONTHS[m[3].toLowerCase()]} ${m[4]}`;
    return a === b ? a : `${a} – ${b}`;
  }
  m = d.match(new RegExp(`\\b(?:in|during)\\s+${MONTH}\\s+(\\d{4})`, "i"));
  if (m) return `${MONTHS[m[1].toLowerCase()]} ${m[2]}`;
  m = d.match(/\bfrom\s+(\d{4})\s+(?:through|to|until)\s+(\d{4})/i);
  return m ? (m[1] === m[2] ? m[1] : `${m[1]} – ${m[2]}`) : "";
}

function priceOf(dist) {
  const m = String(dist || "").match(/\bfor\s+(?:about\s+|between\s+|around\s+|approximately\s+)?\$(\d[\d,]*(?:\.\d+)?)(?:\s*(?:to|and|-|–)\s*\$?(\d[\d,]*(?:\.\d+)?))?/i);
  if (!m) return "";
  return m[2] ? `$${m[1]}–${m[2]}` : `$${m[1]}`;
}

/** { hazard, failsStandard, soldAt[], when, price } — empty strings and
 *  arrays where the notice doesn't say. `hazard` is CPSC's only; callers
 *  fall back to hazardLabel for other agencies. */
export function glanceOf(r) {
  const rec = r || {};
  if (rec.source !== "CPSC") return { hazard: "", failsStandard: false, soldAt: [], when: "", price: "" };
  return {
    hazard: cpscHazard(rec),
    failsStandard: failsStandard(rec),
    soldAt: soldAtList(rec.distribution),
    when: whenSold(rec.distribution),
    price: priceOf(rec.distribution),
  };
}
