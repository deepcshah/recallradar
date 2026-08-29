/* MapLibre GL map (open-source Mapbox GL engine) with CARTO's keyless
 * dark-matter vector style to match the dark theme; falls back to CARTO
 * dark raster tiles if the vector style fails to load.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import maplibregl from "maplibre-gl";

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const RASTER_FALLBACK = {
  version: 8,
  name: "rr-raster-fallback",
  sources: {
    carto: {
      type: "raster",
      tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

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

/* `labels`, `flagged` and `activeIndex` are index-aligned with `stores` and
 * change far more often than the store list itself, so they are applied to
 * existing marker elements rather than triggering a rebuild — recreating the
 * markers would re-fit the map bounds on every selection. */
const MapView = forwardRef(function MapView(
  { loc, stores, labels, flagged, activeIndex, onMarkerClick },
  ref
) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const youRef = useRef(null);
  const markersRef = useRef([]);
  const clickRef = useRef(onMarkerClick);
  clickRef.current = onMarkerClick;

  // create once
  useEffect(() => {
    if (mapRef.current || !containerRef.current || !loc) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [loc.lon, loc.lat],
      zoom: 11,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("error", () => {
      if (!map.isStyleLoaded() && map.getStyle()?.name !== "rr-raster-fallback") {
        map.setStyle(RASTER_FALLBACK);
      }
    });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc != null]);

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
    map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, loc]);

  // A recall names this store's chain, or the user picked it: paint it in
  // place. Unflagged stores stay muted so the flagged ones carry the map.
  useEffect(() => {
    markersRef.current.forEach((m, i) => {
      const el = m.getElement();
      el.classList.toggle("flagged", Boolean(flagged && flagged[i]));
      el.classList.toggle("active", i === activeIndex);
      const span = el.querySelector(".map-pin-label");
      if (span) span.textContent = String((labels && labels[i]) || i + 1);
    });
  }, [labels, flagged, activeIndex, stores]);

  useImperativeHandle(ref, () => ({
    focusStore(i) {
      const map = mapRef.current;
      const marker = markersRef.current[i];
      if (!map || !marker) return;
      map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
      markersRef.current.forEach((m, j) => { if (j !== i && m.getPopup().isOpen()) m.togglePopup(); });
      if (!marker.getPopup().isOpen()) marker.togglePopup();
    },
    resize() {
      setTimeout(() => mapRef.current && mapRef.current.resize(), 60);
    },
  }));

  // Fills whatever the parent gives it — the shell decides the size now.
  return <div id="map" ref={containerRef} className="h-full w-full" />;
});

export default MapView;
