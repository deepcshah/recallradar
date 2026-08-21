/* Recall data sources: openFDA enforcement (food / drug / device),
 * USDA FSIS recall API, CPSC recall API.
 *
 * Fetched client-side from public, key-less APIs; the FSIS and CPSC feeds
 * fall back to same-origin serverless proxies (/api/fsis, /api/cpsc) when
 * the direct request fails (e.g. CORS). Each source degrades independently.
 *
 * Normalized recall shape:
 * {
 *   id, source, product, firm, reason, classification, severity: 'high'|'med'|'low',
 *   date: Date|null, scope: 'nationwide'|'state', distribution, url,
 *   retailerIds: [chainId], quantity, codeInfo
 * }
 */
import { chainsInText } from "./retailers.js";

const DAY_MS = 86400000;
const LOOKBACK_DAYS = 365;
export const CPSC_LOOKBACK_DAYS = 180;
const CACHE_TTL_MS = 30 * 60 * 1000;

const NATIONWIDE_RE =
  /nation\s?wide|national distribution|throughout the (?:u\.?s|united states)|all (?:50 )?(?:u\.?s\.? )?states|across the (?:u\.?s|united states)|(?:^|\W)usa?(?:\W|$)|worldwide|international/i;

function fmtFdaDate(d) {
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

/** Does this distribution text cover the user's state? */
function scopeFor(text, stateName, stateAbbr) {
  const t = String(text || "");
  if (NATIONWIDE_RE.test(t)) return "nationwide";
  if (stateAbbr && new RegExp(`(^|[^A-Za-z])${stateAbbr}([^A-Za-z]|$)`).test(t)) return "state";
  if (stateName && new RegExp(`(^|[^A-Za-z])${stateName}([^A-Za-z]|$)`, "i").test(t)) return "state";
  return null;
}

function severityFromFdaClass(cls) {
  if (/class i{3}/i.test(cls)) return "low";
  if (/class i{2}/i.test(cls)) return "med";
  if (/class i/i.test(cls)) return "high";
  return "med";
}

function retailerIdsFor(...texts) {
  return chainsInText(texts.filter(Boolean).join(" \n ")).map((c) => c.id);
}

// Shared with api/fsis.js and api/cpsc.js — keep the shapes in sync.
export function slimFsis(raw) {
  const all = Array.isArray(raw) ? raw : (raw && raw.results) || [];
  return all
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
}

export function slimCpsc(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
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

// ---------------------------------------------------------------- openFDA
async function fetchOpenFda(kind, loc) {
  // Proxy first: /api/fda attaches the server-side API key (higher quota)
  // and is edge-cached per kind+state. Direct keyless call is the fallback
  // for bare static deployments.
  let data;
  try {
    const qs = new URLSearchParams({ kind });
    if (loc.state) qs.set("state", loc.state);
    if (loc.stateAbbr) qs.set("abbr", loc.stateAbbr);
    data = await cachedFetchJSON(`/api/fda?${qs}`);
  } catch (_) {
    const now = new Date();
    const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
    const parts = [`distribution_pattern:"nationwide"`];
    if (loc.stateAbbr) parts.push(`distribution_pattern:"${loc.stateAbbr}"`);
    if (loc.state) parts.push(`distribution_pattern:"${loc.state}"`);
    const search =
      `status:"Ongoing"+AND+report_date:[${fmtFdaDate(start)}+TO+${fmtFdaDate(now)}]` +
      `+AND+(${parts.join("+OR+")})`;
    const url =
      `https://api.fda.gov/${kind}/enforcement.json?search=${search}` +
      `&sort=report_date:desc&limit=100`;
    data = await cachedFetchJSON(url.replace(/ /g, "+"));
  }
  const results = (data && data.results) || [];
  const label = { food: "FDA Food", drug: "FDA Drug", device: "FDA Device" }[kind];

  return results
    .map((r) => {
      const scope = scopeFor(r.distribution_pattern, loc.state, loc.stateAbbr);
      if (!scope) return null; // matched on a token we don't trust; skip
      return {
        id: `fda-${kind}-${r.recall_number || r.event_id || Math.random().toString(36).slice(2)}`,
        source: label,
        product: r.product_description || "(no product description)",
        firm: r.recalling_firm || "",
        reason: r.reason_for_recall || "",
        classification: r.classification || "",
        severity: severityFromFdaClass(r.classification || ""),
        date: parseFdaDate(r.recall_initiation_date) || parseFdaDate(r.report_date),
        scope,
        distribution: r.distribution_pattern || "",
        url: "https://www.accessdata.fda.gov/scripts/ires/index.cfm", // FDA IRES recall search
        searchHint: r.recall_number || "",
        retailerIds: retailerIdsFor(r.distribution_pattern, r.product_description, r.reason_for_recall, r.recalling_firm),
        quantity: r.product_quantity || "",
        codeInfo: r.code_info || "",
      };
    })
    .filter(Boolean);
}

// -------------------------------------------------------------- USDA FSIS
async function fetchFsis(loc) {
  let list;
  try {
    list = await cachedFetchJSON("https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json", {
      timeoutMs: 30000,
      transform: slimFsis,
    });
  } catch (_) {
    list = await cachedFetchJSON("/api/fsis", { timeoutMs: 30000 }); // proxy returns pre-slimmed data
  }
  list = list || [];
  const cutoff = Date.now() - LOOKBACK_DAYS * 2 * DAY_MS; // active notices can be older

  return list
    .map((r) => {
      const states = String(r.field_states || "");
      let scope = null;
      if (/nationwide/i.test(states) || states.trim() === "") scope = "nationwide";
      else if (loc.state && new RegExp(`(^|,\\s*)${loc.state}(\\s*,|$)`, "i").test(states)) scope = "state";
      if (!scope) return null;

      const date = r.field_recall_date ? new Date(r.field_recall_date) : null;
      if (date && !isNaN(date) && date.getTime() < cutoff) return null;

      const risk = String(r.field_risk_level || "");
      const severity = /high/i.test(risk) ? "high" : /low|marginal/i.test(risk) ? "low" : "med";
      const urlPath = String(r.field_recall_url || "");
      return {
        id: `fsis-${r.field_recall_number || urlPath || Math.random().toString(36).slice(2)}`,
        source: "USDA FSIS",
        product: r.field_title || r.field_product_items || "(untitled FSIS recall)",
        firm: r.field_establishment || "",
        reason: [r.field_recall_reason, r.field_recall_classification].filter(Boolean).join(" — "),
        classification: risk || r.field_recall_classification || "",
        severity,
        date: date && !isNaN(date) ? date : null,
        scope,
        distribution: states || "Nationwide",
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

// ------------------------------------------------------------------- CPSC
async function fetchCpsc() {
  const start = new Date(Date.now() - CPSC_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  let list;
  try {
    list = await cachedFetchJSON(
      `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${start}`,
      { timeoutMs: 30000, transform: slimCpsc }
    );
  } catch (_) {
    list = await cachedFetchJSON("/api/cpsc", { timeoutMs: 30000 }); // proxy returns pre-slimmed data
  }
  list = list || [];

  return list.map((r) => {
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
      distribution: [retailerNames, soldAt].filter(Boolean).join(" · ") || "Nationwide (consumer product)",
      url: r.URL || "https://www.cpsc.gov/Recalls",
      retailerIds: retailerIdsFor(retailerNames, soldAt, r.Description, r.Title),
      quantity: "",
      codeInfo: "",
    };
  });
}

/**
 * Fetch every source for a location. Returns:
 * { recalls: [...normalized, sorted], sources: [{name, ok, count, error}] }
 */
export async function fetchAll(loc) {
  const jobs = [
    { name: "FDA Food enforcement", fn: () => fetchOpenFda("food", loc) },
    { name: "FDA Drug enforcement", fn: () => fetchOpenFda("drug", loc) },
    { name: "FDA Device enforcement", fn: () => fetchOpenFda("device", loc) },
    { name: "USDA FSIS (meat, poultry, egg)", fn: () => fetchFsis(loc) },
    { name: "CPSC consumer products", fn: () => fetchCpsc() },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.fn()));
  const recalls = [];
  const sources = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      recalls.push(...s.value);
      return { name: jobs[i].name, ok: true, count: s.value.length };
    }
    return { name: jobs[i].name, ok: false, error: s.reason && s.reason.message ? s.reason.message : "failed" };
  });

  // Sort: severity first, then newest.
  const sevRank = { high: 0, med: 1, low: 2 };
  recalls.sort((a, b) => {
    const s = (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1);
    if (s) return s;
    return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
  });

  return { recalls, sources };
}
