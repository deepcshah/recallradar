/* MapLibre GL map (open-source Mapbox GL engine) with CARTO's keyless
 * dark-matter vector style to match the dark theme; falls back to CARTO
 * dark raster tiles if the vector style fails to load.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
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

/* ── which labels actually get drawn ────────────────────────────────────
 *
 * A name beside every named pin is fine until two of them are on the same
 * block, and then it is two names on top of each other with a map somewhere
 * underneath. Thirteen chains on Flatbush Ave is the normal case here, not
 * the pathological one.
 *
 * So the labels are laid out rather than merely shown. Candidates are taken
 * in priority order — the selected store first, then the ones a notice names
 * most often — and each is kept only if its box clears every box already
 * kept. A label that would run off the right edge, or whose pin has scrolled
 * out of view, is dropped before it is considered at all.
 *
 * The budget scales with the map, because "how many names fit" is a question
 * about the space, not the data: a phone showing the map at 40% of a small
 * screen gets a handful, a desktop half-window gets more. Everything is
 * recomputed on move, so panning and zooming reveal names as room appears
 * rather than leaving a fixed set that was right once.
 */
const LABEL_GAP = 6;        // px of clear space required between two labels
const LABEL_OFFSET_X = 27;  // label's left edge, relative to the pin's point
const LABEL_TOP = -28;      // the head sits this far above the anchored point

function labelBudget(height) {
  if (height < 260) return 2;
  if (height < 420) return 4;
  if (height < 700) return 7;
  return 11;
}

function overlaps(a, b) {
  return !(a.x + a.w + LABEL_GAP < b.x || b.x + b.w + LABEL_GAP < a.x ||
           a.y + a.h + LABEL_GAP < b.y || b.y + b.h + LABEL_GAP < a.y);
}

function layoutLabels(map, markers, { activeIndex, named, weights }) {
  if (!map || !markers.length) return;
  const box = map.getContainer();
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H) return;
  const budget = labelBudget(H);

  const candidates = markers
    .map((m, i) => i)
    .filter((i) => i === activeIndex || (named && named[i]))
    .sort((a, b) => {
      if (a === activeIndex) return -1;
      if (b === activeIndex) return 1;
      const wa = (weights && weights[a]) || 0;
      const wb = (weights && weights[b]) || 0;
      return wb - wa;
    });

  const placed = [];
  for (const i of candidates) {
    const el = markers[i].getElement();
    const tag = el.querySelector(".map-pin-name");
    if (!tag) continue;
    const p = map.project(markers[i].getLngLat());
    // Measured, not guessed: a name's width is whatever the type came out at.
    const w = tag.offsetWidth || 120;
    const h = tag.offsetHeight || 24;
    const rect = { x: p.x + LABEL_OFFSET_X, y: p.y + LABEL_TOP, w, h };

    const offscreen = p.x < 0 || p.x > W || p.y < 0 || p.y > H;
    const runsOff = rect.x + rect.w > W - 4;
    const collides = placed.some((q) => overlaps(rect, q));
    const show = !offscreen && !runsOff && !collides && placed.length < budget;

    el.classList.toggle("label-off", !show);
    if (show) placed.push(rect);
  }
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
  { loc, stores, labels, named, notes, weights, activeIndex, theme = "dark", radius,
    showPopup = true, onMarkerClick, onBackgroundClick },
  ref
) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const youRef = useRef(null);
  const markersRef = useRef([]);
  const popupRef = useRef(null);
  /* Label layout reads the live values, so it is called from a map event
   * handler bound once rather than re-bound on every render. */
  const labelStateRef = useRef({ activeIndex: -1, named: [], weights: [] });
  const labelFrameRef = useRef(0);
  const clickRef = useRef(onMarkerClick);
  clickRef.current = onMarkerClick;
  const groundRef = useRef(onBackgroundClick);
  groundRef.current = onBackgroundClick;
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

  /* One frame per move at most. `move` fires many times a second while a
   * camera animation runs, and the layout is cheap but not free. */
  const relayoutLabels = useCallback(() => {
    cancelAnimationFrame(labelFrameRef.current);
    labelFrameRef.current = requestAnimationFrame(() => {
      layoutLabels(mapRef.current, markersRef.current, labelStateRef.current);
    });
  }, []);

  /* Clicking the ground clears the selection.
   *
   * Nothing did before, so a pin stayed lit after you had plainly moved on —
   * and because MapLibre closes its own popups on a map click, the bubble
   * went while the pin stayed, which is the state that made re-clicking the
   * pin look like it was doing two contradictory things at once.
   *
   * The ground is the canvas and nothing else. Markers, popups and the zoom
   * control all live inside the map's own containers, so their clicks arrive
   * here too — and testing for "not a pin" was not enough: a popup overlaps
   * the pins around it, so clicking one to read it cleared the very selection
   * it was describing. Asking whether the click landed on the canvas answers
   * the question directly, and keeps answering it for anything MapLibre
   * chooses to overlay next. */
  const onGroundClick = useCallback((e) => {
    const map = mapRef.current;
    if (!map) return;
    const target = e.originalEvent && e.originalEvent.target;
    if (target !== map.getCanvas()) return;
    groundRef.current && groundRef.current();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.on("move", relayoutLabels);
    map.on("resize", relayoutLabels);
    map.on("click", onGroundClick);
    return () => {
      cancelAnimationFrame(labelFrameRef.current);
      map.off("move", relayoutLabels);
      map.off("resize", relayoutLabels);
      map.off("click", onGroundClick);
    };
  }, [relayoutLabels, onGroundClick, loc]);

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
    /* No popup on this one either, and for the same reason as the store pins:
     * a marker with a popup toggles it on click by itself, so "You are here"
     * was a second bubble that could sit open beside the selected store's,
     * outside the one piece of state that is supposed to decide whether a
     * bubble exists. The pin is its own label — it is the only one that
     * colour, and it says so to a screen reader. */
    youRef.current = new maplibregl.Marker({ element: pinEl({ isYou: true }) })
      .setLngLat([loc.lon, loc.lat])
      .addTo(map);
    /* After `addTo`, not before: MapLibre overwrites aria-label with its own
     * "Map marker" on the way in. */
    youRef.current.getElement().setAttribute("aria-label", "You are here");
    youRef.current.getElement().setAttribute("title", "You are here");
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
      el.addEventListener("click", () => clickRef.current && clickRef.current(i));
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        clickRef.current && clickRef.current(i);
      });
      /* Deliberately no `setPopup`. A marker with a popup attached toggles it
       * on click by itself — see the single-popup effect below for why that
       * had to stop. */
      const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([s.lon, s.lat])
        .addTo(map);
      /* `addTo` sets `aria-label` to MapLibre's own "Map marker", overwriting
       * anything already there — so every pin on this map read as "Map
       * marker" to a screen reader, whichever shop it was. It has to be said
       * after the marker is on the map, not before. */
      el.setAttribute("aria-label", `${s.name}, ${s.distanceMiles.toFixed(1)} miles away`);
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
    relayoutLabels();
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
    labelStateRef.current = { activeIndex, named: named || [], weights: weights || [] };
    relayoutLabels();
  }, [labels, named, notes, weights, activeIndex, stores, relayoutLabels]);

  /* One popup, and `activeIndex` alone decides where it is.
   *
   * Every marker used to carry its own, and a marker with a popup attached
   * toggles it on click without telling anyone — a second copy of "which
   * store is selected", living in MapLibre, changed by clicks React never
   * saw. The two drifted exactly as you would expect. Clicking the map closed
   * the bubble (MapLibre closes popups on map click) but left the pin lit, so
   * clicking that pin again deselected it in React and re-opened the bubble
   * in MapLibre — one gesture, two opposite answers. Selecting from the list
   * meanwhile reached in and toggled bubbles by hand to keep them in line.
   *
   * Now there is one bubble, it is derived, and the only way to dismiss it is
   * to stop having a selection: click the pin again, click the ground, or
   * clear it from the panel. No close button, because a close button would be
   * a fourth way to change a state it cannot actually change. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const store = stores && stores[activeIndex];
    const marker = markersRef.current[activeIndex];
    if (!showPopup || !store || !marker) {
      popupRef.current && popupRef.current.remove();
      return;
    }
    if (!popupRef.current) {
      popupRef.current = new maplibregl.Popup({ offset: 18, closeButton: false, closeOnClick: false });
    }
    popupRef.current.setLngLat(marker.getLngLat()).setHTML(popupHtml(store)).addTo(map);
  }, [activeIndex, stores, showPopup]);

  useImperativeHandle(ref, () => ({
    focusStore(i) {
      const map = mapRef.current;
      const marker = markersRef.current[i];
      if (!map || !marker) return;
      map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 13.5), duration: 700 });
    },
    resize() {
      setTimeout(() => mapRef.current && mapRef.current.resize(), 60);
    },
  }));

  // Fills whatever the parent gives it — the shell decides the size now.
  return <div id="map" ref={containerRef} className="h-full w-full" />;
});

export default MapView;
