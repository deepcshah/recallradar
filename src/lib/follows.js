/* ─────────────────────────────────────────────────────────────────────────
 * FOLLOWS — "products I buy", and "since your last visit"
 *
 * A follow is a short phrase the reader types — "spinach", "Trader Joe's",
 * "infant formula" — and nothing more. It lives in this browser's
 * localStorage and nowhere else; the push subscription (./push.js) sends the
 * terms to the server only when the reader opts in to notifications, and
 * never with a location finer than the state.
 *
 * Every storage access is wrapped: localStorage throws outright in some
 * private windows and in sandboxed previews, and a missing list must read as
 * "no follows yet", never as a crash.
 *
 * Matching is deliberately literal and deliberately narrow:
 *
 *   - It reads the product name and the firm only, not the recall reason. A
 *     follow on "milk" is about the milk someone buys; matching it against
 *     every "undeclared milk" allergen notice would bury the one that matters
 *     under chocolate bars and cookies.
 *   - Each word of the term must start a word in the text ("egg" finds
 *     "Eggs", "trader joes" finds "Trader Joe's"), in any order. No fuzzy
 *     matching — a follow that fires on a near-miss teaches people to ignore
 *     it, and a miss here is never presented as an all-clear anyway.
 * ───────────────────────────────────────────────────────────────────────── */

const FOLLOWS_KEY = "rr-follows";
const LAST_VISIT_KEY = "rr-last-visit";
const MAX_FOLLOWS = 50;
const MAX_TERM = 60;

/** Dispatched on window after any change, so separate components (and other
 *  tabs, via the native `storage` event) can re-read without a shared store. */
export const FOLLOWS_EVENT = "rr-follows-change";

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
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch (_) {
    return false;
  }
}

function cleanTerm(term) {
  return String(term == null ? "" : term).replace(/\s+/g, " ").trim().slice(0, MAX_TERM);
}

/** Folds case, curly and straight apostrophes, and punctuation, so "Trader
 *  Joe's" and "trader joes" are the same follow and match the same text. */
function fold(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function announce(list) {
  try {
    window.dispatchEvent(new CustomEvent(FOLLOWS_EVENT, { detail: list }));
  } catch (_) { /* no window (SSR, node) — nothing is listening anyway */ }
}

/** The reader's follow terms, in the order they were added. */
export function getFollows() {
  const v = readJSON(FOLLOWS_KEY, []);
  return Array.isArray(v) ? v.map(cleanTerm).filter(Boolean) : [];
}

/** Add a term; a duplicate (after folding) is a no-op. Returns the new list. */
export function addFollow(term) {
  const t = cleanTerm(term);
  const list = getFollows();
  if (!t || !fold(t) || list.some((x) => fold(x) === fold(t))) return list;
  const next = [...list, t].slice(-MAX_FOLLOWS);
  writeJSON(FOLLOWS_KEY, next);
  announce(next);
  return next;
}

/** Remove a term (matched after folding). Returns the new list. */
export function removeFollow(term) {
  const key = fold(term);
  const list = getFollows();
  const next = list.filter((x) => fold(x) !== key);
  if (next.length !== list.length) {
    writeJSON(FOLLOWS_KEY, next);
    announce(next);
  }
  return next;
}

/** Does one folded term match one record? Every word of the term must begin
 *  a word of the product or firm. Exported for the push digest, which runs
 *  the same test server-side against the national index. */
export function followMatches(record, term) {
  const words = fold(term).split(" ").filter(Boolean);
  if (!words.length || !record) return false;
  const hay = " " + fold(`${record.product || ""} ${record.firm || ""}`) + " ";
  return words.every((w) => hay.includes(" " + w));
}

/** [{ term, records }] for every follow with at least one match, in follow
 *  order. A follow with no match is left out rather than listed empty — the
 *  caller decides how to say "nothing matched", and must not say "safe". */
export function matchFollows(records, follows) {
  const list = Array.isArray(follows) ? follows : getFollows();
  const recs = Array.isArray(records) ? records : [];
  const out = [];
  for (const term of list) {
    const hits = recs.filter((r) => followMatches(r, term));
    if (hits.length) out.push({ term, records: hits });
  }
  return out;
}

/** When this browser last opened the app, as an ISO string, or null on a
 *  first visit (or when storage is unavailable). */
export function getLastVisit() {
  const v = readJSON(LAST_VISIT_KEY, null);
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/** Stamp now as the last visit and return the PREVIOUS value, so a caller
 *  can read "since your last visit" and move the marker in one step without
 *  racing itself. */
export function markVisit() {
  const prev = getLastVisit();
  writeJSON(LAST_VISIT_KEY, new Date().toISOString());
  return prev;
}

/* ─────────────────────────────────────────────────────────────────────────
 * FOLLOWED RECALLS — "notify me about updates" on one specific notice
 *
 * Stored beside the terms, in this browser only (`rr-follow-recalls`):
 *
 *   [{ id, title, snap, at }]
 *
 * `title` is the product line as the reader saw it (public notice text, kept
 * so the Alerts list can still name a recall that has since left the index);
 * `snap` is recall-watch.js recallSnapshot() at the moment it was followed —
 * or at the moment the reader last marked its update as read — and is what
 * the in-app inbox diffs against. The ids (never the titles) go to the server
 * only when an alert channel is on; the server takes its own snapshot.
 * ───────────────────────────────────────────────────────────────────────── */
const RECALLS_KEY = "rr-follow-recalls";
const ALERTS_SEEN_KEY = "rr-alerts-seen";
/** Matches the server's cap (push-store.js MAX_RECALLS). */
export const MAX_FOLLOWED_RECALLS = 50;

function cleanEntry(e) {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id || e.id.length > 100) return null;
  return {
    id: e.id,
    title: String(e.title || "").slice(0, 160),
    snap: e.snap && typeof e.snap === "object" ? e.snap : null,
    at: typeof e.at === "string" ? e.at : null,
  };
}

/** [{ id, title, snap, at }], oldest first. */
export function getFollowedRecalls() {
  const v = readJSON(RECALLS_KEY, []);
  return Array.isArray(v) ? v.map(cleanEntry).filter(Boolean) : [];
}

export function getFollowedRecallIds() {
  return getFollowedRecalls().map((e) => e.id);
}

export function isFollowingRecall(id) {
  return getFollowedRecalls().some((e) => e.id === id);
}

/** Dispatched for changes that matter to the Alerts inbox but not to the
 *  server (a snapshot acknowledged, the inbox marked read), so they don't
 *  trigger a channel sync the way FOLLOWS_EVENT does. */
export const ALERTS_EVENT = "rr-alerts-change";

function announceAlerts() {
  try { window.dispatchEvent(new CustomEvent(ALERTS_EVENT)); } catch (_) { /* no window */ }
}

function saveRecalls(list, { sync = true } = {}) {
  const next = list.slice(-MAX_FOLLOWED_RECALLS);
  writeJSON(RECALLS_KEY, next);
  if (sync) announce(getFollows());
  announceAlerts();
  return next;
}

/** Follow one recall. `snap` is recallSnapshot() of the best copy the caller
 *  has (the index record when there is one). Returns { ok, list, full }:
 *  `full` when the cap is reached — the caller says so rather than silently
 *  dropping the oldest. */
export function followRecall({ id, title, snap }) {
  const list = getFollowedRecalls();
  if (!id || list.some((e) => e.id === id)) return { ok: true, list, full: false };
  if (list.length >= MAX_FOLLOWED_RECALLS) return { ok: false, list, full: true };
  const next = saveRecalls([...list, cleanEntry({ id, title, snap, at: new Date().toISOString() })]);
  return { ok: true, list: next, full: false };
}

export function unfollowRecall(id) {
  const list = getFollowedRecalls();
  const next = list.filter((e) => e.id !== id);
  if (next.length !== list.length) saveRecalls(next);
  return next;
}

/** After an update has been read: store the new snapshot as the baseline. */
export function acknowledgeRecall(id, snap) {
  const list = getFollowedRecalls();
  let changed = false;
  const next = list.map((e) => {
    if (e.id !== id || !snap) return e;
    changed = true;
    return { ...e, snap };
  });
  if (changed) saveRecalls(next, { sync: false });
  return next;
}

/** When the reader last marked the Alerts inbox as read (ISO), or null. */
export function getAlertsSeen() {
  const v = readJSON(ALERTS_SEEN_KEY, null);
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

export function markAlertsSeen(when = new Date().toISOString()) {
  writeJSON(ALERTS_SEEN_KEY, when);
  announceAlerts();
  return when;
}
