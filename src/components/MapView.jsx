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

/* The pin was a square div with `border-radius: 50% 50% 50% 0` rotated -45deg,
 * and its number a span rotated +45deg back. Two problems, both visible: a
 * rotated square's optical centre is not where the label's box thinks it is,
 * so every number sat a little low and left of the head it was meant to be
 * inside; and the counter-rotation ran through the browser's text rasteriser,
 * so the digits came out softer than any other type on screen. Scaling the
 * selected pin by 1.5 magnified both.
 *
 * A path has neither problem. The teardrop is drawn once, the head is a real
 * circle centred at (12,12), and the label is an unrotated box over exactly
 * that circle — so it is centred because it is centred, not because two
 * rotations happened to cancel. */
const PIN_PATH = "M12 27.4c0-.1 10-9.6 10-15.4a10 10 0 1 0-20 0c0 5.8 10 15.3 10 15.4Z";
const PIN_BOX = "0 0 24 28";

/* A pin, and — for the ones that matter — its name written beside it.
 *
 * A field of numbered pins tells you where things are and nothing about what
 * they are: to learn that a pin is the CVS named in three notices rather than
 * a bodega, you had to tap it, and then tap the next one. The number ties the
 * pin to its row in the list, which only helps if you are already reading the
 * list.
 *
 * So the name rides along. Not on every pin — eighty labels is a wall of text
 * with the map behind it — only on the ones the map is actually about: the
 * stores a notice names, and whichever one is selected. CSS decides which
 * (see .map-pin-name), so a selection change needs no rebuild. Everything
 * else stays a bare pin, which is also the honest weighting: an unnamed store
 * is a place you could walk to, not an answer. */
function pinEl({ label, name, note, isYou }) {
  const div = document.createElement("div");
  // "You are here" is a location, not a numbered result: a dot, not a pin.
  if (isYou) {
    div.className = "map-pin you";
    return div;
  }
  div.className = "map-pin";
  /* Everything that scales lives in here, and the marker element itself
   * carries no transform of its own.
   *
   * MapLibre positions a marker by writing `transform` to its inline style,
   * and an inline style beats any stylesheet rule. So every `transform` this
   * app put on `.map-pin` — the selected pin growing by half, the hover
   * nudge, the smaller pins on a phone — was silently discarded, and had
   * been for as long as the rules existed. Scaling a child instead leaves
   * the marker's own transform to MapLibre, which is the only thing allowed
   * to write it.
   *
   * The name label is deliberately NOT in here: it must not scale with the
   * selected pin, or the one label you are actually reading becomes the
   * largest and blurriest thing on the map. */
  const inner = document.createElement("div");
  inner.className = "map-pin-inner";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", PIN_BOX);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "map-pin-shape");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PIN_PATH);
  svg.appendChild(path);
  inner.appendChild(svg);
  const span = document.createElement("span");
  span.className = "map-pin-label";
  span.textContent = label || "";
  inner.appendChild(span);
  div.appendChild(inner);

  if (name) {
    const tag = document.createElement("span");
    tag.className = "map-pin-name";
    const b = document.createElement("b");
    b.textContent = name;
    tag.appendChild(b);
    if (note) {
      const i = document.createElement("i");
      i.textContent = note;
      tag.appendChild(i);
    }
    div.appendChild(tag);
  }
  return div;
}

function popupHtml(s) {
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<strong>${esc(s.name)}</strong>` +
    (s.address ? `<div class="pop-sub">${esc(s.address)}</div>` : "") +
    `<div class="pop-dist">${s.distanceMiles.toFixed(1)} mi away</div>`;
}

/* `labels`, `named` and `activeIndex` are index-aligned with `stores` and
 * change far more often than the store list itself, so they are applied to
 * existing marker elements rather than triggering a rebuild — recreating the
 * markers would re-fit the map bounds on every selection. */
/* The bounds of the search area itself — a box around the radius circle.
 *
 * Fitting to the stores alone made the radius control inert wherever there
 * are more stores than the list will hold: findStores caps at 80 and sorts by
 * distance, so in a dense area 5, 10 and 25 miles all return the same nearest
 * 80 storefronts. The bounds never moved and changing the radius did nothing
 * you could see. Fitting to what was asked for, rather than to what came
 * back, means the map always answers the control. Store bounds are unioned in
 * so a result sitting just outside the circle is never cropped from view. */
function radiusBounds(loc, radiusMeters) {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.max(0.2, Math.cos((loc.lat * Math.PI) / 180)));
  return new maplibregl.LngLatBounds(
    [loc.lon - dLon, loc.lat - dLat],
    [loc.lon + dLon, loc.lat + dLat]
  );
}

const MapView = forwardRef(function MapView(
  { loc, stores, labels, named, notes, activeIndex, theme = "dark", radius, onMarkerClick },
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
    youRef.current = new maplibregl.Marker({ element: pinEl({ isYou: true }) })
      .setLngLat([loc.lon, loc.lat])
      .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false, className: "popup-bare" })
        .setHTML("You are here"))
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

    const bounds = radius ? radiusBounds(loc, radius) : new maplibregl.LngLatBounds();
    bounds.extend([loc.lon, loc.lat]);
    stores.forEach((s, i) => {
      const el = pinEl({
        label: String((labels && labels[i]) || i + 1),
        name: s.name,
        note: (notes && notes[i]) || "",
      });
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", `${s.name}, ${s.distanceMiles.toFixed(1)} miles away`);
      el.addEventListener("click", () => clickRef.current && clickRef.current(i));
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        clickRef.current && clickRef.current(i);
      });
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
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 800 });
    };
    /* `once("load")` only helps before the map has ever loaded. After that
     * the event will not fire again, so a run that finds the style briefly
     * un-loaded — a tile host hiccup, a style swapped for the theme, an
     * errored source — would queue a fit that never happens and quietly drop
     * it. Every later fit is dropped the same way, which reads as a radius
     * control that does nothing for the rest of the session. `map.loaded()`
     * is the question actually being asked: is this map ready to be moved. */
    if (map.isStyleLoaded() || map.loaded()) fit();
    else map.once("load", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, loc, radius]);

  // A recall names this store's chain, or the user picked it: paint it in
  // place. Unnamed stores stay muted so the named ones carry the map.
  useEffect(() => {
    markersRef.current.forEach((m, i) => {
      const el = m.getElement();
      el.classList.toggle("named", Boolean(named && named[i]));
      el.classList.toggle("active", i === activeIndex);
      const span = el.querySelector(".map-pin-label");
      if (span) span.textContent = String((labels && labels[i]) || i + 1);
      const note = el.querySelector(".map-pin-name i");
      if (note) note.textContent = (notes && notes[i]) || "";
    });
  }, [labels, named, notes, activeIndex, stores]);

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
