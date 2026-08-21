/* Geolocation + geocoding helpers.
 * Location shape: { lat, lon, label, state, stateAbbr }
 */
import { abbrForName } from "./states.js";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const ZIPPO = "https://api.zippopotam.us/us/";

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** Browser geolocation wrapped in a promise. */
export function browserPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "Could not determine your position.")),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  });
}

/** Reverse geocode coordinates to a place label + US state. */
export async function reverseGeocode(lat, lon) {
  const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
  const data = await fetchJSON(url);
  const a = data.address || {};
  const stateName = a.state || null;
  const stateAbbr = stateName ? abbrForName(stateName) : null;
  const place = a.city || a.town || a.village || a.county || data.name || "";
  const label = [place, stateAbbr || stateName].filter(Boolean).join(", ") || data.display_name || "Your location";
  return { lat, lon, label, state: stateName, stateAbbr };
}

/** Geocode a 5-digit US ZIP via Zippopotam (fast, generous CORS). */
async function geocodeZip(zip) {
  const data = await fetchJSON(ZIPPO + encodeURIComponent(zip));
  const p = (data.places || [])[0];
  if (!p) throw new Error("ZIP code not found.");
  return {
    lat: parseFloat(p.latitude),
    lon: parseFloat(p.longitude),
    label: `${p["place name"]}, ${p["state abbreviation"]} ${zip}`,
    state: p.state,
    stateAbbr: p["state abbreviation"],
  };
}

/** Geocode a free-text US address via Nominatim. */
async function geocodeAddress(q) {
  const url = `${NOMINATIM}/search?format=jsonv2&countrycodes=us&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const results = await fetchJSON(url);
  if (!results.length) throw new Error("Address not found — try a ZIP code instead.");
  const r = results[0];
  const a = r.address || {};
  const stateName = a.state || null;
  const stateAbbr = stateName ? abbrForName(stateName) : null;
  const place = a.city || a.town || a.village || a.county || r.name || "";
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    label: [place, stateAbbr || stateName].filter(Boolean).join(", ") || r.display_name,
    state: stateName,
    stateAbbr,
  };
}

/** Resolve free-form user input (ZIP or address) to a location. */
export function geocodeInput(text) {
  const q = text.trim();
  if (/^\d{5}(-\d{4})?$/.test(q)) return geocodeZip(q.slice(0, 5));
  return geocodeAddress(q);
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
