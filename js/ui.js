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
    for (const store of stores) {
      const recalls = [];
      const seen = new Set();
      for (const id of store.chainIds) {
        for (const r of recallsByChain.get(id) || []) {
          if (!seen.has(r.id)) { seen.add(r.id); recalls.push(r); }
        }
      }

      const li = document.createElement("li");
      li.className = "store-item";
      const chainLabels = store.chainIds
        .map((id) => window.RRRetailers.byId(id))
        .filter(Boolean)
        .map((c) => `<span class="badge chain">${esc(c.label)}</span>`)
        .join(" ");
      const mapsUrl = `https://www.openstreetmap.org/?mlat=${store.lat}&mlon=${store.lon}#map=17/${store.lat}/${store.lon}`;

      li.innerHTML = `
        <div class="store-head">
          <span class="store-name">${esc(store.name)}</span>
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
        <p class="store-links"><a href="${esc(mapsUrl)}" target="_blank" rel="noopener">View on map ↗</a></p>
      `;
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  // ------------------------------------------------------------------- map
  let map = null;
  let markerLayer = null;

  function renderMap(loc, stores) {
    const el = $("#map");
    if (typeof L === "undefined") { el.hidden = true; return; } // Leaflet CDN blocked/offline
    el.hidden = false;

    if (!map) {
      map = L.map(el, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      markerLayer = L.layerGroup().addTo(map);
    }
    markerLayer.clearLayers();

    const you = L.circleMarker([loc.lat, loc.lon], {
      radius: 8, color: "#0b5d69", fillColor: "#12889a", fillOpacity: 0.9,
    }).bindPopup("You are here");
    markerLayer.addLayer(you);

    const bounds = [[loc.lat, loc.lon]];
    for (const s of stores) {
      const m = L.marker([s.lat, s.lon]).bindPopup(
        `<strong>${esc(s.name)}</strong>${s.address ? "<br>" + esc(s.address) : ""}<br>${s.distanceMiles.toFixed(1)} mi`
      );
      markerLayer.addLayer(m);
      bounds.push([s.lat, s.lon]);
    }

    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    else map.setView([loc.lat, loc.lon], 12);
    setTimeout(() => map.invalidateSize(), 60);
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
    renderProducts, renderSourceChips, renderSources, emptyNote,
  };
})();
