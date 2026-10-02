/* Alert subscriptions: web push here, email in api/_lib/email-channel.js.
 *
 *   GET    /api/push   -> { enabled, publicKey?, reason?,
 *                           channels: { push: {enabled, reason?}, email: {enabled, reason?} } }
 *   POST   /api/push   { subscription, stateAbbr, follows, recalls?, prefs? }  -> store / update
 *   POST   /api/push   { subscription, replaces }            -> rotate (from sw.js)
 *   DELETE /api/push   { endpoint }  (or ?endpoint=)         -> remove
 *
 * The GET is how the client learns whether push is on at all. Push needs two
 * things this deployment may not have — VAPID keys and a Blob store to keep
 * subscriptions in — and a subscribe button that prompts for notification
 * permission and then cannot deliver anything is worse than no button. So the
 * public key is handed out only when both are present, and src/lib/push.js
 * treats `enabled:false` as "don't offer it".
 *
 * Validation runs before anything touches storage, and is strict: see
 * src/lib/push-store.js for what a body may contain and why anything else is
 * refused. The response never echoes the endpoint back.
 *
 * Also dispatched from here, because Vercel Hobby deploys at most twelve
 * functions and every file directly under api/ is one:
 *   ?action=digest            the crons (api/_lib/send-digest.js)
 *   ?channel=email&action=…   email alerts (api/_lib/email-channel.js)
 */
import {
  validateSubscribeBody, cleanSubscription, endpointKey, pushStore, vapidConfig,
} from "../src/lib/push-store.js";
import digestHandler from "./_lib/send-digest.js";
import emailHandler from "./_lib/email-channel.js";
import { emailConfig } from "./_lib/email-store.js";
import { baselineSnapshots } from "./_lib/alerts-engine.js";
import { readIndex } from "../src/lib/index-server.js";

const MAX_BODY_CHARS = 8192; // 50 recall ids of up to 80 chars, 20 terms, a subscription

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") {
    if (b.length > MAX_BODY_CHARS) return { tooLarge: true };
    try { b = JSON.parse(b); } catch (_) { return { invalid: true }; }
  } else if (b && typeof b === "object") {
    try {
      if (JSON.stringify(b).length > MAX_BODY_CHARS) return { tooLarge: true };
    } catch (_) { return { invalid: true }; }
  }
  return { body: b };
}

function unavailable() {
  const vapid = vapidConfig();
  const store = pushStore();
  if (!vapid) return "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set on this deployment.";
  if (!store.configured()) return "No Vercel Blob store is attached, so there is nowhere to keep subscriptions.";
  // Subscribing to something the cron can never send would be a broken promise.
  if (!String(process.env.CRON_SECRET || "").trim()) return "CRON_SECRET is not set, so the scheduled alerts can't run.";
  return null;
}

/* The digest crons ride on this function as `?action=digest` rather than
 * being their own: Vercel's Hobby plan deploys at most twelve functions and
 * every file directly under api/ is one. The cron code is api/_lib/send-digest.js,
 * which does its own CRON_SECRET check before anything is sent. */
export default async function handler(req, res) {
  const q = req.query || {};
  if (q.action === "digest") return digestHandler(req, res);
  if (q.channel === "email") return emailHandler(req, res);
  res.setHeader("Cache-Control", "no-store");
  const method = String(req.method || "GET").toUpperCase();

  if (method === "GET") {
    /* Both channels' availability, each with its reason when off, so the app
     * can say "not available yet" per channel instead of hiding alerts
     * altogether. `enabled`/`publicKey` at the top level are push's, as before. */
    const why = unavailable();
    const mail = emailConfig();
    const channels = {
      push: why ? { enabled: false, reason: why } : { enabled: true },
      email: mail.ok ? { enabled: true } : { enabled: false, reason: mail.reason },
    };
    if (why) return res.status(200).json({ enabled: false, reason: why, channels });
    return res.status(200).json({ enabled: true, publicKey: vapidConfig().publicKey, channels });
  }

  if (method !== "POST" && method !== "DELETE") {
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  }

  const parsed = parseBody(req);
  if (parsed.tooLarge) return res.status(413).json({ error: "Body too large." });
  if (parsed.invalid) return res.status(400).json({ error: "Body must be JSON." });
  const body = parsed.body;

  if (method === "DELETE") {
    const endpoint = (body && typeof body === "object" && body.endpoint) || (req.query && req.query.endpoint);
    // Only the endpoint's shape is checked: keys aren't needed to delete, but
    // a non-https string can never have been stored, so it is a client bug.
    if (!cleanSubscription({ endpoint, keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) } })) {
      return res.status(400).json({ error: "endpoint must be the subscription's https endpoint." });
    }
    if (!pushStore().configured()) return res.status(200).json({ ok: true, removed: false });
    try {
      await pushStore().remove(endpointKey(endpoint));
      // Idempotent: deleting something already gone is still success.
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(502).json({ error: `Could not remove: ${String((err && err.message) || err).slice(0, 160)}` });
    }
  }

  // POST
  const v = validateSubscribeBody(body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const why = unavailable();
  if (why) return res.status(503).json({ enabled: false, error: why });

  const { subscription, replaces } = v.value;
  let { stateAbbr, follows, recalls, prefs } = v.value;
  const store = pushStore();
  const path = endpointKey(subscription.endpoint);

  try {
    const existing = await store.read(path).catch(() => null);
    let carried = null;
    if (replaces) {
      carried = await store.read(endpointKey(replaces)).catch(() => null);
      if (!carried && !existing) {
        // Nothing to rotate from, and the worker can't tell us the state.
        return res.status(404).json({ error: "No subscription to replace; subscribe again from the app." });
      }
    }
    const prev = existing || carried || {};
    stateAbbr = stateAbbr || prev.stateAbbr;
    follows = follows || prev.follows || [];
    recalls = recalls || prev.recalls || [];
    prefs = prefs || prev.prefs || { weekly: true, urgent: true };
    /* Snapshots are the SERVER's reading of the index, never the client's:
     * what the cron diffs against must not be something a request can set. */
    const index = await readIndex().catch(() => null);
    const snapshots = baselineSnapshots(recalls, index, prev.snapshots || {});
    const now = new Date().toISOString();
    await store.write(path, {
      subscription,
      stateAbbr,
      follows,
      recalls,
      snapshots,
      prefs,
      createdAt: prev.createdAt || now,
      updatedAt: now,
      // Keep the dedupe history across updates and rotations, or changing a
      // follow would re-send everything already sent.
      lastSentIds: Array.isArray(prev.lastSentIds) ? prev.lastSentIds : [],
    });
    if (replaces && carried && endpointKey(replaces) !== path) {
      await store.remove(endpointKey(replaces)).catch(() => {});
    }
    return res.status(existing ? 200 : 201).json({ ok: true, stateAbbr, follows, recalls, prefs });
  } catch (err) {
    return res.status(502).json({ error: `Could not save: ${String((err && err.message) || err).slice(0, 160)}` });
  }
}
