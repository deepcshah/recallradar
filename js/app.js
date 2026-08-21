/* App orchestration: location -> recalls -> retailer extraction -> nearby stores. */
(function () {
  "use strict";

  const { $, setStatus } = window.RRUI;

  const state = {
    loc: null,          // {lat, lon, label, state, stateAbbr}
    recalls: [],        // normalized, sorted
    sources: [],
    stores: [],
    filterText: "",
    activeSources: new Set(),
    limit: 25,
  };

  // ------------------------------------------------------------- location
  async function useGeolocation() {
    const btn = $("#btn-geolocate");
    btn.disabled = true;
    setStatus("#locator-status", "Locating you…", { busy: true });
    try {
      const pos = await window.RRGeo.browserPosition();
      setStatus("#locator-status", "Looking up your area…", { busy: true });
      let loc;
      try {
        loc = await window.RRGeo.reverseGeocode(pos.lat, pos.lon);
      } catch (_) {
        loc = { ...pos, label: "Your location", state: null, stateAbbr: null };
      }
      await setLocation(loc);
    } catch (err) {
      setStatus("#locator-status",
        `${err.message} — enter a ZIP code or address instead.`, { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  async function useSearch(text) {
    setStatus("#locator-status", "Finding that place…", { busy: true });
    try {
      const loc = await window.RRGeo.geocodeInput(text);
      await setLocation(loc);
    } catch (err) {
      setStatus("#locator-status", err.message, { error: true });
    }
  }

  async function setLocation(loc) {
    state.loc = loc;
    state.limit = 25;
    $("#location-chip").hidden = false;
    $("#location-label").textContent = loc.label;
    if (!loc.state) {
      setStatus("#locator-status",
        "Could not determine your US state — showing nationwide recalls only.", {});
    } else {
      setStatus("#locator-status", "", {});
    }
    $("#results").hidden = false;
    window.RRUI.showMap(loc); // map appears immediately; pins arrive with data
    await loadRecalls();
  }

  // -------------------------------------------------------------- recalls
  async function loadRecalls() {
    const loc = state.loc;
    setStatus("#products-status", "Fetching active recalls from FDA, USDA and CPSC…", { busy: true });
    $("#products-list").innerHTML = "";
    $("#stores-list").innerHTML = "";
    window.RRUI.renderStats({ recallCount: "…", highCount: "…", storeCount: "…" });

    const { recalls, sources } = await window.RRSources.fetchAll(loc);
    state.recalls = recalls;
    state.sources = sources;
    state.activeSources = new Set(recalls.map((r) => r.source));

    window.RRUI.renderSources(sources);
    buildSourceChips();
    applyProductFilters();

    const high = recalls.filter((r) => r.severity === "high").length;
    window.RRUI.renderStats({ recallCount: recalls.length, highCount: high, storeCount: "…" });

    if (!recalls.length) {
      setStatus("#products-status", "", {});
      window.RRUI.emptyNote("#products-list",
        "No active recalls matched your area in the past year — or the recall feeds were unreachable (see Data sources below).");
    } else {
      setStatus("#products-status", "", {});
    }

    await loadStores();
  }

  // --------------------------------------------------------------- stores
  function recallsByChain() {
    const m = new Map();
    for (const r of state.recalls) {
      for (const id of r.retailerIds || []) {
        if (!m.has(id)) m.set(id, []);
        m.get(id).push(r);
      }
    }
    return m;
  }

  async function loadStores() {
    const byChain = recallsByChain();
    // Cap the Overpass query to the 24 chains with the most recent recalls —
    // an unbounded regex over dozens of chains times out the public servers.
    const chains = [...byChain.entries()]
      .map(([id, rs]) => ({
        chain: window.RRRetailers.byId(id),
        newest: Math.max(...rs.map((r) => (r.date ? r.date.getTime() : 0))),
      }))
      .filter((x) => x.chain)
      .sort((a, b) => b.newest - a.newest)
      .slice(0, 24)
      .map((x) => x.chain);

    if (!chains.length) {
      window.RRUI.renderStats({
        recallCount: state.recalls.length,
        highCount: state.recalls.filter((r) => r.severity === "high").length,
        storeCount: 0,
      });
      setStatus("#stores-status", "", {});
      window.RRUI.emptyNote("#stores-list",
        "None of the active recalls for your area name a major retail chain, so there are no specific stores to flag. " +
        "Check the product list below — recalled items may still have been sold near you through smaller or unnamed retailers.");
      $("#btn-toggle-list").hidden = true;
      return;
    }

    const radius = parseInt($("#radius-select").value, 10);
    setStatus("#stores-status",
      `Searching OpenStreetMap for nearby ${chains.length === 1 ? chains[0].label : chains.length + " chains"} named in recalls… ` +
      "(the free public servers can take up to ~30 seconds on the first search)",
      { busy: true });

    try {
      const stores = await window.RRStores.findStores(chains, state.loc, radius);
      state.stores = stores;
      setStatus("#stores-status", "", {});

      if (!stores.length) {
        window.RRUI.emptyNote("#stores-list",
          "No locations of the recalled-product retail chains (" +
          chains.map((c) => window.RRUI.esc(c.label)).join(", ") +
          ") were found within your radius in OpenStreetMap. Try a larger radius — and still check the product list below.");
        $("#btn-toggle-list").hidden = true;
      } else {
        window.RRUI.renderStores(stores, byChain);
        window.RRUI.renderMap(state.loc, stores);
        $("#btn-toggle-list").hidden = !window.RRUI.hasMapLib();
      }

      window.RRUI.renderStats({
        recallCount: state.recalls.length,
        highCount: state.recalls.filter((r) => r.severity === "high").length,
        storeCount: stores.length,
      });
    } catch (err) {
      setStatus("#stores-status",
        `Store lookup failed (${err.message}). The recalled-product list below is unaffected.`, { error: true });
      window.RRUI.renderStats({
        recallCount: state.recalls.length,
        highCount: state.recalls.filter((r) => r.severity === "high").length,
        storeCount: "–",
      });
    }
  }

  // -------------------------------------------------------------- filters
  function buildSourceChips() {
    const names = [...new Set(state.recalls.map((r) => r.source))];
    window.RRUI.renderSourceChips(names, state.activeSources, (name, btn) => {
      if (state.activeSources.has(name)) state.activeSources.delete(name);
      else state.activeSources.add(name);
      btn.setAttribute("aria-pressed", String(state.activeSources.has(name)));
      state.limit = 25;
      applyProductFilters();
    });
  }

  function filteredRecalls() {
    const q = state.filterText.trim().toLowerCase();
    return state.recalls.filter((r) => {
      if (!state.activeSources.has(r.source)) return false;
      if (!q) return true;
      return [r.product, r.firm, r.reason, r.distribution, r.source]
        .join(" ").toLowerCase().includes(q);
    });
  }

  function applyProductFilters() {
    const recalls = filteredRecalls();
    if (state.recalls.length && !recalls.length) {
      window.RRUI.emptyNote("#products-list", "No recalls match the current filter.");
      $("#btn-more").hidden = true;
      return;
    }
    window.RRUI.renderProducts(recalls, { limit: state.limit });
  }

  // ----------------------------------------------------------------- init
  function init() {
    $("#btn-geolocate").addEventListener("click", useGeolocation);

    // map -> list: clicking a pin highlights and scrolls to its card
    window.RRUI.setMarkerClickHandler((i) => {
      window.RRUI.setActiveStore(i, { scroll: true });
    });

    // list -> map: clicking a card flies the map to that store
    $("#stores-list").addEventListener("click", (e) => {
      if (e.target.closest("a, summary")) return; // keep links/expanders native
      const li = e.target.closest(".store-item[data-index]");
      if (!li) return;
      const i = parseInt(li.dataset.index, 10);
      window.RRUI.setActiveStore(i);
      window.RRUI.focusStore(i, state.stores);
    });

    $("#btn-toggle-list").addEventListener("click", () => {
      const layout = $("#map-layout");
      const btn = $("#btn-toggle-list");
      const hidden = layout.classList.toggle("list-hidden");
      btn.textContent = hidden ? "Show list" : "Hide list";
      btn.setAttribute("aria-pressed", String(!hidden));
      window.RRUI.resizeMap();
    });

    $("#form-search").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#input-location").value;
      if (v.trim()) useSearch(v);
    });

    $("#radius-select").addEventListener("change", () => {
      if (state.loc) loadStores();
    });

    let debounce = null;
    $("#filter-text").addEventListener("input", (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.filterText = e.target.value;
        state.limit = 25;
        applyProductFilters();
      }, 200);
    });

    $("#btn-more").addEventListener("click", () => {
      state.limit += 25;
      applyProductFilters();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
