/* DOM rendering. All API-derived text goes through esc() — recall notices and
 * OSM tags are external data and must never reach innerHTML unescaped.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sevBadge(recall) {
    const map = {
      high: ["sev-high", recall.classification || "High risk"],
      med: ["sev-med", recall.classification || "Medium risk"],
      low: ["sev-low", recall.classification || "Lower risk"],
    };
    const [cls, label] = map[recall.severity] || map.med;
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  function fmtDate(d) {
    if (!d || isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  // ---------------------------------------------------------------- status
  function setStatus(sel, msg, { error = false, busy = false } = {}) {
    const el = $(sel);
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("error", !!error);
    el.classList.toggle("spin", !!busy);
  }

  // ----------------------------------------------------------------- stats
  function renderStats({ recallCount, highCount, storeCount }) {
    $("#stat-recalls").textContent = recallCount;
    const high = $("#stat-high");
    high.textContent = highCount;
    high.classList.toggle("danger", highCount > 0);
    $("#stat-stores").textContent = storeCount;
  }

  // ---------------------------------------------------------------- stores
  function renderStores(stores, recallsByChain) {
    const list = $("#stores-list");
    list.innerHTML = "";
    if (!stores.length) return;

    const frag = document.createDocumentFragment();
    stores.forEach((store, index) => {
      const recalls = [];
      const seen = new Set();
      for (const id of store.chainIds) {
        for (const r of recallsByChain.get(id) || []) {
          if (!seen.has(r.id)) { seen.add(r.id); recalls.push(r); }
        }
      }

      const li = document.createElement("li");
      li.className = "store-item";
      li.dataset.index = String(index);
      const chainLabels = store.chainIds
        .map((id) => window.RRRetailers.byId(id))
        .filter(Boolean)
        .map((c) => `<span class="badge chain">${esc(c.label)}</span>`)
        .join(" ");
      const mapsUrl = `https://www.openstreetmap.org/?mlat=${store.lat}&mlon=${store.lon}#map=17/${store.lat}/${store.lon}`;

      li.innerHTML = `
        <div class="store-head">
          <span class="store-name">${index + 1}. ${esc(store.name)}</span>
          ${chainLabels}
          <span class="store-dist">${store.distanceMiles.toFixed(1)} mi</span>
        </div>
        ${store.address ? `<p class="store-addr">${esc(store.address)}</p>` : ""}
        <details class="store-recalls">
          <summary>${recalls.length} active recall${recalls.length === 1 ? " names" : "s name"} this chain</summary>
          <ul>
            ${recalls.slice(0, 8).map((r) => `
              <li>${sevBadge(r)} ${esc(truncate(r.product, 120))}
                <a href="${esc(r.url)}" target="_blank" rel="noopener">notice</a></li>`).join("")}
            ${recalls.length > 8 ? `<li>…and ${recalls.length - 8} more in the product list below.</li>` : ""}
          </ul>
        </details>
        <p class="store-links"><a href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in OpenStreetMap ↗</a></p>
      `;
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  /** Highlight one store card (map -> list sync). */
  function setActiveStore(i, { scroll = false } = {}) {
    const items = document.querySelectorAll("#stores-list .store-item");
    items.forEach((li) => li.classList.toggle("active", li.dataset.index === String(i)));
    if (scroll && items[i]) items[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ------------------------------------------------------------------- map
  // MapLibre GL (open-source Mapbox GL engine) with OpenFreeMap's keyless
  // vector style; falls back to raster OSM tiles if the vector style fails.
  const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const RASTER_FALLBACK = {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };

  let map = null;
  let markers = [];
  let youMarker = null;
  let onMarkerClick = null; // set by the app to sync map -> list

  function hasMapLib() {
    return typeof maplibregl !== "undefined";
  }

  function pinEl(label, isYou) {
    const div = document.createElement("div");
    div.className = "map-pin" + (isYou ? " you" : "");
    if (label) {
      const span = document.createElement("span");
      span.className = "map-pin-label";
      span.textContent = label;
      div.appendChild(span);
    }
    return div;
  }

  function ensureMap(loc) {
    if (map) return map;
    map = new maplibregl.Map({
      container: $("#map"),
      style: MAP_STYLE,
      center: [loc.lon, loc.lat],
      zoom: 11,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("error", () => {
      // Vector style unreachable -> swap to plain raster tiles, once.
      if (!map.isStyleLoaded() && map.getStyle()?.name !== "rr-raster-fallback") {
        map.setStyle({ ...RASTER_FALLBACK, name: "rr-raster-fallback" });
      }
    });
    return map;
  }

  function popupHtml(s) {
    return `<strong>${esc(s.name)}</strong>${s.address ? "<br>" + esc(s.address) : ""}<br>${s.distanceMiles.toFixed(1)} mi away`;
  }

  function renderMap(loc, stores) {
    const el = $("#map");
    const layout = $("#map-layout");
    if (!hasMapLib()) { el.hidden = true; layout.classList.remove("has-map"); return; }
    el.hidden = false;
    layout.classList.add("has-map");

    ensureMap(loc);
    markers.forEach((m) => m.remove());
    markers = [];
    if (youMarker) youMarker.remove();

    youMarker = new maplibregl.Marker({ element: pinEl("", true) })
      .setLngLat([loc.lon, loc.lat])
      .setPopup(new maplibregl.Popup({ offset: 14 }).setHTML("You are here"))
      .addTo(map);

    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([loc.lon, loc.lat]);

    stores.forEach((s, i) => {
      const el = pinEl(String(i + 1), false);
      el.addEventListener("click", () => { if (onMarkerClick) onMarkerClick(i); });
      const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([s.lon, s.lat])
        .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml(s)))
        .addTo(map);
      markers.push(m);
      bounds.extend([s.lon, s.lat]);
    });

    map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 800 });
    resizeMap();
  }

  /** Fly to a store and open its popup (list -> map sync). */
  function focusStore(i, stores) {
    if (!map || !markers[i]) return;
    const s = stores[i];
    map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
    markers.forEach((m, j) => { if (j !== i && m.getPopup().isOpen()) m.togglePopup(); });
    if (!markers[i].getPopup().isOpen()) markers[i].togglePopup();
  }

  function setMarkerClickHandler(fn) { onMarkerClick = fn; }

  function resizeMap() {
    if (map) setTimeout(() => map.resize(), 60);
  }

  // -------------------------------------------------------------- products
  function recallCard(r) {
    const li = document.createElement("li");
    li.className = `recall-item sev-${r.severity}`;
    const scopeLabel = r.scope === "nationwide" ? "Nationwide" : "Your state";
    const retailers = (r.retailerIds || [])
      .map((id) => window.RRRetailers.byId(id))
      .filter(Boolean);

    li.innerHTML = `
      <div class="recall-top">
        <span class="badge src">${esc(r.source)}</span>
        ${sevBadge(r)}
        <span class="badge scope">${scopeLabel}</span>
        <span class="recall-date">${fmtDate(r.date)}</span>
      </div>
      <p class="recall-product">${esc(truncate(r.product, 220))}</p>
      ${r.firm ? `<p class="recall-firm">Recalled by ${esc(r.firm)}</p>` : ""}
      ${r.reason ? `<p class="recall-reason">${esc(truncate(r.reason, 300))}</p>` : ""}
      ${retailers.length ? `<div class="recall-retailers">${retailers.map((c) => `<span class="badge chain">Sold at ${esc(c.label)}</span>`).join("")}</div>` : ""}
      ${r.distribution ? `<p class="recall-meta">Distribution: ${esc(truncate(r.distribution, 260))}</p>` : ""}
      ${r.codeInfo ? `
        <details class="recall-more"><summary>Lot / code details</summary>
          <p>${esc(truncate(r.codeInfo, 600))}</p></details>` : ""}
      <p class="recall-link"><a href="${esc(r.url)}" target="_blank" rel="noopener">Official notice ↗</a>${r.searchHint ? ` <span class="recall-meta" style="display:inline">(search recall # ${esc(r.searchHint)})</span>` : ""}</p>
    `;
    return li;
  }

  function renderProducts(recalls, { limit }) {
    const list = $("#products-list");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const r of recalls.slice(0, limit)) frag.appendChild(recallCard(r));
    list.appendChild(frag);

    const more = $("#btn-more");
    const remaining = recalls.length - limit;
    more.hidden = remaining <= 0;
    if (remaining > 0) more.textContent = `Show ${Math.min(remaining, 25)} more recalls (${remaining} remaining)`;
  }

  function renderSourceChips(sourceNames, active, onToggle) {
    const wrap = $("#source-chips");
    wrap.innerHTML = "";
    for (const name of sourceNames) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = name;
      btn.setAttribute("aria-pressed", String(active.has(name)));
      btn.addEventListener("click", () => onToggle(name, btn));
      wrap.appendChild(btn);
    }
  }

  // --------------------------------------------------------------- sources
  function renderSources(sources) {
    const list = $("#sources-list");
    list.innerHTML = "";
    for (const s of sources) {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="source-dot ${s.ok ? "ok" : "fail"}" aria-hidden="true"></span>
        <span>${esc(s.name)}</span>
        <span class="source-note">${s.ok
          ? `${s.count} matching recall${s.count === 1 ? "" : "s"}`
          : `unavailable (${esc(s.error || "error")}) — check the agency site directly`}</span>`;
      list.appendChild(li);
    }
  }

  function emptyNote(sel, html) {
    const el = $(sel);
    const div = document.createElement("div");
    div.className = "empty-note";
    div.innerHTML = html; // caller passes trusted, static markup only
    el.innerHTML = "";
    el.appendChild(div);
  }

  window.RRUI = {
    $, esc, setStatus, renderStats, renderStores, renderMap,
    focusStore, setActiveStore, setMarkerClickHandler, resizeMap, hasMapLib,
    renderProducts, renderSourceChips, renderSources, emptyNote,
  };
})();
