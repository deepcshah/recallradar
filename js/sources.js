/* Recall data sources: openFDA enforcement (food / drug / device),
 * USDA FSIS recall API, CPSC recall API.
 *
 * Everything is fetched client-side from public, key-less APIs. Each source
 * degrades independently: a failed feed is reported in the UI, not fatal.
 *
 * Normalized recall shape:
 * {
 *   id, source, product, firm, reason, classification, severity: 'high'|'med'|'low',
 *   date: Date|null, scope: 'nationwide'|'state', distribution, url,
 *   retailerIds: [chainId], quantity, codeInfo
 * }
 */
(function () {
  "use strict";

  const DAY_MS = 86400000;
  const LOOKBACK_DAYS = 365;
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

  async function cachedFetchJSON(url, { timeoutMs = 20000 } = {}) {
    const key = "rr-cache:" + url;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    } catch (_) { /* cache is best-effort */ }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (res.status === 404) return null; // openFDA returns 404 for "no matches"
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = await res.json();
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch (_) { /* quota */ }
      return v;
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
    const found = window.RRRetailers.chainsInText(texts.filter(Boolean).join(" \n "));
    return found.map((c) => c.id);
  }

  // ---------------------------------------------------------------- openFDA
  async function fetchOpenFda(kind, loc) {
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

    const data = await cachedFetchJSON(url.replace(/ /g, "+"));
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
    const data = await cachedFetchJSON("https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json");
    const list = Array.isArray(data) ? data : (data && data.results) || [];
    const cutoff = Date.now() - LOOKBACK_DAYS * 2 * DAY_MS; // active notices can be older

    return list
      .filter((r) => String(r.field_active_notice).toLowerCase() === "true")
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
  async function fetchCpsc(loc) {
    const start = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
    const url = `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${start}`;
    const data = await cachedFetchJSON(url, { timeoutMs: 30000 });
    const list = Array.isArray(data) ? data : [];

    return list.map((r) => {
      const products = (r.Products || []).map((p) => p.Name).filter(Boolean);
      const hazards = (r.Hazards || []).map((h) => h.Name || h.HazardType).filter(Boolean);
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
   * { recalls: [...normalized, deduped, sorted], sources: [{name, ok, count, error}] }
   */
  async function fetchAll(loc) {
    const jobs = [
      { name: "FDA Food enforcement", fn: () => fetchOpenFda("food", loc) },
      { name: "FDA Drug enforcement", fn: () => fetchOpenFda("drug", loc) },
      { name: "FDA Device enforcement", fn: () => fetchOpenFda("device", loc) },
      { name: "USDA FSIS (meat, poultry, egg)", fn: () => fetchFsis(loc) },
      { name: "CPSC consumer products", fn: () => fetchCpsc(loc) },
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

  window.RRSources = { fetchAll };
})();
