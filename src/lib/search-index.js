/* The national recall index, read from the browser.
 *
 * Everything else in this app starts from a place: give it a state and it
 * asks each agency for notices that cover that state. That is the right shape
 * for "what should I worry about near me", and the wrong shape for the
 * question people most often arrive with — "is *that thing* recalled?" — which
 * has no place in it at all. Answering it from the per-state payload means a
 * product sold only in Oregon is invisible to a searcher in Ohio, and the
 * empty result says "nothing found" when the truth is "not looked for".
 *
 * So there is a second, location-free dataset: `public/feeds/index.json`,
 * every recall across all three agencies for the last year, *including* ones
 * that have ended, built by scripts/build-index.mjs on the same GitHub runner
 * that writes the FSIS and CPSC snapshots. It is a static asset, so searching
 * it costs one CDN fetch and no API quota, and it is fetched only when someone
 * actually searches — it is a few hundred KB gzipped and has no business on
 * the critical path.
 *
 * Record shape (contract 3; see scripts/build-index.mjs for how each field is
 * derived):
 *   { id, source, product, firm, reason, classification, severity, date,
 *     status: 'active'|'ended', endDate?, distribution, states,
 *     coverage: 'nationwide'|'states'|'unstated', category, reasonKey, url,
 *     upcs? }
 *
 * Two honesty rules carry over from the rest of the app and matter more here,
 * because a search result is read as an answer:
 *   - an ended recall is returned, not hidden. Hiding it makes "it was
 *     recalled and that is over" look identical to "we never heard of it".
 *   - when the index could not get FDA data (`sources.fda.ok === false`) an
 *     empty result is not "no FDA recall" — it is "FDA not checked". The
 *     caller falls back to `liveLookup`, which asks openFDA directly.
 *
 * MiniSearch is lazy-loaded through a dynamic import so it lands in its own
 * chunk, exactly like ZXing and posthog-js: anyone who never searches never
 * downloads it. The search itself is synchronous so the UI can run it per
 * keystroke; `loadIndex()` resolves only once the engine is built, and a
 * caller that somehow searches before that gets a plain substring scan rather
 * than an empty list.
 */
import { statesIn, NATIONWIDE_RE } from "./sources.js";
import { coverageOf, isInArea, resolveLoc } from "./verdict.js";
import { categoryFor } from "./category.js";
import { reasonFor } from "./reason.js";
import { upcKey, upcsIn } from "./upc.js";

const INDEX_URL = "/feeds/index.json";
const DAY_MS = 86400000;
const CACHE_KEY = "rr-index";
const CACHE_TTL_MS = 30 * 60 * 1000;
/* sessionStorage is ~5M UTF-16 characters per origin, shared with the per-feed
 * cache in sources.js. Past this the index is simply not cached there — the
 * HTTP cache still has it, and blowing the quota would evict the feed cache
 * that the main view depends on. */
const CACHE_MAX_CHARS = 2_500_000;

// ------------------------------------------------------------ coverage
/* Where a notice says it went, independent of where the reader is.
 *
 * Deliberately the same three-way answer as verdict.js `coverageOf`, and built
 * from the same parts as `scopeFor` in sources.js (NATIONWIDE_RE first, then
 * named states) so the index and the live path never disagree about a record.
 * `unstated` is not `nationwide`: a notice that says "Sold at Trader Joe's"
 * has told us nothing about geography, and flattening that into "everywhere"
 * would be inventing a claim the agency never made.
 *
 * CPSC is the one agency that is national by construction — it regulates
 * consumer products sold across the country and never scopes a notice to a
 * state — so its records are nationwide whatever the retailer text says,
 * matching normalizeCpsc. FSIS publishes an explicit states field and leaves
 * it empty for nationwide notices, matching normalizeFsis. */
export function coverageFromText(distribution, source = "") {
  const text = String(distribution || "");
  const states = statesIn(text);
  if (source === "CPSC") return { coverage: "nationwide", states: [] };
  if (source === "USDA FSIS" && (!text.trim() || /nationwide/i.test(text))) {
    return { coverage: "nationwide", states: [] };
  }
  if (NATIONWIDE_RE.test(text)) return { coverage: "nationwide", states };
  if (states.length) return { coverage: "states", states };
  return { coverage: "unstated", states: [] };
}

/** The area list's own test (verdict.js `isInArea`) — nationwide, or names
 *  the reader's state, or names no geography but does name a chain we can put
 *  on a map — so "new near you" can never show more, or less, than the area
 *  list would. verdict.js reads the `coverage` the index already carries.
 *  With no usable location only nationwide notices qualify: every other
 *  record needs a state before it can honestly be called "yours". */
export function indexRecordInArea(r, loc) {
  if (!r) return false;
  if (!resolveLoc(loc)) return coverageOf(r).kind === "nationwide";
  return isInArea(r, loc);
}

// ------------------------------------------------------------ loading
let indexPromise = null;
const engines = new WeakMap(); // index object -> MiniSearch instance
let miniSearchCtor = null;

function readCache() {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS && hit.v && Array.isArray(hit.v.recalls)) return hit.v;
  } catch (_) { /* private mode, blocked storage, or a corrupt entry */ }
  return null;
}

function writeCache(text) {
  try {
    if (text.length > CACHE_MAX_CHARS) return;
    sessionStorage.setItem(CACHE_KEY, `{"t":${Date.now()},"v":${text}}`);
  } catch (_) { /* quota — the HTTP cache still has it */ }
}

async function fetchIndex() {
  const cached = readCache();
  if (cached) return cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(INDEX_URL, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const index = JSON.parse(text);
    if (!index || !Array.isArray(index.recalls)) throw new Error("index.json has no recalls array");
    writeCache(text);
    return index;
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out loading the recall index") : err;
  } finally {
    clearTimeout(timer);
  }
}

/* Words a category key stands for, so "bread" or "baby" finds a notice whose
 * product text happens not to use that word. Keys are category.js's. */
const CATEGORY_WORDS = {
  pet: "pet food pets dog cat", kids: "kids baby infant children", supplement: "supplement vitamin",
  meat: "meat poultry", seafood: "seafood fish", dairy: "dairy eggs", produce: "produce fruit vegetables",
  grains: "bakery grains bread", snacks: "snacks candy", beverage: "beverages drinks", pantry: "pantry prepared",
  food: "food", drug: "medication medicine drug", device: "medical device", electrical: "electrical",
  appliance: "appliance", home: "home furniture", sports: "sports outdoor", product: "consumer product",
};

async function buildEngine(index) {
  if (engines.has(index)) return engines.get(index);
  if (!miniSearchCtor) miniSearchCtor = (await import("minisearch")).default;
  const engine = new miniSearchCtor({
    idField: "_k",
    fields: ["product", "firm", "reason", "categoryText"],
    extractField: (doc, field) => {
      if (field === "_k") return doc._k;
      if (field === "categoryText") return CATEGORY_WORDS[doc.r.category] || doc.r.category || "";
      return doc.r[field] || "";
    },
    searchOptions: {
      boost: { product: 3, firm: 2, reason: 1, categoryText: 1 },
      prefix: true,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
    },
  });
  // Positional keys: record ids are unique in practice, but a duplicate would
  // make MiniSearch throw and take the whole search down with it.
  engine.addAll(index.recalls.map((r, i) => ({ _k: i, r })));
  engines.set(index, engine);
  return engine;
}

/** The national index, fetched once per page (and cached in sessionStorage
 *  for half an hour when it fits), with the search engine already built.
 *  Rejects when the file cannot be read; a later call retries. */
export function loadIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const index = await fetchIndex();
      try {
        await buildEngine(index);
      } catch (_) { /* chunk failed to load — searchIndex falls back to a scan */ }
      return index;
    })();
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

/** Build (or reuse) the engine for an index that did not come from
 *  loadIndex — a test fixture, or the server's copy. */
export async function prepareSearch(index) {
  await buildEngine(index);
  return index;
}

// ------------------------------------------------------------ searching
const sevRank = { high: 0, med: 1, low: 2 };

function digitsOnly(q) {
  const s = String(q || "").trim();
  return /^[\d\s-]+$/.test(s) ? s.replace(/\D/g, "") : "";
}

/* A barcode query is answered by the barcode and nothing else: a text search
 * for "0 41220 12345 6" would prefix-match every notice with a lot number
 * starting "041", which is noise dressed up as a result. Exact key first —
 * upc.js collapses UPC-A / EAN-13 / GTIN-14 to one form — then, for a partial
 * number someone is still typing, a substring of the stored keys. */
function searchUpc(index, digits, limit) {
  const key = upcKey(digits);
  const exact = [];
  const partial = [];
  for (const r of index.recalls) {
    const upcs = r.upcs || [];
    if (!upcs.length) continue;
    if (key && upcs.includes(key)) exact.push(r);
    else if (digits.length >= 6 && upcs.some((u) => u.includes(digits))) partial.push(r);
  }
  return [...exact, ...partial].slice(0, limit);
}

function scan(index, query, limit) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return index.recalls
    .filter((r) => {
      const hay = `${r.product} ${r.firm} ${r.reason} ${CATEGORY_WORDS[r.category] || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}

/** Ranked records for a free-text or barcode query.
 *
 *  Every word has to match (prefix and a little fuzz allowed) before any
 *  single word is allowed to: "peanut butter" should not surface every butter
 *  recall ahead of the one peanut butter notice. Only when AND finds nothing
 *  does it widen to OR. Among equal matches an active recall outranks an ended
 *  one, but both are returned — see the note at the top. */
export function searchIndex(index, query, { limit = 50 } = {}) {
  const q = String(query || "").trim();
  if (!index || !Array.isArray(index.recalls) || !q) return [];

  const digits = digitsOnly(q);
  if (digits.length >= 6) return searchUpc(index, digits, limit);

  const engine = engines.get(index);
  if (!engine) return scan(index, q, limit);

  let hits = engine.search(q, { combineWith: "AND" });
  if (!hits.length) hits = engine.search(q, { combineWith: "OR" });
  return hits
    .map((h) => {
      const r = index.recalls[h.id];
      // Mild, bounded nudges: relevance still decides, these break near-ties.
      const score = h.score * (r.status === "ended" ? 0.8 : 1) * (r.severity === "high" ? 1.1 : 1);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score || String(b.r.date).localeCompare(String(a.r.date)))
    .slice(0, limit)
    .map((x) => x.r);
}

// ------------------------------------------------------------ browsing
function daysAgo(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

/* A notice title is written for a press office, not a search box: "Sempio
 * Food Services Inc. Recalls Ready-To-Eat Chicken Stew Products Imported
 * Without the Benefit of Import Reinspection". What someone would type is the
 * product, so take the words after "Recalls", stop at the first clause that
 * starts explaining, and keep it to a few words. */
function productPhrase(r) {
  // Commas inside a product name ("Raw, Frozen Pork Sausage") are lists of
  // adjectives, not clause breaks — fold them before splitting.
  let t = String(r.product || "").replace(/\s+/g, " ").replace(/,\s*/g, " ").trim();
  const m = t.match(/\brecalls?\s+(.*)$/i);
  if (m && m[1].length > 3) t = m[1];
  t = t.split(/\s(?:recalled|due to|because|that|which|for possible|for undeclared|over|after|produced|sold|distributed|imported without)\s|[;:(]|\s[-–—]\s/i)[0];
  t = t.split(/\s(?:products?|items?)(?:\s|$)/i)[0].trim();
  /* Strip the processing words that lead every USDA title — "Raw", "Not
   * Ready-To-Eat", "Imported" — while at least two words would be left, so a
   * chip reads "Pork Sausage" rather than "Raw". */
  const LEAD = /^(?:all|certain|select|some|various|not|ready-to-eat|raw|frozen|fresh|imported|ineligible|fully|cooked|uncooked|breaded|refrigerated|shelf-stable|heat-treated)\s+/i;
  while (LEAD.test(t) && t.split(" ").length > 2) t = t.replace(LEAD, "");
  const words = t.split(" ").filter(Boolean).slice(0, 5);
  while (words.length > 1 && /^(?:and|or|of|from|with|in|the|for|to|by|&)$/i.test(words[words.length - 1])) words.pop();
  return words.join(" ");
}

function firmKey(r) {
  return String(r.firm || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter(Boolean).slice(0, 2).join(" ");
}

/** A handful of recent, serious recalls to offer as one-tap searches.
 *
 *  Active and high-severity first, newest first, one per firm and one per
 *  phrase — a single company's recall is often filed as dozens of records
 *  (one per SKU), and a trending list that is five sizes of the same salsa
 *  is not a list. Widens the window, then the severity, until it has `n`. */
export function trending(index, n = 6) {
  if (!index || !Array.isArray(index.recalls)) return [];
  const out = [];
  const seenFirm = new Set();
  const seenLabel = new Set();
  const passes = [
    { days: 14, sev: ["high"] },
    { days: 45, sev: ["high"] },
    { days: 45, sev: ["high", "med"] },
    { days: 365, sev: ["high", "med", "low"] },
  ];
  for (const { days, sev } of passes) {
    const since = daysAgo(days);
    const pool = index.recalls
      .filter((r) => r.status !== "ended" && sev.includes(r.severity) && String(r.date) >= since)
      .sort((a, b) => (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1) || String(b.date).localeCompare(String(a.date)));
    for (const r of pool) {
      if (out.length >= n) return out;
      const label = productPhrase(r);
      const lk = label.toLowerCase();
      const fk = firmKey(r);
      if (!label || label.length < 3 || seenLabel.has(lk) || (fk && seenFirm.has(fk))) continue;
      seenLabel.add(lk);
      if (fk) seenFirm.add(fk);
      out.push({ label, query: label, id: r.id });
    }
  }
  return out;
}

/** Active recalls that reach the reader's area, dated within `sinceDays`,
 *  newest first. With no location, only nationwide notices qualify — every
 *  other record needs a state before it can honestly be called "yours". */
export function recentFor(index, loc, { sinceDays = 7 } = {}) {
  if (!index || !Array.isArray(index.recalls)) return [];
  const since = daysAgo(sinceDays);
  return index.recalls
    .filter((r) => r.status !== "ended" && String(r.date) >= since && indexRecordInArea(r, loc))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1));
}

/* Store aisles, in the order a shopper walks them, mapped from category.js
 * keys. Categories that are not an aisle (snacks, pantry, beverages, sports,
 * a bare "food") are left out rather than forced into the nearest one — an
 * aisle view is a way in, not a complete partition; search is complete. */
const AISLE_OF = {
  produce: "produce",
  meat: "meat", seafood: "meat",
  dairy: "dairy",
  grains: "bakery",
  kids: "baby",
  pet: "pet",
  drug: "meds", device: "meds", supplement: "meds",
  home: "home", appliance: "home", electrical: "home",
};

export function byAisle(records) {
  const out = { produce: [], meat: [], dairy: [], bakery: [], baby: [], pet: [], meds: [], home: [] };
  for (const r of records || []) {
    const aisle = AISLE_OF[r.category];
    if (aisle) out[aisle].push(r);
  }
  return out;
}

// ------------------------------------------------------------ live fallback
function fdaDate(s) {
  const t = String(s || "");
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
}

function severityFromClass(cls) {
  if (/class i{3}/i.test(cls)) return "low";
  if (/class i{2}/i.test(cls)) return "med";
  if (/class i/i.test(cls)) return "high";
  return "med";
}

/** Map one /api/lookup match into the index record shape. Exported so the
 *  mapping can be exercised without a network. */
export function lookupMatchToRecord(m) {
  const { coverage, states } = coverageFromText(m.distribution, m.source);
  const status = /ongoing|pending/i.test(m.status || "") ? "active" : "ended";
  const base = { source: m.source, product: m.product || "" };
  const rec = {
    id: m.id,
    source: m.source,
    product: m.product || "(no product description)",
    firm: m.firm || "",
    reason: m.reason || "",
    classification: m.classification || "",
    severity: severityFromClass(m.classification || ""),
    date: fdaDate(m.reportDate),
    status,
    distribution: m.distribution || "",
    states,
    coverage,
    category: categoryFor(base).key,
    reasonKey: reasonFor({ reason: m.reason, classification: m.classification }).key,
    url: "https://www.accessdata.fda.gov/scripts/ires/index.cfm",
  };
  const end = fdaDate(m.terminationDate);
  if (status === "ended" && end) rec.endDate = end;
  const upcs = upcsIn([m.codeInfo, m.product].filter(Boolean).join(" \n "));
  if (upcs.length) rec.upcs = upcs;
  return rec;
}

/** Ask openFDA directly, through /api/lookup, when the index could not.
 *
 *  For the case where `index.sources.fda.ok` is false and the index search
 *  found no FDA record: that silence means "not checked", and this checks.
 *  A barcode-shaped query goes as ?upc=, anything else as ?q=. Resolves to
 *  records in the index shape; rejects when openFDA is unreachable, so the
 *  caller can say so instead of rendering an empty list. */
export async function liveLookup(query, { timeoutMs = 15000 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const digits = digitsOnly(q);
  const qs = digits.length >= 8 ? `upc=${encodeURIComponent(digits)}` : `q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/lookup?${qs}`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return ((body && body.matches) || []).map(lookupMatchToRecord);
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("openFDA lookup timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}
