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

/* The full title. The index clips it (~90 chars, often mid-word); the notice
 * URL is the whole title as a slug but loses its punctuation ("Children's",
 * commas, "&"). So: the stored words as written, then the slug's remaining
 * words — slug words line up one-to-one with title words. */
function titleText(r) {
  let slug = "";
  try {
    const path = new URL(String(r.url || "")).pathname;
    slug = decodeURIComponent(path.split("/").filter(Boolean).pop() || "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  } catch (_) { /* no URL */ }
  const raw = String(r.product || "").replace(/\s+/g, " ").trim();
  const clipped = /…$/.test(raw);
  const product = raw.replace(/…$/, "");
  if (!clipped || !slug) return slug.length > product.length && !product ? slug : product || slug;
  const words = product.split(" ");
  words.pop(); // the clipped, partial word
  /* A title word can be several slug words ("Tip-Over", "QZH.DUAO", "8-Drawer"),
   * and punctuation-only words ("&") are none; apostrophes just vanish. */
  const used = words.reduce((n, w) => n + w.replace(/['’]/g, "").split(/[^A-Za-z0-9™®]+/).filter(Boolean).length, 0);
  const tail = slug.split(" ").slice(used);
  return [...words, ...tail].join(" ");
}

/** "Fire and Burn" -> "Fire and burn hazard". */
function hazardPhrase(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim().replace(/[,;.]+$/, "").replace(/^from\s+/i, "")
    .replace(/\bcarbon monoxide\s+\(?co\)?(?=\s|$)/i, "carbon monoxide");
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

const BRAND_TAIL = /(?:,|\s)\s*(?:USA|U\.S\.A?\.?|of America|North America|Americas?|Inc\.?|Incorporated|LLC|L\.L\.C\.|Ltd\.?|Limited|Co\.|Corp\.?|Corporation|Company|Group|International|Holdings|Enterprises?|Trading|Technology|Technologies|Brands|Distribution|Distributors?)\b.*$/i;
const PRODUCT_END = /\s+(?:due\s+to|because|following|after\s+(?:reports?|incidents?)|sold\s+(?:exclusively|at|on|online|by)|imported\s+by|manufactured\s+by|distributed\s+by|violat\w*|;|\(|–|—)/i;
const QTY = /^(?:about|approximately|nearly|more\s+than|over|some|almost|roughly)?\s*[\d.,]+\s*(?:million|thousand|k)?\s+(?:units?\s+of\s+|pairs?\s+of\s+|sets?\s+of\s+)?/i;

/** "Bodum USA Recalls 5.9 Million French Press Coffee Makers with Replaceable
 *  Glass Carafes Due to…" -> "Bodum French Press Coffee Makers".
 *
 *  CPSC titles are "<Firm> Recalls <how many> <product> <details> Due to
 *  <hazard>" or "<product> Recalled Due to…". The name is the brand (the firm
 *  minus "USA", "Inc." and the like) and the product, without the unit count
 *  — "5.9 Million" is how many were sold, not what it is — and without the
 *  "with …" detail. "" when the title has neither shape. */
export function cpscProductName(r) {
  const t = titleText(r || {});
  let brand = "";
  let rest = "";
  const recalls = t.match(/^(.+?)\s+(?:(?:Re)?announces(?:\s+and\s+Expands)?\s+Recall\s+of|Issues\s+Recall\s+of|Expands\s+Recall\s+of|Recalls|Recall)\s+(.+)$/i);
  const recalled = t.match(/^(.+?)\s+(?:Recalled|Are\s+Being\s+Recalled|Being\s+Recalled)\b/i);
  if (recalls) { brand = recalls[1]; rest = recalls[2]; }
  else if (recalled) rest = recalled[1];
  else return "";
  rest = rest.split(PRODUCT_END)[0].replace(QTY, "").trim();
  const w = rest.split(/\s+with\s+|\s+that\s+|\s+for\s+use\s+/i)[0];
  if (w.split(" ").length >= 2) rest = w;
  rest = rest.replace(/[,;:.]+$/, "").replace(/\s+(?:due|because|recalled|sold|and)$/i, "").trim();
  brand = brand.replace(/^the\s+/i, "").replace(/,?\s+of\s+[A-Z].*$/, "").replace(BRAND_TAIL, "").replace(/[,.]+$/, "").trim();
  /* The product line often names its own brand after the seller's — "CIYTI",
   * "QZH.DUAO", "LandTale": shouted, dotted or camel-cased. Then the seller
   * (often a long trading-company name) is dropped rather than stacked. */
  const first = rest.split(" ")[0] || "";
  const ownBrand = /^[A-Z0-9][A-Z0-9.™®]{2,}$/.test(first) || /[a-z][A-Z]/.test(first);
  const reseller = /^\S{16,}$/.test(brand) || /\b(?:store|shop|trading|apparel|direct|brand|distribution|e-?commerce|import|export)\b/i.test(brand);
  if ((ownBrand && reseller) || brand.split(" ").length > 4) brand = "";
  if (!rest) return "";
  /* A list of models ("ASTRO BOD FAST, ASTRO SIT FAST and CANYON GUIDE
   * Harnesses") names the kind of thing last: keep the brand and that. */
  if (rest.split(" ").length > 6 && /,|\sand\s/.test(rest)) {
    const kind = rest.split(" ").pop();
    if (/^[A-Z][a-z]+s$/.test(kind) && brand) rest = kind;
  }
  const lead = brand.toLowerCase().split(" ")[0];
  const named = brand && !rest.toLowerCase().includes(lead) ? `${brand} ${rest}` : rest;
  const words = named.split(" ");
  return words.length > 9 ? words.slice(0, 9).join(" ") : named;
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
    /* A named place starts with a capital or is a website: "coffee and home
     * goods stores" is a kind of shop, not somewhere to look, and split on
     * "and" it became "Coffee". */
    if (!/^[A-Z0-9]/.test(p) && !/\.(?:com|net|org|co)\b/i.test(p)) continue;
    /* …and a sentence's first words are capitalised whatever they are:
     * "Independent heating and plumbing contractors", "Specialty bike
     * stores" describe kinds of seller, not one to look for. */
    if (/^(?:independent|specialty|speciality|commercial|authorized|authorised|various|select|sporting|hardware|home|department|retail|online|grocery|discount|wholesale|local|major|national|other|furniture|toy|pet|baby|bike|bicycle|outdoor|electronics?)\b/i.test(p)) continue;
    p = p.replace(/^(amazon|walmart|target|temu|wayfair|ebay|etsy|shein)\.com$/i, (_, n) => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase());
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
  const d = String(dist || "");
  const m = d.match(/\bfor\s+(?:about\s+|between\s+|around\s+|approximately\s+)?\$(\d[\d,]*(?:\.\d+)?)(?:\s*(?:to|and|-|–)\s*\$?(\d[\d,]*(?:\.\d+)?))?/i);
  if (!m) return "";
  /* The stored text is clipped (~140 chars, ending "…"): a price cut there
   * ("$3,…" — $3,000 or more) would read as $3. Say nothing instead. */
  if (/^\s*[,.]?\s*…/.test(d.slice(m.index + m[0].length)) || /[,.]$/.test(m[2] || m[1]) && /…$/.test(d)) return "";
  const n = (x) => String(x || "").replace(/[,.]+$/, "");
  return m[2] && n(m[2]) ? `$${n(m[1])}–${n(m[2])}` : `$${n(m[1])}`;
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
