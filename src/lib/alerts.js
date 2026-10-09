/* ─────────────────────────────────────────────────────────────────────────
 * ALERTS — the browser half of follows, the inbox, and delivery
 *
 *   - Delivery preferences (weekly state digest, urgent Class I in-state),
 *     kept in this browser (`rr-alert-prefs`) and sent with whichever
 *     channel is on.
 *   - Email: the address and two opaque values the server handed back (`id`,
 *     `manage`) are kept here (`rr-alerts-email`) so this browser can keep
 *     the server's copy of follows in step and show "check your inbox" vs
 *     "on". The address leaves the browser ONLY when the reader presses
 *     "Email me" — see the README's privacy section.
 *   - The in-app inbox (computeInbox): what is new for the reader's follows
 *     since they last marked it read, computed entirely here from the
 *     national index plus whatever live lists the app has loaded. It needs no
 *     channel, no server and no account.
 *
 * Functions that can fail return { ok:false, message } with a sentence that
 * can be shown as-is, never throw.
 * ───────────────────────────────────────────────────────────────────────── */
import { pushAvailable, syncPush, fitFollows } from "./push.js";
import { getFollows, getFollowedRecallIds, followMatches, addFollow, followRecall } from "./follows.js";
import { diffRecall, followRelevant } from "./recall-watch.js";
import { newsDay } from "./digest.js";

const PREFS_KEY = "rr-alert-prefs";
const EMAIL_KEY = "rr-alerts-email";
const API = "/api/push";
export const PREFS_EVENT = "rr-alert-prefs-change";
/** The email subscription in this browser changed (subscribed, confirmed, off). */
export const EMAIL_EVENT = "rr-alerts-email-change";

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}
function writeJSON(key, v) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch (_) {
    return false;
  }
}
function emit(name) {
  try { window.dispatchEvent(new CustomEvent(name)); } catch (_) { /* no window */ }
}

// ------------------------------------------------------------ preferences
export function getAlertPrefs() {
  const v = readJSON(PREFS_KEY, {});
  return { weekly: v.weekly !== false, urgent: v.urgent !== false };
}

export function setAlertPrefs(next) {
  const p = { ...getAlertPrefs(), ...next };
  writeJSON(PREFS_KEY, { weekly: !!p.weekly, urgent: !!p.urgent });
  emit(PREFS_EVENT);
  return p;
}

// ------------------------------------------------------------ availability
/** { push: {enabled, reason?}, email: {enabled, reason?} } from GET /api/push.
 *  Anything unreadable (offline, an older server, no /api at all) is "not
 *  available", with the reason — never an exception. */
export async function alertChannels() {
  const v = await pushAvailable();
  const ch = (v && v.channels) || {};
  const off = (reason) => ({ enabled: false, reason });
  const why = v && v.reason === "offline" ? "The alerts service couldn't be reached." : (v && v.reason) || "Not switched on for this site.";
  return {
    push: ch.push && typeof ch.push.enabled === "boolean" ? ch.push : (v && v.enabled ? { enabled: true } : off(why)),
    email: ch.email && typeof ch.email.enabled === "boolean" ? ch.email : off(why),
  };
}

// ------------------------------------------------------------ email
/** { address, id, manage, status: 'pending'|'confirmed' } | null */
export function getEmailSub() {
  const v = readJSON(EMAIL_KEY, null);
  if (!v || typeof v.address !== "string" || !/^[a-f0-9]{64}$/.test(v.id || "") || typeof v.manage !== "string") return null;
  return { address: v.address, id: v.id, manage: v.manage, status: v.status === "confirmed" ? "confirmed" : "pending" };
}

function saveEmailSub(v) {
  writeJSON(EMAIL_KEY, v);
  emit(EMAIL_EVENT);
}

/** What every channel is told about the reader's follows and preferences. */
export function channelPayload() {
  const fit = fitFollows(getFollows());
  return { follows: fit.sent, dropped: fit.dropped, recalls: getFollowedRecallIds().slice(-50), prefs: getAlertPrefs() };
}

async function post(action, body) {
  let res;
  try {
    res = await fetch(`${API}?channel=email&action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return { res: null, json: null };
  }
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { res, json };
}

/* ── Restore from email ──────────────────────────────────────────────────
 * When this browser has lost its follows (see requestPersistentStorage in
 * follows.js), the person's inbox is the credential they still hold. Asking
 * sends a single-use link to /?restore=<id>.<token>; redeeming it — only on
 * a button press — merges the server's copy into this browser and gives this
 * browser its own manage token. */
export async function requestRestore(email) {
  const address = String(email || "").trim();
  if (!address) return { ok: false, message: "Enter the email address your alerts go to." };
  const { res, json } = await post("restore-request", { email: address });
  if (!res) return { ok: false, message: "Couldn't reach the alerts service. Check your connection and try again." };
  if (!res.ok || !json || !json.ok) return { ok: false, message: (json && (json.error || json.message)) || `Couldn't send a restore link (HTTP ${res.status}).` };
  return { ok: true, message: json.message };
}

/** The ?restore=<id>.<token> on this page's URL, or null. */
export function restoreParamFromUrl(search) {
  try {
    const v = new URLSearchParams(search ?? window.location.search).get("restore") || "";
    const m = /^([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(v);
    return m ? { id: m[1], token: m[2] } : null;
  } catch (_) {
    return null;
  }
}

/** Redeem a restore link: merge follows, followed recalls and preferences
 *  into this browser (nothing here is removed), and keep the subscription.
 *  Returns { ok, stateAbbr, terms, recalls } or { ok:false, message }. */
export async function redeemRestore({ id, token }) {
  const { res, json } = await post("restore", { id, token });
  if (!res) return { ok: false, message: "Couldn't reach the alerts service. Check your connection and try again." };
  if (!res.ok || !json || !json.ok) return { ok: false, message: (json && json.error) || `Couldn't restore (HTTP ${res.status}).` };
  saveEmailSub({ address: String(json.email || "").toLowerCase(), id: json.id, manage: json.manage, status: "confirmed" });
  const terms = Array.isArray(json.follows) ? json.follows : [];
  const recalls = Array.isArray(json.recalls) ? json.recalls : [];
  for (const t of terms) addFollow(t);
  /* No snapshot: the next inbox computation takes today's state as the
   * baseline, so a restore can never announce an "update" that is really
   * just the restore. */
  for (const r of recalls) if (r && r.id) followRecall({ id: r.id, title: r.title || "", snap: null });
  if (json.prefs) setAlertPrefs(json.prefs);
  return { ok: true, stateAbbr: json.stateAbbr || null, terms: terms.length, recalls: recalls.length };
}

/** Ask for email alerts: the server emails a confirmation link. */
export async function subscribeEmail({ email, stateAbbr }) {
  const address = String(email || "").trim();
  if (!address) return { ok: false, message: "Enter an email address." };
  if (!stateAbbr) return { ok: false, message: "Set your location first, so alerts can be about your state." };
  const { follows, recalls, prefs, dropped } = channelPayload();
  const { res, json } = await post("subscribe", { email: address, stateAbbr, follows, recalls, prefs });
  if (!res) return { ok: false, message: "Couldn't reach the alerts service. Check your connection and try again." };
  if (!res.ok || !json || !json.ok) {
    return { ok: false, message: (json && json.error) || `Couldn't start email alerts (HTTP ${res.status}).` };
  }
  saveEmailSub({ address: address.toLowerCase(), id: json.id, manage: json.manage, status: "pending" });
  return { ok: true, status: "pending", dropped };
}

/** Ask the server whether the address has been confirmed yet. */
export async function refreshEmailStatus() {
  const sub = getEmailSub();
  if (!sub) return null;
  const { res, json } = await post("status", { id: sub.id, manage: sub.manage });
  if (!res || !res.ok || !json) return sub; // unknown: keep what we had
  if (json.status === "none") {
    saveEmailSub(null); // unsubscribed from an email, or the request expired
    return null;
  }
  const next = { ...sub, status: json.status === "confirmed" ? "confirmed" : "pending" };
  if (next.status !== sub.status) saveEmailSub(next);
  return next;
}

/** Keep the server's copy in step. Silent; does nothing without a sub. */
export async function syncEmail({ stateAbbr } = {}) {
  const sub = getEmailSub();
  if (!sub) return { ok: false, reason: "not-subscribed" };
  const { follows, recalls, prefs } = channelPayload();
  const body = { id: sub.id, manage: sub.manage, follows, recalls, prefs };
  if (stateAbbr) body.stateAbbr = stateAbbr;
  const { res, json } = await post("update", body);
  if (res && res.ok && json && json.status === "none") saveEmailSub(null);
  return { ok: Boolean(res && res.ok) };
}

/** Turn email alerts off: the server deletes the record. */
export async function removeEmail() {
  const sub = getEmailSub();
  if (!sub) return { ok: true };
  const { res } = await post("remove", { id: sub.id, manage: sub.manage });
  if (!res || !res.ok) return { ok: false, message: "Couldn't reach the alerts service to turn email off. Try again, or use the unsubscribe link in any alert email." };
  saveEmailSub(null);
  return { ok: true };
}

/** After follows, followed recalls, preferences or the state change: tell
 *  every channel that is on. Never prompts; does nothing for channels off. */
export async function syncChannels({ stateAbbr } = {}) {
  const { follows, recalls, prefs } = channelPayload();
  const jobs = [];
  if (stateAbbr) jobs.push(syncPush({ stateAbbr, follows, recalls, prefs }).catch(() => null));
  jobs.push(syncEmail({ stateAbbr }).catch(() => null));
  await Promise.all(jobs);
}

// ------------------------------------------------------------ inbox
const DAY_MS = 24 * 60 * 60 * 1000;
/** With no "read" marker yet, how far back the inbox looks. */
export const INBOX_FIRST_DAYS = 14;

/**
 * What is new for the reader's follows. Pure.
 *
 * @param {object}   o
 * @param {object[]} o.records     every record available: the index's recalls
 *                                 plus live lists (deduped by id here; the
 *                                 index copy wins, as in the recall sheet)
 * @param {string[]} o.terms       follow terms
 * @param {object[]} o.followed    follows.js getFollowedRecalls()
 * @param {string|null} o.since    ISO marker (getAlertsSeen), or null
 * @param {string|null} o.stateAbbr the reader's own state
 * @param {number}   [o.now]
 * @returns {{ updates: [{id, title, record, changes, next}],
 *             matches: [{term, records}], count, sinceDay }}
 */
export function computeInbox({ records = [], terms = [], followed = [], since = null, stateAbbr = null, now = Date.now() }) {
  const byId = new Map();
  for (const r of records) if (r && r.id && !byId.has(r.id)) byId.set(r.id, r);
  const all = [...byId.values()];
  const sinceDay = (since ? new Date(since) : new Date(now - INBOX_FIRST_DAYS * DAY_MS)).toISOString().slice(0, 10);

  const updates = [];
  for (const f of followed) {
    const current = byId.get((f.snap && f.snap.m) || f.id) || null;
    const { changes, next, record } = diffRecall(f.snap, current, all);
    if (changes.length) updates.push({ id: f.id, title: f.title, record, changes, next });
  }

  const followedIds = new Set(followed.map((f) => f.id));
  const fresh = all.filter((r) => newsDay(r) > sinceDay && !followedIds.has(r.id) && followRelevant(r, stateAbbr));
  const matches = [];
  for (const term of terms) {
    const hits = fresh.filter((r) => followMatches(r, term))
      .sort((a, b) => newsDay(b).localeCompare(newsDay(a)));
    if (hits.length) matches.push({ term, records: hits });
  }
  const ids = new Set(matches.flatMap((m) => m.records.map((r) => r.id)));
  return { updates, matches, count: updates.length + ids.size, sinceDay };
}
