/* Where push subscriptions live, and what one is allowed to contain.
 *
 * One Blob per subscription, at push/subs/<sha256(endpoint)>.json:
 *
 *   { subscription: { endpoint, keys: { p256dh, auth } },
 *     stateAbbr: "CA", follows: ["spinach", ...],
 *     createdAt, updatedAt, lastSentIds: [...] }
 *
 * One file per subscriber rather than one list for everybody, because Blob
 * has no transactions: two people subscribing in the same second would each
 * read the list, append themselves, and the second write would erase the
 * first. Per-subscriber files have no shared state to race on, and removing
 * a dead endpoint is a single delete.
 *
 * The key is a hash of the endpoint, not the endpoint itself. The endpoint is
 * a capability URL at Google/Mozilla/Apple — it must not appear in a pathname
 * that shows up in listings and logs — and hashing also gives a fixed-length,
 * path-safe name for a URL of any shape.
 *
 * WHAT IS NEVER STORED. The two-letter state and the follow terms, and that
 * is all the reader's side of the record holds: no coordinates, no ZIP, no
 * city, no store. That is the same line analytics draws (see the README) and
 * for the same reason — the state is the granularity the recall feeds are
 * scoped to, so it is the coarsest thing that still answers the question.
 * `validateSubscribeBody` rejects any other top-level field outright rather
 * than ignoring it, so a future client that starts sending `lat` fails
 * loudly in development instead of quietly succeeding.
 *
 * ACCESS. The existing store is public (the feed caches are written public),
 * and a public store refuses private writes, so the default follows it. The
 * pathname is an unguessable hash and the store id is never sent to a
 * browser; and the stored keys alone cannot send a push — the push service
 * also requires a signature from our VAPID private key. Set
 * PUSH_BLOB_ACCESS=private on a private store to take it further.
 *
 * TESTS. `setPushStoreForTests(impl)` swaps the Blob-backed store for any
 * object with the same four methods, so the handlers can be exercised in
 * node with no token and no network.
 * ───────────────────────────────────────────────────────────────────────── */
import { createHash } from "node:crypto";
import { put, get, del, list } from "@vercel/blob";
import { blobAuth, blobConfigured } from "./blob.js";
import { ABBR_TO_NAME } from "./states.js";

export const SUBS_PREFIX = "push/subs/";
export const MAX_FOLLOWS = 20;
export const MAX_FOLLOW_CHARS = 40;
/** Enough to dedupe a week of digests and urgents; older ids have left the
 *  lookback window the digest reads anyway. */
export const MAX_SENT_IDS = 400;

const ACCESS = process.env.PUSH_BLOB_ACCESS === "private" ? "private" : "public";

export function endpointKey(endpoint) {
  return SUBS_PREFIX + createHash("sha256").update(String(endpoint)).digest("hex") + ".json";
}

// ------------------------------------------------------------ validation
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const ALLOWED_KEYS = new Set(["subscription", "stateAbbr", "follows", "replaces"]);

function badRequest(message) {
  return { ok: false, error: message };
}

/* WHERE AN ENDPOINT MAY POINT. send-digest POSTs to every stored endpoint
 * from inside our own deployment, so "any https URL" would make this a
 * request-forgery relay: subscribe with https://169.254.169.254/… or
 * https://internal-service/… and the cron dutifully calls it, signed, every
 * day. A real PushSubscription only ever names one of the browsers' push
 * services, so the endpoint's host must be one of them:
 *
 *   Chrome, Edge (Chromium), Opera, Samsung   fcm.googleapis.com
 *   Firefox                                    *.push.services.mozilla.com
 *   Safari (macOS 13+, iOS 16.4+)              *.push.apple.com
 *   Legacy Edge / Windows                      *.notify.windows.com
 *
 * A browser that brings a new push service needs a line here — that is a
 * failed subscribe with a clear 400, not a silent hole. Exported so the tests
 * and the DELETE path share it. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushServiceHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return PUSH_HOSTS.some((re) => re.test(h));
}

/** Strict check of a PushSubscription.toJSON(). Returns the cleaned value or
 *  null. p256dh is an uncompressed P-256 point (65 bytes → 86–88 base64url
 *  chars); auth is a 16-byte secret (22–24 chars). */
export function cleanSubscription(s) {
  if (!s || typeof s !== "object") return null;
  const endpoint = typeof s.endpoint === "string" ? s.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 1024) return null;
  let u;
  try { u = new URL(endpoint); } catch (_) { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  if (!isPushServiceHost(u.hostname) || (u.port && u.port !== "443")) return null;
  const keys = s.keys || {};
  const { p256dh, auth } = keys;
  if (typeof p256dh !== "string" || !B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) return null;
  if (typeof auth !== "string" || !B64URL.test(auth) || auth.length < 16 || auth.length > 32) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export function cleanState(v) {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return ABBR_TO_NAME[s] ? s : null;
}

/** Follows: an array of at most 20 non-empty strings of at most 40 chars.
 *  Over-long input is rejected, not truncated — a silently clipped term would
 *  match things the reader never typed. Duplicates (case-folded) collapse. */
export function cleanFollows(v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_FOLLOWS) return null;
  const out = [];
  const seen = new Set();
  for (const t of v) {
    if (typeof t !== "string") return null;
    const term = t.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_FOLLOW_CHARS) return null;
    // Control characters have no business in a product phrase.
    if (/[\u0000-\u001f\u007f]/.test(term)) return null;
    const k = term.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(term); }
  }
  return out;
}

/** Validate a POST body. Returns { ok:true, value } or { ok:false, error }.
 *  With `replaces` (sent by the service worker on pushsubscriptionchange,
 *  which cannot read the reader's preferences) stateAbbr may be omitted and
 *  is carried over from the old record by the handler. */
export function validateSubscribeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest("Body must be a JSON object.");
  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) return badRequest(`Unexpected field "${k}". Only subscription, stateAbbr and follows are accepted.`);
  }
  const subscription = cleanSubscription(body.subscription);
  if (!subscription) return badRequest("subscription must be a PushSubscription with an https endpoint and p256dh/auth keys.");
  let replaces = null;
  if (body.replaces != null) {
    replaces = cleanSubscription({ endpoint: body.replaces, keys: subscription.keys }) ? String(body.replaces).trim() : null;
    if (!replaces) return badRequest("replaces must be the previous https endpoint.");
  }
  // null below means "carry over from the replaced record" — allowed only
  // when the field is absent AND there is a record to carry it from.
  const carryState = body.stateAbbr == null && replaces;
  const stateAbbr = carryState ? null : cleanState(body.stateAbbr);
  if (!stateAbbr && !carryState) return badRequest("stateAbbr must be a US state or territory code, e.g. \"CA\".");
  const carryFollows = body.follows === undefined && replaces;
  const follows = carryFollows ? null : cleanFollows(body.follows);
  if (follows === null && !carryFollows) {
    return badRequest(`follows must be an array of at most ${MAX_FOLLOWS} terms of at most ${MAX_FOLLOW_CHARS} characters.`);
  }
  return { ok: true, value: { subscription, stateAbbr, follows, replaces } };
}

// ------------------------------------------------------------ storage
async function readStream(stream) {
  return await new Response(stream).text();
}

const blobStore = {
  configured: () => blobConfigured(),
  async read(path) {
    // useCache:false — lastSentIds is read-modify-write, and a CDN copy even
    // a minute old would resend what the last run already sent.
    const hit = await get(path, { access: ACCESS, useCache: false, ...blobAuth() });
    if (!hit || hit.statusCode !== 200 || !hit.stream) return null;
    return JSON.parse(await readStream(hit.stream));
  },
  async write(path, value) {
    await put(path, JSON.stringify(value), {
      access: ACCESS,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      ...blobAuth(),
    });
  },
  async remove(path) {
    await del(path, blobAuth());
  },
  /** Every stored pathname under the prefix, following the cursor. */
  async paths() {
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix: SUBS_PREFIX, cursor, limit: 1000, ...blobAuth() });
      for (const b of page.blobs) out.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
};

let store = blobStore;

/** Test hook: replace the store with { configured, read, write, remove, paths }.
 *  Pass null to restore Blob. */
export function setPushStoreForTests(impl) {
  store = impl || blobStore;
}

export function pushStore() {
  return store;
}

/** A Map-backed store with the same shape, for node harnesses. */
export function memoryPushStore() {
  const m = new Map();
  return {
    data: m,
    configured: () => true,
    async read(p) { return m.has(p) ? JSON.parse(m.get(p)) : null; },
    async write(p, v) { m.set(p, JSON.stringify(v)); },
    async remove(p) { m.delete(p); },
    async paths() { return [...m.keys()].filter((k) => k.startsWith(SUBS_PREFIX)); },
  };
}

/** VAPID keys present? Without both, nothing can be sent or subscribed. */
export function vapidConfig() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (process.env.VAPID_SUBJECT || "").trim() || "mailto:hello@yanked.app";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}
