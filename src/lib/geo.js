/* Geolocation + geocoding helpers.
 * Location shape: { lat, lon, label, state, stateAbbr, place?, zip? }
 *
 * Every failure is an Error with a `.code` (see GEO_ERRORS). The location
 * picker turns the code into a sentence a person can act on, and analytics
 * sends only the code — never the typed text, never the ZIP. The raw
 * transport message ("HTTP 404 from api.zippopotam.us") is kept on `.cause`
 * for debugging and is never shown.
 */
import { abbrForName } from "./states.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const ZIPPO = "https://api.zippopotam.us/us/";

/** code → the sentence the picker shows. `{zip}` / `{text}` are filled in by
 *  geoErrorMessage; nothing else about the input is ever repeated back. */
export const GEO_ERRORS = {
  empty: "Enter a ZIP code, or a city and state.",
  zip_invalid: "A ZIP code has 5 digits.",
  zip_not_found: "We couldn't find ZIP {zip}. Check the digits, or try a city and state.",
  place_not_found: "We couldn't find \u201c{text}\u201d. Try a 5-digit ZIP.",
  no_state: "That place isn't in a US state we cover. Try a US ZIP.",
  network: "Couldn't reach the place lookup. Check your connection and try again.",
  geo_denied: "Location access is off for this site. Type a ZIP instead, or allow location in your browser's site settings.",
  geo_unavailable: "Couldn't get a fix on your location. Type a ZIP instead.",
  geo_unsupported: "This browser can't share its location here. Type a ZIP instead.",
};

export function geoError(code, extra = {}) {
  const e = new Error(GEO_ERRORS[code] || GEO_ERRORS.network);
  e.code = GEO_ERRORS[code] ? code : "network";
  Object.assign(e, extra);
  return e;
}

/** The human sentence for any error this module (or anything else) threw. */
export function geoErrorMessage(err) {
  const code = (err && err.code) || "network";
  const tpl = GEO_ERRORS[code] || GEO_ERRORS.network;
  return tpl
    .replace("{zip}", String((err && err.zip) || "").slice(0, 10))
    .replace("{text}", String((err && err.text) || "").slice(0, 40));
}

async function fetchJSON(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (cause) {
    throw geoError("network", { cause });
  }
  if (!res.ok) {
    const e = geoError("network");
    e.status = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch (cause) {
    throw geoError("network", { cause });
  }
}

/** Can this page ask for the device's position at all? The picker hides its
 *  "Use my current location" row when it can't, rather than offering a tap
 *  that can only fail. */
export function canGeolocate() {
  try {
    return typeof navigator !== "undefined" && !!navigator.geolocation &&
      (typeof window === "undefined" || window.isSecureContext !== false);
  } catch (_) {
    return false;
  }
}

/** Browser geolocation wrapped in a promise. Rejects with a coded error. */
export function browserPosition() {
  return new Promise((resolve, reject) => {
    if (!canGeolocate()) {
      reject(geoError("geo_unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(geoError(err && err.code === 1 ? "geo_denied" : "geo_unavailable")),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  });
}

/* "New York City" is what Zippopotam calls every Manhattan ZIP; the state is
 * already in the label, and "New York City, NY" reads as a stutter next to
 * "Not reported in New York". Only NY — "Oklahoma City", "Salt Lake City" and
 * "Kansas City" are the cities' real names. */
function tidyPlace(place, stateAbbr) {
  const p = String(place || "").trim();
  if (stateAbbr === "NY" && /^new york city$/i.test(p)) return "New York";
  return p;
}

/** "{place}, {ST} {zip}" — the location button's label, from any loc shape.
 *  `short` drops the ZIP (phone header); the ZIP stays in aria-label. */
export function locLabel(loc, { short = false } = {}) {
  if (!loc) return "";
  if (loc.place || loc.stateAbbr) {
    const head = [loc.place, loc.stateAbbr || loc.state].filter(Boolean).join(", ");
    if (head) return short || !loc.zip ? head : `${head} ${loc.zip}`;
  }
  const label = String(loc.label || "");
  return short ? label.replace(/\s+\d{5}$/, "") : label;
}

/** Reverse geocode coordinates to a place label + US state. */
export async function reverseGeocode(lat, lon) {
  const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
  const data = await fetchJSON(url);
  const a = data.address || {};
  const stateName = a.state || null;
  const stateAbbr = stateName ? abbrForName(stateName) : null;
  const place = tidyPlace(a.city || a.town || a.village || a.county || data.name || "", stateAbbr);
  const label = [place, stateAbbr || stateName].filter(Boolean).join(", ") || "Your location";
  return { lat, lon, label, place: place || null, state: stateName, stateAbbr };
}

/** Geocode a 5-digit US ZIP via Zippopotam (fast, generous CORS). */
async function geocodeZip(zip) {
  let data;
  try {
    data = await fetchJSON(ZIPPO + encodeURIComponent(zip));
  } catch (err) {
    if (err.code === "network" && err.status !== 404) throw err;
    throw geoError("zip_not_found", { zip });
  }
  const p = ((data && data.places) || [])[0];
  if (!p) throw geoError("zip_not_found", { zip });
  const stateAbbr = p["state abbreviation"] || null;
  const place = tidyPlace(p["place name"], stateAbbr);
  return {
    lat: parseFloat(p.latitude),
    lon: parseFloat(p.longitude),
    label: `${place}, ${stateAbbr} ${zip}`,
    place,
    zip,
    state: p.state,
    stateAbbr,
  };
}

/** Geocode a free-text US address via Nominatim. */
async function geocodeAddress(q) {
  const url = `${NOMINATIM}/search?format=jsonv2&countrycodes=us&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  let results;
  try {
    results = await fetchJSON(url);
  } catch (err) {
    throw err.status === 404 ? geoError("place_not_found", { text: q }) : geoError("network");
  }
  if (!Array.isArray(results) || !results.length) throw geoError("place_not_found", { text: q });
  const r = results[0];
  const a = r.address || {};
  const stateName = a.state || null;
  const stateAbbr = stateName ? abbrForName(stateName) : null;
  const place = tidyPlace(a.city || a.town || a.village || a.county || r.name || "", stateAbbr);
  const zip = /^\d{5}$/.test(String(a.postcode || "")) ? a.postcode : null;
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    label: [place, stateAbbr || stateName].filter(Boolean).join(", ") || String(r.display_name || q),
    place: place || null,
    zip,
    state: stateName,
    stateAbbr,
  };
}

/** Resolve free-form user input (ZIP or address) to a location that has a US
 *  state. Rejects with a coded error; never resolves a stateless place, since
 *  every answer in the app is given per state. `.method` on the result says
 *  which path it took ("zip" | "address") for analytics. */
export async function geocodeInput(text) {
  const q = String(text || "").trim();
  if (!q) throw geoError("empty");
  const digits = q.replace(/[\s-]/g, "");
  if (/^\d{5}(-\d{4})?$/.test(q)) {
    const loc = await geocodeZip(q.slice(0, 5));
    if (!loc.stateAbbr) throw geoError("no_state");
    return { ...loc, method: "zip" };
  }
  if (/^\d+$/.test(digits)) throw geoError("zip_invalid");
  const loc = await geocodeAddress(q);
  if (!loc.stateAbbr) throw geoError("no_state");
  return { ...loc, method: "address" };
}

/** Great-circle distance in miles. */
export function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
