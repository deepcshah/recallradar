/* UPC handling: pulling barcodes out of recall text, normalizing them so two
 * spellings of the same product compare equal, and matching a scan against
 * the notices we hold.
 *
 * The hard part is not the scanning. It is that no feed publishes a barcode
 * field. UPCs turn up inside free text — openFDA's `code_info` and
 * `product_description`, FSIS's `field_product_items` — inconsistently,
 * sometimes spaced ("0 12345 67890 5"), sometimes hyphenated, often not at
 * all. CPSC has none.
 *
 * That shapes the whole feature. Coverage is partial and cannot be measured
 * from inside the app, so a scan that finds nothing has learned nothing:
 *
 *     NO MATCH IS NOT AN ALL-CLEAR.
 *
 * Every caller has to say so. `matchUpc` returns `checked` — how many notices
 * even carried a barcode to compare against — precisely so the interface can
 * tell the difference between "we looked at 40 notices with codes and none
 * was yours" and "almost nothing here lists a barcode at all".
 */

/* 12 to 14 digits, allowing the spaces and hyphens printed under a barcode.
 * Bounded on both sides so a 20-digit lot number is not read as a UPC. */
const CANDIDATE_RE = /(?<![\d-])(\d[\d\s-]{10,16}\d)(?![\d-])/g;

/** Digits only. */
function digits(s) {
  return String(s || "").replace(/\D/g, "");
}

/* GTIN check digit: weight alternating 3 and 1 from the right, sum, and the
 * amount that rounds it up to a multiple of ten is the last digit. Cheap, and
 * it throws out most lot numbers that happen to be twelve digits long. */
function checkDigitOk(d) {
  if (d.length < 8) return false;
  const body = d.slice(0, -1);
  const want = Number(d[d.length - 1]);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const n = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10 === want;
}

/** UPC-E (8 digits) expanded to its UPC-A (12) form, or null if it is not one. */
function expandUpcE(d) {
  if (d.length !== 8 || (d[0] !== "0" && d[0] !== "1")) return null;
  const m = d.slice(1, 7);
  const last = m[5];
  const check = d[7];
  let body;
  if (last === "0" || last === "1" || last === "2") {
    body = `${m.slice(0, 2)}${last}0000${m.slice(2, 5)}`;
  } else if (last === "3") {
    body = `${m.slice(0, 3)}00000${m.slice(3, 5)}`;
  } else if (last === "4") {
    body = `${m.slice(0, 4)}00000${m[4]}`;
  } else {
    body = `${m.slice(0, 5)}0000${last}`;
  }
  return `${d[0]}${body}${check}`;
}

/** Every spelling of one barcode that should compare equal.
 *
 *  A UPC-A printed on a US package is the same GTIN as the EAN-13 with a
 *  leading zero, and the same as the GTIN-14 with two. Comparing the raw
 *  strings would miss a match purely on how the number was written down, so
 *  everything collapses to a 14-digit form and the shorter spellings come
 *  along for text matching. */
export function upcForms(raw) {
  let d = digits(raw);
  if (!d) return [];
  if (d.length === 8) d = expandUpcE(d) || d;
  const g14 = d.length <= 14 ? d.padStart(14, "0") : d.slice(-14);
  const forms = new Set([g14]);
  forms.add(g14.replace(/^0+/, "") || "0");
  if (g14.length === 14) {
    forms.add(g14.slice(-13));           // EAN-13
    forms.add(g14.slice(-12));           // UPC-A
    forms.add(g14.slice(-13).replace(/^0+/, ""));
  }
  return [...forms].filter(Boolean);
}

/** The canonical 14-digit key for a barcode. */
export function upcKey(raw) {
  return upcForms(raw)[0] || "";
}

/** Whether a scanned string looks like a real retail barcode at all. */
export function isPlausibleUpc(raw) {
  const d = digits(raw);
  if (![8, 12, 13, 14].includes(d.length)) return false;
  return checkDigitOk(d);
}

/** Barcodes mentioned anywhere in a blob of recall text, as canonical keys. */
export function upcsIn(text) {
  const out = new Set();
  const t = String(text || "");
  let m;
  CANDIDATE_RE.lastIndex = 0;
  while ((m = CANDIDATE_RE.exec(t))) {
    const d = digits(m[1]);
    // Only lengths a retail barcode actually comes in, and only if the check
    // digit agrees — otherwise every lot number would look like a UPC.
    if (![8, 12, 13, 14].includes(d.length) || !checkDigitOk(d)) continue;
    out.add(upcKey(d));
  }
  return [...out];
}

/** Every barcode this recall mentions, cached on the record. */
export function recallUpcs(r) {
  if (r.__upcs) return r.__upcs;
  const found = upcsIn([r.codeInfo, r.product, r.distribution].filter(Boolean).join(" \n "));
  try { Object.defineProperty(r, "__upcs", { value: found, enumerable: false }); } catch (_) { /* frozen */ }
  return found;
}

/** Loose word set for name matching — 4+ letters, no units or filler. */
const STOP = new Set([
  "with", "from", "size", "pack", "case", "each", "count", "ounce", "ounces",
  "pound", "pounds", "gram", "grams", "fluid", "brand", "product", "products",
  "inc", "llc", "company", "food", "foods", "original", "organic", "natural",
]);
function tokens(s) {
  return new Set(
    String(s || "").toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
  );
}

/**
 * Match a scanned barcode — and, when Open Food Facts could name it, the
 * product's own name and brand — against the recalls we hold.
 *
 * Two kinds of hit, kept apart because they are not the same claim:
 *   exact — a notice prints this barcode. That is the product, full stop.
 *   name  — a notice's text shares distinctive words with the scanned
 *           product's brand and name. A lead, not an identification.
 *
 * `checked` is how many notices carried any barcode at all. Without it the
 * interface cannot honestly distinguish "none of these is yours" from "there
 * was almost nothing here to compare against".
 */
export function matchUpc(recalls, raw, product) {
  const forms = new Set(upcForms(raw));
  const key = upcKey(raw);
  const exact = [];
  const named = [];
  let checked = 0;

  const want = product ? tokens(`${product.brand || ""} ${product.name || ""}`) : new Set();

  for (const r of recalls) {
    const codes = recallUpcs(r);
    if (codes.length) checked += 1;
    if (key && codes.includes(key)) { exact.push(r); continue; }
    // A barcode can also appear in text we did not parse as one.
    if (forms.size && [r.codeInfo, r.product].some((t) => t && [...forms].some((f) => f.length >= 12 && String(t).includes(f)))) {
      exact.push(r);
      continue;
    }
    if (!want.size) continue;
    const have = tokens(`${r.product} ${r.firm}`);
    let overlap = 0;
    for (const w of want) if (have.has(w)) overlap += 1;
    if (overlap >= 2) named.push({ recall: r, overlap });
  }

  named.sort((a, b) => b.overlap - a.overlap);
  return { exact, named: named.slice(0, 6).map((x) => x.recall), checked, withCodes: checked };
}

/* ── Open Food Facts ───────────────────────────────────────────────────────
 * Free, keyless, CORS-open, and the only route to a product photo for FDA and
 * FSIS notices, neither of which publishes one. It is also what turns a
 * barcode into words we can match on: a bare number matches nothing, but
 * "Fresh Express / Sweet Kale Chopped Salad Kit" matches plenty.
 *
 * Community data, so a miss means nothing either way — treated as best
 * effort throughout, and never as evidence about a product's safety.
 */
const OFF = "https://world.openfoodfacts.org/api/v2/product";
const OFF_FIELDS = "product_name,brands,image_front_small_url,image_small_url,quantity";
const offCache = new Map();

export async function lookupProduct(raw, { timeoutMs = 7000 } = {}) {
  const code = digits(raw);
  if (!code) return null;
  if (offCache.has(code)) return offCache.get(code);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OFF}/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const p = body && body.product;
    const out = p && (p.product_name || p.brands)
      ? {
          name: p.product_name || "",
          brand: (p.brands || "").split(",")[0].trim(),
          image: p.image_front_small_url || p.image_small_url || "",
          quantity: p.quantity || "",
        }
      : null;
    offCache.set(code, out);
    return out;
  } catch (_) {
    offCache.set(code, null); // don't retry a miss on every render
    return null;
  } finally {
    clearTimeout(timer);
  }
}
