/* Email alert subscribers: what one may contain, how it is keyed, how its
 * tokens work. The handlers are email-channel.js; the sending is the shared
 * engine (alerts-engine.js) driven by send-digest.js.
 *
 * ONE FILE PER ADDRESS, at alerts/email/<key>.json, where
 *
 *     key = HMAC-SHA256(ALERTS_SECRET, normalized address)   (hex)
 *
 * A plain hash of an email address is not a pseudonym — anyone holding a
 * list of addresses can hash them and look for matches — so the key is keyed
 * with a server secret. The file itself holds:
 *
 *   { email,                     the address, as confirmed
 *     stateAbbr, follows,        same limits as push (push-store.js)
 *     recalls, snapshots,        followed recall ids (≤50) and the public
 *                                recall fields the cron diffs
 *     prefs: { weekly, urgent },
 *     confirmed: bool, confirmedAt,
 *     manageHash,                SHA-256 of the browser's manage token
 *     manageHashes: [hash, …],   more browsers, added by restores (≤5)
 *     restore: { tokenHash, expiresAt } | null,   a pending restore link
 *     unsubSalt,                 random; see UNSUBSCRIBE below
 *     pending: { tokenHash, manageHash, stateAbbr, follows, recalls, prefs,
 *                expiresAt } | null,
 *     sends: [ISO, …],           confirmation emails sent (rate limit)
 *     lastSentIds, lastSentAt, createdAt, updatedAt }
 *
 * and nothing else: no IP address, no user agent, no location finer than the
 * state, no name.
 *
 * TOKENS.
 *   confirm  32 random bytes, sent once in the confirmation email; only its
 *            SHA-256 is stored, compared in constant time; expires in 48h;
 *            single use (cleared on confirm).
 *   manage   32 random bytes, returned to the browser that subscribed and
 *            kept there; only its SHA-256 is stored. It lets that browser
 *            sync follows and preferences, and only becomes valid once the
 *            address owner clicks the confirmation link — so subscribing
 *            someone else's address gets you nothing.
 *   unsubscribe  HMAC-SHA256(ALERTS_SECRET, "unsub:" + key + ":" + unsubSalt).
 *            Not stored at all: every alert email must carry a working
 *            one-click link, and the cron cannot put a token in an email if
 *            only its hash was kept. Deriving it means a leaked Blob store
 *            yields no working unsubscribe links (the secret is not in it),
 *            and deleting the record (which unsubscribing does) kills it.
 *
 * TESTS. setEmailStoreForTests(memoryStore(EMAIL_PREFIX)) swaps the Blob
 * store; nothing here touches the network itself.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  makeBlobStore, cleanState, cleanFollows, cleanRecallIds, cleanPrefs, MAX_FOLLOWS, MAX_FOLLOW_CHARS, MAX_RECALLS,
} from "../../src/lib/push-store.js";
import { blobConfigured } from "../../src/lib/blob.js";

export const EMAIL_PREFIX = "alerts/email/";
export const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
/** Pending (never confirmed) records are deleted by the daily cron after this. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Confirmation sends per address: at most this many per day… */
export const MAX_SENDS_PER_DAY = 3;
/** …and never two within this long. */
export const MIN_SEND_GAP_MS = 2 * 60 * 1000;
/* A restore link (see handleRestoreRequest in email-channel.js) is short-lived
 * and single-use: it hands the person a fresh manage token for their
 * subscription, so it should not outlive the moment they asked for it. */
export const RESTORE_TTL_MS = 30 * 60 * 1000;
/* Devices that can manage one subscription at once: each restore adds one, the
 * oldest falls off. A browser whose token falls off sees "none" and can
 * restore again. */
export const MAX_MANAGE_TOKENS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ configuration
/** Email alerts need all of these; anything missing is named, so GET
 *  /api/push can say "not available yet" and why. */
export function emailConfig(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.ALERTS_FROM || "").trim();
  const secret = String(env.ALERTS_SECRET || "").trim();
  const missing = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from || !/<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$|^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(from)) missing.push("ALERTS_FROM");
  if (secret.length < 32) missing.push("ALERTS_SECRET (32+ characters)");
  if (!String(env.CRON_SECRET || "").trim()) missing.push("CRON_SECRET");
  if (missing.length) return { ok: false, reason: `Email alerts need ${missing.join(", ")} on this deployment.` };
  if (!blobConfigured()) return { ok: false, reason: "No Vercel Blob store is attached, so there is nowhere to keep subscribers." };
  /* Email addresses identify people. In a public Blob store each subscriber
   * file is readable by anyone holding its URL — unguessable, but one leaked
   * log line away from a list of addresses. So email stays off until the
   * alerts have their own store, created private (ALERTS_BLOB_READ_WRITE_TOKEN,
   * see src/lib/blob.js); push records hold no personal data and keep working
   * on the main store either way. */
  if (!String(env.ALERTS_BLOB_READ_WRITE_TOKEN || "").trim()) {
    return { ok: false, reason: "Email alerts need their own private Blob store (ALERTS_BLOB_READ_WRITE_TOKEN): subscriber files hold email addresses." };
  }
  return { ok: true, apiKey, from, secret, baseUrl: baseUrl(env) };
}

/** Where links in emails point. Never the request's Host header: a forged
 *  Host would put the confirmation token in a link to someone else's site. */
export function baseUrl(env = process.env) {
  const explicit = String(env.ALERTS_BASE_URL || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(explicit)) return explicit;
  const prod = String(env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  if (/^[a-z0-9.-]+$/i.test(prod)) return `https://${prod}`;
  return "https://yanked.app";
}

// ------------------------------------------------------------ validation
/* Deliberately narrower than RFC 5322: one @, a dot-atom local part, a
 * hostname with a TLD. Quoted local parts, IP-literal domains, comments and
 * anything with whitespace, angle brackets, commas or control characters are
 * refused — they are where header injection and "two recipients in one
 * field" tricks live, and no real reader needs them. */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{3,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** A normalized address (trimmed, lower-cased) or null. */
export function cleanEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (!e || e.length > 254) return null;
  const at = e.lastIndexOf("@");
  if (at < 1 || e.indexOf("@") !== at) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || !DOMAIN.test(domain)) return null;
  return e;
}

const SUBSCRIBE_KEYS = new Set(["email", "stateAbbr", "follows", "recalls", "prefs"]);
const UPDATE_KEYS = new Set(["id", "manage", "stateAbbr", "follows", "recalls", "prefs"]);
const AUTH_KEYS = new Set(["id", "manage"]);

function bad(error) { return { ok: false, error }; }

function checkPrefsAndLists(body, { partial }) {
  const out = {};
  if (!partial || body.stateAbbr !== undefined) {
    out.stateAbbr = cleanState(body.stateAbbr);
    if (!out.stateAbbr) return bad("stateAbbr must be a US state or territory code, e.g. \"CA\".");
  }
  if (!partial || body.follows !== undefined) {
    out.follows = cleanFollows(body.follows);
    if (out.follows === null) return bad(`follows must be an array of at most ${MAX_FOLLOWS} terms of at most ${MAX_FOLLOW_CHARS} characters.`);
  }
  if (!partial || body.recalls !== undefined) {
    out.recalls = cleanRecallIds(body.recalls);
    if (out.recalls === null) return bad(`recalls must be an array of at most ${MAX_RECALLS} recall ids.`);
  }
  if (!partial || body.prefs !== undefined) {
    out.prefs = cleanPrefs(body.prefs);
    if (out.prefs === null) return bad("prefs may only be { weekly: boolean, urgent: boolean }.");
  }
  return { ok: true, value: out };
}

function onlyKeys(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object.";
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return `Unexpected field "${k}". Only ${[...allowed].join(", ")} are accepted.`;
  }
  return null;
}

export function validateEmailSubscribe(body) {
  const why = onlyKeys(body, SUBSCRIBE_KEYS);
  if (why) return bad(why);
  const email = cleanEmail(body.email);
  if (!email) return bad("That doesn't look like an email address.");
  const rest = checkPrefsAndLists(body, { partial: false });
  if (!rest.ok) return rest;
  return { ok: true, value: { email, ...rest.value } };
}

const RESTORE_REQUEST_KEYS = new Set(["email"]);
const RESTORE_KEYS = new Set(["id", "token"]);

/** { email } — asking for a restore link. */
export function validateRestoreRequest(body) {
  const why = onlyKeys(body, RESTORE_REQUEST_KEYS);
  if (why) return bad(why);
  const email = cleanEmail(body.email);
  if (!email) return bad("That doesn't look like an email address.");
  return { ok: true, value: { email } };
}

/** { id, token } — redeeming one. */
export function validateRestore(body) {
  const why = onlyKeys(body, RESTORE_KEYS);
  if (why) return bad(why);
  if (!isKey(body.id) || !isToken(body.token)) return bad("This restore link looks incomplete. Ask for a new one.");
  return { ok: true, value: { id: body.id, token: body.token } };
}

/** Every manage-token hash that may act on a confirmed record: the original
 *  plus any added by restores, newest last. */
export function manageHashesOf(record) {
  const list = Array.isArray(record && record.manageHashes) ? record.manageHashes.filter((h) => typeof h === "string") : [];
  return record && record.manageHash && !list.includes(record.manageHash) ? [record.manageHash, ...list] : list;
}

const KEY_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isKey(v) { return typeof v === "string" && KEY_RE.test(v); }
export function isToken(v) { return typeof v === "string" && TOKEN_RE.test(v); }

/** { id, manage } for status/remove; plus partial prefs/lists for update. */
export function validateEmailManage(body, { update = false } = {}) {
  const why = onlyKeys(body, update ? UPDATE_KEYS : AUTH_KEYS);
  if (why) return bad(why);
  if (!isKey(body.id) || !isToken(body.manage)) return bad("id and manage must be the values this browser was given when it subscribed.");
  if (!update) return { ok: true, value: { id: body.id, manage: body.manage } };
  const rest = checkPrefsAndLists(body, { partial: true });
  if (!rest.ok) return rest;
  return { ok: true, value: { id: body.id, manage: body.manage, ...rest.value } };
}

// ------------------------------------------------------------ keys and tokens
export function emailKey(email, secret) {
  return createHmac("sha256", secret).update(String(email)).digest("hex");
}

export function pathFor(key) {
  return EMAIL_PREFIX + key + ".json";
}

/** 32 random bytes, base64url (43 chars). */
export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Constant-time: does `token` hash to `storedHash`? */
export function tokenMatches(token, storedHash) {
  if (!isToken(token) || typeof storedHash !== "string" || !KEY_RE.test(storedHash)) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function unsubscribeToken(key, salt, secret) {
  return createHmac("sha256", secret).update(`unsub:${key}:${salt}`).digest("base64url");
}

export function unsubscribeMatches(token, key, salt, secret) {
  if (!isToken(token) || !salt) return false;
  const a = Buffer.from(unsubscribeToken(key, salt, secret));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------ rate limit
/** Can another confirmation email go to this record now? Returns
 *  { ok:true, sends } (the trimmed history plus now) or { ok:false, retryAfter }. */
export function confirmSendAllowed(record, now = Date.now()) {
  const recent = (Array.isArray(record && record.sends) ? record.sends : [])
    .map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && now - t < DAY_MS).sort((a, b) => a - b);
  const last = recent[recent.length - 1];
  if (last != null && now - last < MIN_SEND_GAP_MS) {
    return { ok: false, retryAfter: Math.ceil((MIN_SEND_GAP_MS - (now - last)) / 1000) };
  }
  if (recent.length >= MAX_SENDS_PER_DAY) {
    return { ok: false, retryAfter: Math.ceil((recent[0] + DAY_MS - now) / 1000) };
  }
  return { ok: true, sends: [...recent, now].map((t) => new Date(t).toISOString()) };
}

// ------------------------------------------------------------ storage
let store = makeBlobStore(EMAIL_PREFIX);

export function emailStore() {
  return store;
}

/** Test hook: replace the store with { configured, read, write, remove, paths }.
 *  Pass null to restore Blob. */
export function setEmailStoreForTests(impl) {
  store = impl || makeBlobStore(EMAIL_PREFIX);
}
