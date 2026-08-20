/* Find nearby store locations for the retail chains named in active recalls,
 * using the OpenStreetMap Overpass API (no key required).
 */
(function () {
  "use strict";

  const ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  /**
   * Query Overpass for stores of the given chains around a point.
   * @param {Array} chains - retailer objects from RRRetailers
   * @param {{lat,lon}} loc
   * @param {number} radiusMeters
   * @returns {Promise<Array<{name, brand, lat, lon, address, distanceMiles, chainIds}>>}
   */
  async function findStores(chains, loc, radiusMeters) {
    if (!chains.length) return [];

    const pattern = chains.map((c) => c.osm).join("|");
    const around = `(around:${Math.round(radiusMeters)},${loc.lat},${loc.lon})`;
    // Match on either the shop name or its brand tag; restrict to shop-ish POIs.
    const query = `
      [out:json][timeout:25];
      (
        nwr["shop"]["name"~"${pattern}",i]${around};
        nwr["shop"]["brand"~"${pattern}",i]${around};
        nwr["amenity"="pharmacy"]["name"~"${pattern}",i]${around};
        nwr["amenity"="fuel"]["brand"~"${pattern}",i]${around};
      );
      out center tags 120;
    `;

    let data = null;
    let lastError = null;
    for (const endpoint of ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(endpoint, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!data) throw lastError || new Error("Overpass unavailable");

    const seen = new Set();
    const stores = [];
    for (const el of data.elements || []) {
      const tags = el.tags || {};
      const lat = el.lat ?? (el.center && el.center.lat);
      const lon = el.lon ?? (el.center && el.center.lon);
      if (lat == null || lon == null) continue;

      const name = tags.name || tags.brand || "Unnamed store";
      const hay = `${tags.name || ""} ${tags.brand || ""}`;
      const chainIds = chains
        .filter((c) => new RegExp(c.osm, "i").test(hay))
        .map((c) => c.id);
      if (!chainIds.length) continue;

      // Dedup same-name stores at nearly identical coordinates (node + way pairs).
      const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const address = [
        [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
        tags["addr:city"],
      ].filter(Boolean).join(", ");

      stores.push({
        name,
        brand: tags.brand || "",
        lat,
        lon,
        address,
        distanceMiles: window.RRGeo.distanceMiles(loc.lat, loc.lon, lat, lon),
        chainIds,
      });
    }

    stores.sort((a, b) => a.distanceMiles - b.distanceMiles);
    return stores.slice(0, 60);
  }

  window.RRStores = { findStores };
})();
