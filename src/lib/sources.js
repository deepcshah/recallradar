/* Recall data sources: openFDA enforcement (food / drug / device),
 * USDA FSIS recall API, CPSC recall API.
 *
 * Primary path: one call to /api/recalls, which fetches and normalizes all
 * five feeds server-side (with the openFDA key) and is edge-cached per
 * state — the browser downloads one small, ready-to-render payload.
 * Fallback (bare static deployments): fetch each feed directly from the
 * browser using the same normalizers. Each source degrades independently.
 *
 * Normalized recall shape:
 * {
 *   id, source, product, firm, reason, classification, severity: 'high'|'med'|'low',
 *   date: Date|null, scope: 'nationwide'|'state'|'unstated'|'elsewhere',
 *   distribution (verbatim), states: [abbr, sorted], url,
 *   status?: 'active'|'ended', endDate?: ISO string,
 *   retailerIds: [chainId], quantity, codeInfo
 * }
 *
 * The normalizers describe a notice; they no longer decide whether it belongs
 * on screen. A notice shipped to AZ, NM and TX comes back with scope
 * 'elsewhere' rather than being dropped, because "is this recall in my state?"
 * is a question the verdict sheet has to be able to answer with a no — and it
 * cannot answer about a record that was thrown away before it got there. The
 * area list's rule (nationwide, your state, or unstated-but-names-a-chain)
 * lives in one place, `isInArea` in ./verdict.js, and every consumer of these
 * lists — fetchAll's fallbacks, api/recalls.js, App.jsx — filters through it.
 */
import { chainsInText } from "./retailers.js";
import { ABBR_TO_NAME, abbrForName } from "./states.js";
import { NATIONWIDE_RE, statesIn, isInArea, AMBIGUOUS_STATE_ABBRS } from "./verdict.js";
import { FSIS_ENDPOINTS, cpscUrl } from "./feeds.js";

const DAY_MS = 86400000;
export const LOOKBACK_DAYS = 365;
export const CPSC_LOOKBACK_DAYS = 180;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Defined in ./verdict.js (so coverage and scope read text with one regex);
// re-exported here because callers already import it from this module.
export { NATIONWIDE_RE, statesIn, AMBIGUOUS_STATE_ABBRS };

/** openFDA's `meta.last_updated` ("2026-09-23") as an ISO day, or null. It is
 *  the date openFDA last refreshed that endpoint — weekly — which is what
 *  "how fresh is the FDA data" actually means; our fetch time is not. */
export function fdaLastUpdated(data) {
  const v = data && data.meta && data.meta.last_updated;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** openFDA's `meta.results.total`, or null. */
export function fdaTotal(data) {
  const v = data && data.meta && data.meta.results && data.meta.results.total;
  return Number.isFinite(v) ? v : null;
}

export function fmtFdaDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseFdaDate(s) {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
}

// `transform` slims the raw response BEFORE caching — the full FSIS/CPSC
// payloads are megabytes and would blow the sessionStorage quota.
async function cachedFetchJSON(url, { timeoutMs = 20000, transform } = {}) {
  const key = "rr-cache:" + url;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || "null");
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  } catch (_) { /* cache is best-effort */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (res.status === 404 && !url.startsWith("/api/")) return null; // openFDA returns 404 for "no matches"
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let v = await res.json();
    if (transform) v = transform(v);
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch (_) { /* quota */ }
    return v;
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

/** Where does this distribution text put the notice, relative to the reader?
 *
 * Four answers, and none of them is "drop it":
 *
 *   nationwide  the text says so
 *   state       the text names the reader's state
 *   elsewhere   the text names states, none of them the reader's
 *   unstated    the text names no geography at all
 *
 * `elsewhere` used to be null, and the notice was thrown away on the spot.
 * That was right for a list headed "your area" and wrong for everything else:
 * a reader who arrives holding a product from a headline needs to hear "sent
 * to AZ, NM, TX — California isn't listed", which is an answer, not silence.
 * So the notice is kept and labelled; `isInArea` (./verdict.js) is what keeps
 * it out of the area list.
 *
 * `unstated` is not `elsewhere`. "Sold at Trader Joe's stores" names a chain
 * and no state; that is unsaid, not somewhere else. Whether such a notice
 * earns a place in the area list (it does when the chain is one we can put on
 * a map) is also `isInArea`'s call now, not the normalizer's.
 *
 * With no location at all (the national index builds without one) a notice
 * naming states is `elsewhere` in the vacuous sense; such callers should read
 * `coverageOf` from ./verdict.js instead, which never looks at a reader.
 */
function scopeFor(text, loc) {
  const t = String(text || "");
  if (NATIONWIDE_RE.test(t)) return "nationwide";
  const named = statesIn(t);
  if (!named.length) return "unstated";
  const abbr = locAbbr(loc);
  return abbr && named.includes(abbr) ? "state" : "elsewhere";
}

function locAbbr(loc) {
  if (!loc) return null;
  if (loc.stateAbbr && ABBR_TO_NAME[String(loc.stateAbbr).toUpperCase()]) return String(loc.stateAbbr).toUpperCase();
  return abbrForName(loc.state);
}

/* Which states a notice actually covers — `statesIn`, now in ./verdict.js.
 * Recalls are usually regional — one supplier ships to one of a chain's
 * distribution centers — so "Kroger" in a notice does not mean every Kroger
 * in the country. An empty array means the text named no state (nationwide,
 * or simply unstated). */

function severityFromFdaClass(cls) {
  if (/class i{3}/i.test(cls)) return "low";
  if (/class i{2}/i.test(cls)) return "med";
  if (/class i/i.test(cls)) return "high";
  return "med";
}

function retailerIdsFor(...texts) {
  return chainsInText(texts.filter(Boolean).join(" \n ")).map((c) => c.id);
}

/* openFDA's own lifecycle field. The area query asks for "Ongoing" only, so
 * this is mostly 'active' there; it matters for the national index and for
 * /api/lookup, which deliberately include finished recalls. "Pending" is a
 * recall not yet classified, which is still very much live. Absent stays
 * absent — no status is not the same claim as either answer. */
function fdaStatus(r) {
  const s = String(r.status || "").trim();
  if (/^(completed|terminated)$/i.test(s)) return "ended";
  if (/^(ongoing|pending)$/i.test(s)) return "active";
  return undefined;
}

function isoDay(d) {
  return d && !isNaN(d) ? d.toISOString().slice(0, 10) : undefined;
}

// ------------------------------------------------------------- normalizers
// Pure data -> recalls transforms, shared verbatim by api/recalls.js.
// `loc` may be null (the national index builds without a reader).

export function normalizeFda(kind, results, loc) {
  const label = { food: "FDA Food", drug: "FDA Drug", device: "FDA Device" }[kind];
  return (results || [])
    .map((r) => {
      const scope = scopeFor(r.distribution_pattern, loc);
      /* Every notice survives, including one naming only other states and one
       * naming no state and no chain. The area list's rule — an unstated
       * notice must name a chain we can map — is applied by isInArea against
       * `retailerIds` below, which is empty for exactly the notices it drops. */
      const retailerIds = retailerIdsFor(
        r.distribution_pattern, r.product_description, r.reason_for_recall, r.recalling_firm);
      const status = fdaStatus(r);
      const endDate = status === "ended" ? isoDay(parseFdaDate(r.termination_date)) : undefined;
      return {
        id: `fda-${kind}-${r.recall_number || r.event_id || Math.random().toString(36).slice(2)}`,
        source: label,
        product: r.product_description || "(no product description)",
        firm: r.recalling_firm || "",
        reason: r.reason_for_recall || "",
        classification: r.classification || "",
        severity: severityFromFdaClass(r.classification || ""),
        date: parseFdaDate(r.recall_initiation_date) || parseFdaDate(r.report_date),
        /* When FDA published it (the enforcement report): usually weeks after
         * the firm started the recall, and the day it reaches the news. What
         * counts as "new" (digest.js newsDay) reads this; the card shows `date`. */
        ...(isoDay(parseFdaDate(r.report_date)) ? { posted: isoDay(parseFdaDate(r.report_date)) } : null),
        scope,
        distribution: r.distribution_pattern || "",
        // Named states for `state` AND `elsewhere` — the verdict's "sent to
        // AZ, NM, TX" is read from here. Nationwide/unstated name none.
        states: scope === "state" || scope === "elsewhere" ? statesIn(r.distribution_pattern) : [],
        ...(status ? { status } : null),
        ...(endDate ? { endDate } : null),
        url: "https://www.accessdata.fda.gov/scripts/ires/index.cfm", // FDA IRES recall search
        searchHint: r.recall_number || "",
        retailerIds,
        quantity: r.product_quantity || "",
        codeInfo: r.code_info || "",
      };
    });
}

/* ─────────────────────────────────────────────────────────────────────────
 * FSIS GEOGRAPHY — an empty list is not "nationwide"
 *
 * `field_states` arrives as an array of full state names in the committed
 * snapshot (["California", "Nevada"], ["Nationwide"]) and may arrive as one
 * comma-separated string from older caches; both are read.
 *
 * It used to be that an empty or missing field meant nationwide. That is the
 * same flattening the README forbids for FDA's "Sold at Trader Joe's": USDA
 * said nothing, and we reported the widest possible claim on its behalf. An
 * empty field is now `unstated`, with the distribution text "Region not
 * stated"; only an explicit "Nationwide" is nationwide.
 *
 * USDA also writes regions — "Midwest" turns up in the live feed. Those are
 * expanded with the Census Bureau's definitions, which is an interpretation,
 * so the verbatim entry stays in `distribution` for the verdict's evidence
 * line. A token matching nothing at all is left in the text and contributes
 * no state; a notice made only of those reads as unstated.
 * ───────────────────────────────────────────────────────────────────────── */
const CENSUS_REGIONS = {
  "midwest": ["IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI"],
  "northeast": ["CT", "ME", "MA", "NH", "RI", "VT", "NJ", "NY", "PA"],
  "new england": ["CT", "ME", "MA", "NH", "RI", "VT"],
  "south": ["DE", "DC", "FL", "GA", "MD", "NC", "SC", "VA", "WV", "AL", "KY", "MS", "TN", "AR", "LA", "OK", "TX"],
  "west": ["AZ", "CO", "ID", "MT", "NV", "NM", "UT", "WY", "AK", "CA", "HI", "OR", "WA"],
  "pacific northwest": ["ID", "OR", "WA"],
};

/** Exported for scripts/build-index.mjs, so the index reads USDA's states
 *  field exactly as the area list does (regions expanded, empty = unstated). */
export function fsisGeography(field) {
  const tokens = (Array.isArray(field) ? field : String(field || "").split(/[,;]/))
    .map((x) => String(x == null ? "" : x).trim())
    .filter(Boolean);
  if (!tokens.length) return { kind: "unstated", states: [], text: "Region not stated" };
  const text = tokens.join(", ");
  if (tokens.some((x) => /nation\s?wide/i.test(x))) return { kind: "nationwide", states: [], text };
  const found = new Set();
  for (const x of tokens) {
    const up = x.toUpperCase();
    const abbr = abbrForName(x) || (/^[A-Z]{2}$/.test(up) && ABBR_TO_NAME[up] ? up : null);
    if (abbr) { found.add(abbr); continue; }
    const region = CENSUS_REGIONS[x.toLowerCase()];
    if (region) { region.forEach((a) => found.add(a)); continue; }
    statesIn(x).forEach((a) => found.add(a));
  }
  const states = [...found].sort();
  return states.length ? { kind: "states", states, text } : { kind: "unstated", states: [], text };
}

export function normalizeFsis(list, loc) {
  const cutoff = Date.now() - FSIS_LOOKBACK_DAYS * DAY_MS; // active notices can be older
  const abbr = locAbbr(loc);
  return (list || [])
    .map((r) => {
      const geo = fsisGeography(r.field_states);
      const scope = geo.kind === "nationwide" ? "nationwide"
        : geo.kind === "unstated" ? "unstated"
        : abbr && geo.states.includes(abbr) ? "state" : "elsewhere";

      const date = r.field_recall_date ? new Date(r.field_recall_date) : null;
      if (date && !isNaN(date) && date.getTime() < cutoff) return null;

      const risk = String(r.field_risk_level || "");
      const severity = /high/i.test(risk) ? "high" : /low|marginal/i.test(risk) ? "low" : "med";
      // true / false / null — see fsisActiveFlag. Only an explicit false is
      // ever shown to the reader as "Closed". It becomes status 'ended' only
      // past FSIS_TRUST_CLOSED_DAYS (see fsisStatus), the same rule as the
      // national index. USDA publishes no closing date in the slim feed, so
      // no endDate.
      const active = fsisActiveFlag(r);
      const status = fsisStatus(r.field_active_notice, r.field_recall_date);
      const urlPath = String(r.field_recall_url || "");
      return {
        id: `fsis-${r.field_recall_number || urlPath || Math.random().toString(36).slice(2)}`,
        source: "USDA FSIS",
        active,
        ...(status == null ? null : { status }),
        product: r.field_title || r.field_product_items || "(untitled FSIS recall)",
        firm: r.field_establishment || "",
        reason: [r.field_recall_reason, r.field_recall_classification].filter(Boolean).join(" — "),
        classification: risk || r.field_recall_classification || "",
        severity,
        date: date && !isNaN(date) ? date : null,
        scope,
        distribution: geo.text,
        states: geo.states,
        url: urlPath
          ? (urlPath.startsWith("http") ? urlPath : "https://www.fsis.usda.gov" + urlPath)
          : "https://www.fsis.usda.gov/recalls",
        retailerIds: retailerIdsFor(r.field_title, r.field_summary, r.field_product_items),
        quantity: r.field_qty_recovered || "",
        codeInfo: "",
      };
    })
    .filter(Boolean);
}

export function normalizeCpsc(list) {
  return (list || []).map((r) => {
    const products = (r.Products || []).map((p) => p.Name).filter(Boolean);
    const hazards = (r.Hazards || []).map((h) => h.Name).filter(Boolean);
    const retailerNames = (r.Retailers || []).map((x) => (x && x.Name) || "").join(", ");
    const soldAt = r.SoldAtLabel || "";
    const manufacturers = (r.Manufacturers || []).map((m) => m.Name).filter(Boolean);
    return {
      id: `cpsc-${r.RecallID || r.RecallNumber || Math.random().toString(36).slice(2)}`,
      source: "CPSC",
      product: r.Title || products.join("; ") || "(untitled CPSC recall)",
      firm: manufacturers.join(", "),
      reason: hazards.join("; ") || (r.Description || "").slice(0, 300),
      classification: "",
      severity: "med", // CPSC does not classify; treat as noteworthy
      date: r.RecallDate ? new Date(r.RecallDate) : null,
      scope: "nationwide", // CPSC recalls are national
      states: [],
      distribution: [retailerNames, soldAt].filter(Boolean).join(" · ") || "Nationwide (consumer product)",
      url: r.URL || "https://www.cpsc.gov/Recalls",
      image: r.Image || "",
      retailerIds: retailerIdsFor(retailerNames, soldAt, r.Description, r.Title),
      quantity: "",
      codeInfo: "",
    };
  });
}

/** Sort in place: severity first, then newest. Handles Date or ISO string. */
export function sortRecalls(recalls) {
  const sevRank = { high: 0, med: 1, low: 2 };
  const t = (d) => (d ? new Date(d).getTime() : 0);
  recalls.sort((a, b) => {
    const s = (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1);
    if (s) return s;
    return t(b.date) - t(a.date);
  });
  return recalls;
}

/* ─────────────────────────────────────────────────────────────────────────
 * WHICH USDA NOTICES SURVIVE INTO THE SLIM FEED
 *
 * `field_active_notice === "true"` used to be the whole test, and it is why
 * the first committed snapshot arrived holding exactly one recall: 1.5 KB of
 * USDA sitting next to 393 KB of CPSC, on a run where USDA had answered 200.
 * The fetch was never the problem on that run — the filter was.
 *
 * A single equality test against somebody else's field is a cliff. Nothing
 * throws when the value drifts; the feed just quietly empties, and every tier
 * empties together, because all four of them — the live server fetch, the Blob
 * warm, the /api/fsis proxy and the committed snapshot — slim through this one
 * function. That is a lot of redundancy defeated by one string comparison.
 *
 * So the flag is now one of two ways in rather than the only one. An active
 * notice is kept at any age, exactly as before, which makes this a superset of
 * the old behaviour: it cannot show less than it did. A closed one is kept
 * while it is recent enough that the product could still be in somebody's
 * freezer, which is the whole reason a shopper is reading this.
 *
 * What it must not do is pass a closed recall off as a live one. The flag
 * rides along on every slimmed record, `normalizeFsis` turns it into `active`,
 * and the card prints a "Closed" chip. Absent is not false: a snapshot written
 * before this change carries no flag at all, and those records are left
 * unlabelled rather than libelled as closed.
 * ───────────────────────────────────────────────────────────────────────── */
export const FSIS_LOOKBACK_DAYS = LOOKBACK_DAYS * 2;
export const FSIS_CLOSED_LOOKBACK_DAYS = 365;

/** FSIS sends the string "True" today. Accepting the obvious neighbours costs
 *  nothing and means a change of casing or type is not an outage. */
export function fsisIsActive(v) {
  return /^(true|1|yes|active)$/i.test(String(v == null ? "" : v).trim());
}

/** null when the record does not say, so "unknown" stays distinct from "closed". */
function fsisActiveFlag(r) {
  return r.field_active_notice == null ? null : fsisIsActive(r.field_active_notice);
}

/* When a USDA notice's "not active" flag is believed as the recall having
 * ENDED — the status that becomes the verdict headline "This recall has
 * ended".
 *
 * The first national index built from a real snapshot had 51 of 54 USDA
 * notices flagged "False", including a Class I pork recall issued three days
 * earlier. Whatever `field_active_notice` tracks on a fresh notice, it is not
 * the recall's lifecycle. So an explicit "False" only becomes status 'ended'
 * once the notice is older than this; before that it stays 'active'. Wrong in
 * that direction costs a reader a look in the freezer; wrong in the other
 * tells them to eat the sausage.
 *
 * This lives here, and scripts/build-index.mjs imports it, because the area
 * list (normalizeFsis), the national index, search, share cards and push must
 * give one recall one answer. They used to disagree: the digest said a
 * three-day-old notice "has ended" while search said "Not reported in Texas".
 * The raw flag still rides along as `active`, so the area list's "Closed"
 * chip — which says only that USDA stopped tracking it — is unchanged.
 * (slimFsis keeps no closed-date field; if it ever does, that should replace
 * this age test.) */
export const FSIS_TRUST_CLOSED_DAYS = 90;

/** 'ended' | 'active' | null (the notice carries no flag at all). */
export function fsisStatus(flagValue, recallDate, now = Date.now()) {
  if (flagValue == null) return null;
  if (fsisIsActive(flagValue)) return "active";
  const age = (now - Date.parse(recallDate)) / DAY_MS;
  return Number.isFinite(age) && age > FSIS_TRUST_CLOSED_DAYS ? "ended" : "active";
}

// Shared with api/fsis.js and api/cpsc.js — keep the shapes in sync.
export function slimFsis(raw) {
  const all = Array.isArray(raw) ? raw : (raw && raw.results) || [];
  const closedCutoff = Date.now() - FSIS_CLOSED_LOOKBACK_DAYS * DAY_MS;
  return all
    .filter((r) => {
      if (fsisIsActive(r.field_active_notice)) return true;
      const t = Date.parse(r.field_recall_date);
      return Number.isFinite(t) && t >= closedCutoff;
    })
    .map((r) => ({
      // Normalised to the two strings this app writes, so a snapshot is
      // readable without knowing what USDA happened to send that day — but a
      // record that carried no flag keeps carrying none. Stamping those
      // "False" would be inventing a closure USDA never reported.
      ...(r.field_active_notice == null
        ? null
        : { field_active_notice: fsisIsActive(r.field_active_notice) ? "True" : "False" }),
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
}

export function slimCpsc(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
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
}

/** The geography half of the state-scoped openFDA query.
 *
 *  openFDA's text search is case-insensitive, so for a code that is also a
 *  word (IN, OR, ME, … — AMBIGUOUS_STATE_ABBRS in ./verdict.js) the clause
 *  `distribution_pattern:"IN"` matches the word "in" and returns almost every
 *  notice, the newest few hundred crowd out the rest, and an Indiana reader
 *  loses older in-state recalls to truncation. For those codes only the full
 *  name is queried; the abbreviation is found by the unscoped pass (see
 *  api/recalls.js) and the case-sensitive statesIn/scopeFor post-filter. The
 *  full name is always queried, even when the caller passed only a code. */
export function fdaDistributionClause(loc) {
  const abbr = locAbbr(loc);
  const name = (abbr && ABBR_TO_NAME[abbr]) || (loc && loc.state) || null;
  const parts = [`distribution_pattern:"nationwide"`];
  if (abbr && !AMBIGUOUS_STATE_ABBRS.has(abbr)) parts.push(`distribution_pattern:"${abbr}"`);
  if (name) parts.push(`distribution_pattern:"${name}"`);
  return `(${parts.join("+OR+")})`;
}

/** True when this location's abbreviation is not queried (see above), so the
 *  unscoped pass is what finds notices that list only the code. */
export function needsUnscopedDepth(loc) {
  const abbr = locAbbr(loc);
  return !!abbr && AMBIGUOUS_STATE_ABBRS.has(abbr);
}

export function fdaSearchQuery(loc) {
  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  return (
    `status:"Ongoing"+AND+report_date:[${fmtFdaDate(start)}+TO+${fmtFdaDate(now)}]` +
    `+AND+${fdaDistributionClause(loc || {})}`
  );
}

/** Active notices in the lookback window, with no geography clause — the
 *  pass that catches notices naming a retailer and no state. */
export function unscopedSearchQuery() {
  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  return `status:"Ongoing"+AND+report_date:[${fmtFdaDate(start)}+TO+${fmtFdaDate(now)}]`;
}

// --------------------------------------------------- browser fallback path
async function fetchOpenFdaDirect(kind, loc) {
  const url =
    `https://api.fda.gov/${kind}/enforcement.json?search=${fdaSearchQuery(loc).replace(/ /g, "+")}` +
    `&sort=report_date:desc&limit=100`;
  const data = await cachedFetchJSON(url);
  const results = (data && data.results) || [];
  const total = fdaTotal(data);
  return {
    recalls: normalizeFda(kind, results, loc),
    lastUpdated: fdaLastUpdated(data),
    truncated: total != null && total > results.length,
  };
}

/** FSIS straight from the browser: a different IP on a different network from
 *  the serverless function, which USDA's WAF blocks outright. Throws if the
 *  browser is blocked too, or if CORS forbids reading the response. */
export async function fsisFromBrowser(loc) {
  const list = await cachedFetchJSON(FSIS_ENDPOINTS[0], { timeoutMs: 12000, transform: slimFsis });
  return normalizeFsis(list || [], loc);
}

async function fetchFsisDirect(loc) {
  try {
    return await fsisFromBrowser(loc);
  } catch (_) {
    // proxy returns pre-slimmed data
    return normalizeFsis((await cachedFetchJSON("/api/fsis", { timeoutMs: 30000 })) || [], loc);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE COMMITTED SNAPSHOT — the tier that cannot be blocked
 *
 * `public/feeds/*.json` is written by a GitHub Action (see
 * scripts/refresh-feeds.mjs) and committed to the repository, so it ships with
 * the deployment as a static asset served off the CDN.
 *
 * That is what makes it different in kind from every other fallback here.
 * The live fetch, the retry loop and the Blob cache all ultimately depend on
 * USDA answering *this deployment* at some point; if it never does, they are
 * all empty together. The snapshot was fetched from somewhere else entirely,
 * by a different machine on a different network, before the user ever arrived.
 * Nothing USDA decides about this app's egress can take it away.
 *
 * The cost is honesty about age, which is why it carries `fetchedAt` and the
 * UI prints it. A three-hour-old list of meat recalls is worth enormously more
 * than an empty panel labelled "unavailable"; a three-hour-old list presented
 * as live is worth less than nothing.
 * ───────────────────────────────────────────────────────────────────────── */
async function readSnapshot(name) {
  const snap = await cachedFetchJSON(`/feeds/${name}.json`, { timeoutMs: 8000 });
  if (!snap || !Array.isArray(snap.notices) || !snap.notices.length) return null;
  return snap;
}

function snapshotAge(fetchedAt) {
  const t = new Date(fetchedAt).getTime();
  if (!Number.isFinite(t)) return "at an unknown time";
  const hours = Math.floor((Date.now() - t) / 3600000);
  if (hours < 1) return "less than an hour ago";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Recover the sources /api/recalls could not reach, from wherever we still
 *  can. Two ladders, tried in order of freshness:
 *
 *    USDA FSIS — the browser first, because it is a different client on a
 *                different network and may simply not be blocked; then the
 *                committed snapshot.
 *    CPSC      — the snapshot only. saferproducts.gov is slow rather than
 *                hostile, and a browser that waits 30s for it has already
 *                lost; the snapshot is instant and a few hours old at worst.
 *
 *  Resolves to null when there is nothing to add, so the caller can skip the
 *  state update entirely. */
export async function recoverBlockedSources(loc, sources) {
  const list = sources || [];
  const targets = [
    {
      match: (n) => n.startsWith("USDA FSIS"),
      recover: async () => {
        try {
          return {
            recalls: await fsisFromBrowser(loc),
            note: "USDA would not answer our server, so your browser fetched this directly.",
          };
        } catch (_) { /* blocked here too, or CORS — fall through to the snapshot */ }
        const snap = await readSnapshot("fsis");
        if (!snap) return null;
        return {
          recalls: normalizeFsis(snap.notices, loc),
          note: `USDA would not answer our server or your browser — showing the snapshot saved ${snapshotAge(snap.fetchedAt)}.`,
        };
      },
    },
    {
      match: (n) => n.startsWith("CPSC"),
      recover: async () => {
        const snap = await readSnapshot("cpsc");
        if (!snap) return null;
        return {
          recalls: normalizeCpsc(snap.notices),
          note: `CPSC did not answer in time — showing the snapshot saved ${snapshotAge(snap.fetchedAt)}.`,
        };
      },
    },
  ];

  const jobs = targets
    .map((t) => ({ t, i: list.findIndex((s) => t.match(s.name)) }))
    .filter(({ i }) => i !== -1 && !list[i].ok);
  if (!jobs.length) return null;

  // Recovered lists feed the area list and its counts, so they go through the
  // same isInArea gate as /api/recalls — an 'elsewhere' FSIS notice must not
  // arrive late through the back door.
  const settled = await Promise.all(jobs.map(({ t }) => t.recover()
    .then((got) => got && { ...got, recalls: got.recalls.filter((r) => isInArea(r, loc)) })
    .catch(() => null)));

  const next = list.slice();
  const recalls = [];
  const names = [];
  settled.forEach((got, k) => {
    if (!got || !got.recalls.length) return;
    const { i } = jobs[k];
    next[i] = { name: list[i].name, ok: true, count: got.recalls.length, note: got.note };
    recalls.push(...got.recalls);
    names.push(list[i].name.replace(/\s*\([^)]*\)\s*$/, ""));
  });

  return recalls.length ? { recalls, sources: next, names } : null;
}

async function fetchCpscDirect() {
  let list;
  try {
    list = await cachedFetchJSON(cpscUrl(CPSC_LOOKBACK_DAYS), { timeoutMs: 30000, transform: slimCpsc });
  } catch (_) {
    // The proxy returns pre-slimmed data, and falls back to its own cached
    // copy — so this path can still answer when saferproducts.gov cannot.
    list = await cachedFetchJSON("/api/cpsc", { timeoutMs: 30000 });
  }
  return normalizeCpsc(list || []);
}

async function clientFetchAll(loc) {
  const jobs = [
    { name: "FDA Food enforcement", fn: () => fetchOpenFdaDirect("food", loc) },
    { name: "FDA Drug enforcement", fn: () => fetchOpenFdaDirect("drug", loc) },
    { name: "FDA Device enforcement", fn: () => fetchOpenFdaDirect("device", loc) },
    { name: "USDA FSIS (meat, poultry, egg)", fn: () => fetchFsisDirect(loc) },
    { name: "CPSC consumer products", fn: () => fetchCpscDirect() },
  ];

  // Filtered before counting, so a source's count means what it always
  // meant: notices covering your area. See isInArea in ./verdict.js.
  const fetchedAt = new Date().toISOString();
  const settled = await Promise.allSettled(
    jobs.map((j) => j.fn().then((got) => {
      const meta = Array.isArray(got) ? {} : got;
      const list = (Array.isArray(got) ? got : got.recalls).filter((r) => isInArea(r, loc));
      return { list, meta };
    })));
  const recalls = [];
  const sources = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      const { list, meta } = s.value;
      recalls.push(...list);
      return {
        name: jobs[i].name, ok: true, count: list.length, fetchedAt,
        ...(meta.lastUpdated ? { lastUpdated: meta.lastUpdated } : null),
        ...(meta.truncated ? { truncated: true } : null),
      };
    }
    return { name: jobs[i].name, ok: false, error: s.reason && s.reason.message ? s.reason.message : "failed" };
  });

  return { recalls: sortRecalls(recalls), sources };
}

/**
 * Fetch every source for a location. Returns:
 * { recalls: [...normalized, sorted],
 *   sources: [{name, ok, count, error?, note?, fetchedAt?, lastUpdated?,
 *              newest?, truncated?, oldest?}] }
 * FDA sources carry openFDA's `lastUpdated`; `truncated: true` means only the
 * newest notices were fetched (back to `oldest`). See freshnessOf in
 * ./search-index.js for turning these into "as of" lines.
 */
export async function fetchAll(loc) {
  try {
    const qs = new URLSearchParams();
    if (loc.state) qs.set("state", loc.state);
    if (loc.stateAbbr) qs.set("abbr", loc.stateAbbr);
    const data = await cachedFetchJSON(`/api/recalls?${qs}`, { timeoutMs: 30000 });
    if (!data || !Array.isArray(data.recalls)) throw new Error("bad payload");
    return {
      recalls: data.recalls.map((r) => ({ ...r, date: r.date ? new Date(r.date) : null })),
      sources: data.sources || [],
    };
  } catch (_) {
    return clientFetchAll(loc); // bare static deployment, or the API is down
  }
}

/**
 * The All US list: every active notice, wherever it went (`/api/recalls?scope=us`).
 * Same shape as fetchAll. Resolves to null on any failure — never throws — so
 * the caller falls back to the national index and says which list it is
 * reading. There is no browser fallback: querying all three openFDA kinds
 * unscoped from a phone is exactly the request the server exists to cache.
 */
export async function fetchNational() {
  try {
    const data = await cachedFetchJSON("/api/recalls?scope=us", { timeoutMs: 30000 });
    if (!data || !Array.isArray(data.recalls)) return null;
    return {
      recalls: data.recalls.map((r) => ({ ...r, date: r.date ? new Date(r.date) : null })),
      sources: data.sources || [],
    };
  } catch (_) {
    return null;
  }
}
