/* MapLibre GL map (open-source Mapbox GL engine) with CARTO's keyless
 * dark-matter vector style to match the dark theme; falls back to CARTO
 * dark raster tiles if the vector style fails to load.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import maplibregl from "maplibre-gl";

/* The basemap follows the app theme — a dark slab under a light UI was the
 * single worst contrast break in the layout. */
const MAP_STYLE = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const rasterFallback = (theme) => ({
  version: 8,
  name: "rr-raster-fallback",
  sources: {
    carto: {
      type: "raster",
      tiles: [`https://basemaps.cartocdn.com/${theme === "light" ? "light_all" : "dark_all"}/{z}/{x}/{y}.png`],
      tileSize: 256,
      attribution: ATTRIBUTION,
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
});

function pinEl(label, isYou) {
  const div = document.createElement("div");
  div.className = "map-pin" + (isYou ? " you" : "");
  const span = document.createElement("span");
  span.className = "map-pin-label";
  span.textContent = label || "";
  div.appendChild(span);
  return div;
}

function popupHtml(s) {
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<strong>${esc(s.name)}</strong>${s.address ? "<br>" + esc(s.address) : ""}<br>${s.distanceMiles.toFixed(1)} mi away`;
}

/* `labels`, `named` and `activeIndex` are index-aligned with `stores` and
 * change far more often than the store list itself, so they are applied to
 * existing marker elements rather than triggering a rebuild — recreating the
 * markers would re-fit the map bounds on every selection. */
const MapView = forwardRef(function MapView(
  { loc, stores, labels, named, activeIndex, theme = "dark", onMarkerClick },
  ref
) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const youRef = useRef(null);
  const markersRef = useRef([]);
  const clickRef = useRef(onMarkerClick);
  clickRef.current = onMarkerClick;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // create once
  useEffect(() => {
    if (mapRef.current || !containerRef.current || !loc) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE[theme] || MAP_STYLE.dark,
      center: [loc.lon, loc.lat],
      zoom: 11,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("error", () => {
      if (!map.isStyleLoaded() && map.getStyle()?.name !== "rr-raster-fallback") {
        map.setStyle(rasterFallback(themeRef.current));
      }
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc != null]);

  /* The map is constructed with the current theme's style, so the first run of
   * this effect has nothing to do — swapping the style out from under a load
   * that is still in flight leaves the canvas blank. Only a real change past
   * mount gets a setStyle. */
  const appliedThemeRef = useRef(theme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedThemeRef.current === theme) return;
    appliedThemeRef.current = theme;
    if (map.getStyle()?.name === "rr-raster-fallback") map.setStyle(rasterFallback(theme));
    else map.setStyle(MAP_STYLE[theme] || MAP_STYLE.dark);
  }, [theme]);

  /* MapLibre caches the container size at construction and never re-reads it.
   * The panel beside the map appears in the same commit the map mounts in, and
   * the split divider resizes it afterwards, so without this the canvas keeps
   * a stale width and pins land off-screen until something else forces a
   * resize — which is what made toggling the radius look like the fix. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => mapRef.current && mapRef.current.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // location changed → move the "you" pin and recenter
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loc) return;
    if (youRef.current) youRef.current.remove();
    youRef.current = new maplibregl.Marker({ element: pinEl("", true) })
      .setLngLat([loc.lon, loc.lat])
      .setPopup(new maplibregl.Popup({ offset: 14 }).setHTML("You are here"))
      .addTo(map);
    map.jumpTo({ center: [loc.lon, loc.lat], zoom: 11 });
  }, [loc]);

  // stores changed → redraw numbered pins and fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loc) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (!stores || !stores.length) return;

    const bounds = new maplibregl.LngLatBounds();
    bounds.extend([loc.lon, loc.lat]);
    stores.forEach((s, i) => {
      const el = pinEl(String((labels && labels[i]) || i + 1), false);
      el.addEventListener("click", () => clickRef.current && clickRef.current(i));
      const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([s.lon, s.lat])
        .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml(s)))
        .addTo(map);
      markersRef.current.push(m);
      bounds.extend([s.lon, s.lat]);
    });
    /* Resize before fitting: if the canvas is still carrying its mount-time
     * width, fitBounds computes a zoom for the wrong viewport. */
    const fit = () => {
      map.resize();
      map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 800 });
    };
    if (map.isStyleLoaded()) fit();
    else map.once("load", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, loc]);

  // A recall names this store's chain, or the user picked it: paint it in
  // place. Unnamed stores stay muted so the named ones carry the map.
  useEffect(() => {
    markersRef.current.forEach((m, i) => {
      const el = m.getElement();
      el.classList.toggle("named", Boolean(named && named[i]));
      el.classList.toggle("active", i === activeIndex);
      const span = el.querySelector(".map-pin-label");
      if (span) span.textContent = String((labels && labels[i]) || i + 1);
    });
  }, [labels, named, activeIndex, stores]);

  useImperativeHandle(ref, () => ({
    focusStore(i, { popup = true } = {}) {
      const map = mapRef.current;
      const marker = markersRef.current[i];
      if (!map || !marker) return;
      map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
      // Only one bubble at a time, and none at all when the caller says the
      // map is too small to spare the room.
      markersRef.current.forEach((m, j) => {
        if ((j !== i || !popup) && m.getPopup().isOpen()) m.togglePopup();
      });
      if (popup && !marker.getPopup().isOpen()) marker.togglePopup();
    },
    resize() {
      setTimeout(() => mapRef.current && mapRef.current.resize(), 60);
    },
  }));

  // Fills whatever the parent gives it — the shell decides the size now.
  return <div id="map" ref={containerRef} className="h-full w-full" />;
});

export default MapView;
