/* ─────────────────────────────────────────────────────────────────────────
 * PUSH — the browser half of "tell me when something is recalled here"
 *
 * The server half is api/push.js (stores the subscription) and
 * api/_lib/send-digest.js (the crons that send). What leaves this browser when
 * someone opts in is the push subscription itself, the two-letter state,
 * their follow terms, the ids of recalls they follow and their two delivery
 * preferences — never coordinates, a ZIP, or a store. Same line as analytics
 * (see the README).
 *
 * Three platform facts shape the API:
 *
 *   1. Permission must be requested from a user gesture. `subscribePush`
 *      is therefore the ONLY function here that can prompt, and it should be
 *      called straight from a click handler. Everything else is silent.
 *   2. iOS/iPadOS Safari only exposes PushManager to a web app launched from
 *      the home screen (16.4+). In a normal Safari tab `pushSupported()` is
 *      false, and the honest thing to show is "Add to Home Screen first", not
 *      a greyed-out bell — `needsInstallForPush()` tells the UI which.
 *   3. A deployment may have push switched off (no VAPID keys, no Blob). GET
 *      /api/push says so, and `pushAvailable()` caches the answer,
 *      so the UI can hide the offer rather than prompt for a permission that
 *      would deliver nothing.
 *
 * Functions that can fail return { ok:false, reason, message } instead of
 * throwing, with `message` written to be shown as-is.
 * ───────────────────────────────────────────────────────────────────────── */

const SW_URL = "/sw.js";
const API = "/api/push";

function hasWindow() {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

/** Can this browser, in this context, receive web push at all? */
export function pushSupported() {
  if (!hasWindow()) return false;
  return Boolean(
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isIOS() {
  if (!hasWindow()) return false;
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  if (!hasWindow()) return false;
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch (_) { /* old engines */ }
  return navigator.standalone === true;
}

/** True on iPhone/iPad in a Safari tab: push exists on the platform, but only
 *  once the site is added to the Home Screen and opened from there. The UI
 *  should say that instead of offering a button that cannot work. */
/** Safari on iPhone/iPad, in a tab rather than from the Home Screen: where
 *  WebKit clears a site's storage after seven days without a visit. Added to
 *  the Home Screen, the site keeps its data (and can get push). */
export function needsInstallToKeepData() {
  return isIOS() && !isStandalone();
}

export function needsInstallForPush() {
  return isIOS() && !isStandalone() && !pushSupported();
}

/** Register /sw.js. Safe to call repeatedly; resolves to the registration or
 *  null. `updateViaCache: "none"` makes the browser revalidate sw.js itself on
 *  every check, so a fixed worker ships with the next deploy rather than
 *  after the HTTP cache expires. */
export async function registerServiceWorker() {
  if (!hasWindow() || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
  } catch (_) {
    return null;
  }
}

let availability = null;
/** { enabled, publicKey?, reason? } from the server, memoized per page load. */
export function pushAvailable() {
  if (!availability) {
    availability = fetch(API, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : { enabled: false, reason: `HTTP ${r.status}` }))
      .catch(() => ({ enabled: false, reason: "offline" }))
      .then((v) => {
        if (!v || !v.enabled) availability = null; // let a later call retry
        return v || { enabled: false };
      });
  }
  return availability;
}

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (!existing && !(await registerServiceWorker())) return null;
  // pushManager.subscribe needs an ACTIVE worker, and a registration made a
  // moment ago (dev builds register lazily, here) may still be installing.
  return navigator.serviceWorker.ready;
}

/* The server takes at most 20 terms of at most 40 characters and rejects
 * rather than clips (see src/lib/push-store.js); follows.js allows longer.
 * So send what fits, and say what didn't instead of truncating a term into
 * something the reader never typed. */
export function fitFollows(follows) {
  const all = (Array.isArray(follows) ? follows : []).map((t) => String(t).replace(/\s+/g, " ").trim()).filter(Boolean);
  const sent = all.filter((t) => t.length <= 40).slice(0, 20);
  return { sent, dropped: all.filter((t) => !sent.includes(t)) };
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch (_) {
    return null;
  }
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

/** 'unsupported' | 'needs-install' | 'denied' | 'subscribed' | 'available'.
 *  Never prompts. */
export async function getPushState() {
  if (needsInstallForPush()) return "needs-install";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return (await currentSubscription()) ? "subscribed" : "available";
}

async function send(method, body) {
  const res = await fetch(API, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { res, json };
}

/** Opt in, or update what an existing subscription follows. Call from a click
 *  handler: this is the one function that may show the permission prompt.
 *
 *  @param {{ stateAbbr: string, follows?: string[], recalls?: string[], prefs?: {weekly, urgent} }} opts
 *  @returns {Promise<{ok:true, stateAbbr, follows} | {ok:false, reason, message}>}
 */
export async function subscribePush({ stateAbbr, follows = [], recalls = [], prefs } = {}) {
  if (needsInstallForPush()) {
    return fail("needs-install", "On iPhone and iPad, add Yanked to your Home Screen (Share → Add to Home Screen), open it from there, then turn on alerts.");
  }
  if (!pushSupported()) return fail("unsupported", "This browser can't receive notifications from websites.");
  if (!stateAbbr) return fail("no-state", "Set your location first, so alerts can be about your state.");

  const cfg = await pushAvailable();
  if (!cfg.enabled || !cfg.publicKey) return fail("disabled", "Alerts aren't switched on for this site yet.");

  let permission = Notification.permission;
  if (permission === "default") {
    try { permission = await Notification.requestPermission(); } catch (_) { permission = "denied"; }
  }
  if (permission !== "granted") {
    return fail("denied", "Notifications are blocked for this site. You can allow them in your browser's site settings.");
  }

  try {
    const reg = await registration();
    if (!reg) return fail("no-worker", "Couldn't start the background service that delivers alerts.");
    let sub = await reg.pushManager.getSubscription();
    const key = keyBytes(cfg.publicKey);
    // A subscription made under an older VAPID key can't receive our pushes;
    // replace it rather than store something undeliverable.
    if (sub && sub.options && sub.options.applicationServerKey) {
      const had = new Uint8Array(sub.options.applicationServerKey);
      if (had.length !== key.length || had.some((b, i) => b !== key[i])) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

    const fit = fitFollows(follows);
    const { res, json } = await send("POST", {
      subscription: sub.toJSON(),
      stateAbbr: String(stateAbbr).toUpperCase(),
      follows: fit.sent,
      recalls: (Array.isArray(recalls) ? recalls : []).slice(-50),
      ...(prefs ? { prefs: { weekly: prefs.weekly !== false, urgent: prefs.urgent !== false } } : null),
    });
    if (!res.ok) {
      return fail("server", (json && (json.error || json.reason)) || `Couldn't save your alert settings (HTTP ${res.status}).`);
    }
    // `dropped`: follows too long (over 40 characters) or past the 20th,
    // which alerts won't watch — the UI should say so rather than hide it.
    return { ok: true, stateAbbr: json.stateAbbr, follows: json.follows, dropped: fit.dropped };
  } catch (err) {
    return fail("error", `Couldn't turn on alerts: ${String((err && err.message) || err).slice(0, 120)}`);
  }
}

/** Keep the server's copy of state/follows in step after the reader changes
 *  them — only if they're already subscribed, and never prompting. */
export async function syncPush({ stateAbbr, follows = [], recalls = [], prefs } = {}) {
  const sub = await currentSubscription();
  if (!sub || !stateAbbr || Notification.permission !== "granted") return { ok: false, reason: "not-subscribed" };
  return subscribePush({ stateAbbr, follows, recalls, prefs });
}

/** Opt out: remove the server copy, then the browser subscription. */
export async function unsubscribePush() {
  const sub = await currentSubscription();
  if (!sub) return { ok: true };
  try {
    await send("DELETE", { endpoint: sub.endpoint });
  } catch (_) { /* still unsubscribe locally; the next send's 410 cleans up */ }
  try {
    await sub.unsubscribe();
    return { ok: true };
  } catch (err) {
    return fail("error", `Couldn't turn off alerts: ${String((err && err.message) || err).slice(0, 120)}`);
  }
}
