/* Cron (see vercel.json): alerts by web push AND email, built from the
 * national index. What to send is decided once, by alerts-engine.js, for
 * both channels; this file only walks the subscribers and delivers.
 *
 *   GET /api/push?action=digest            weekly per-state digest (Saturdays)
 *   GET /api/push?action=digest&mode=urgent   daily: new serious recalls in the
 *                                      reader's state, new matches for the
 *                                      products they follow, and updates to
 *                                      recalls they follow
 *   &dry=1                             compute and return what would be sent,
 *                                      send nothing, write nothing
 *
 * Everything comes from readIndex() — the committed public/feeds/index.json
 * — and not from the agencies. A cron that fans out to three government APIs
 * per subscriber would be slow, would get FSIS's WAF to refuse us exactly as
 * it refuses the request path, and would make a push depend on a live fetch
 * succeeding at 7am. The index is already built, already scoped (`coverage`),
 * and already in this function's bundle.
 *
 * "In the reader's area" is verdict.js `isInArea`, the same test the app's
 * area list uses, so a notification can never mention a recall the app then
 * leaves out of "Anywhere in ST" (or the reverse). Ended recalls are skipped:
 * a push is a prompt to act now, and the index's closed notices are for the
 * searcher who arrives with a product in hand.
 *
 * WHAT IS NEVER SENT. No notification says, or implies, that anything is
 * safe. A week with nothing new in a state sends nothing at all, rather than
 * a "0 new recalls" push that would read as an all-clear on a lock screen —
 * the app is where an empty result gets to say what was checked. Follows only
 * ever produce "matches"; the absence of a match is never announced.
 *
 * DEDUPE. Each subscriber record (per channel) carries `lastSentIds`: every
 * recall id it has already been told about, by either mode, and one key per
 * reported update ("u:<id>:<hash>"). Urgent never repeats an id. The weekly
 * digest counts the whole week (that is the honest number) but is only sent
 * when at least one of those recalls is news to this subscriber.
 *
 * Dead subscriptions — a 404 or 410 from the push service, which is how it
 * says the browser unsubscribed or the app was uninstalled — are deleted on
 * the spot. Anything else is counted as a failure and retried next run.
 *
 * Email: a 4xx from Resend for one address is counted as a failure and
 * retried next run (Resend reports bounces to its own suppression list; we
 * don't guess). Unconfirmed email records are deleted once their request is
 * a week old.
 *
 * With neither channel configured (no VAPID keys, no RESEND_API_KEY) this is
 * a no-op that says so in its JSON, so the cron is safe to ship before either
 * is switched on.
 */
import { readIndex } from "../../src/lib/index-server.js";
import { pushStore, vapidConfig } from "../../src/lib/push-store.js";
import {
  planAlerts, applyPlan, pushPayloadFor, emailFor, WEEK_DAYS, URGENT_DAYS, shortProduct, headlineOf, areaRecalls,
} from "./alerts-engine.js";
import { emailConfig, emailStore, EMAIL_PREFIX, PENDING_MAX_AGE_MS } from "./email-store.js";
import { linksFor, unsubscribeHeaders } from "./email-channel.js";
import { sendEmail, sleep, SEND_GAP_MS } from "./resend.js";
import { snapshotHash } from "../../src/lib/recall-watch.js";

export { WEEK_DAYS, URGENT_DAYS, shortProduct, headlineOf, areaRecalls };

const DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;

/** Back-compat: the push payload for one subscriber this run, or null.
 *  @returns {{ payload, ids } | null} */
export function planPush(sub, index, mode, now = Date.now()) {
  const plan = planAlerts(sub, index, mode, now);
  if (!plan || !plan.send) return null;
  return { payload: pushPayloadFor(plan), ids: plan.ids };
}

// ------------------------------------------------------------ sending
async function pool(items, n, fn) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function errText(err) {
  return String((err && (err.body || err.message)) || err).slice(0, 120);
}

/** Walk one channel's subscribers. `deliver(rec, plan, path)` returns
 *  { ok } | { dead } | { error }. */
async function runChannel({ store, mode, dry, index, now, concurrency, deliver, skip, describe }) {
  const stats = { subscribers: 0, sent: 0, nothingNew: 0, baselined: 0, removed: 0, failed: 0 };
  const preview = [];
  const errors = [];
  let paths;
  try {
    paths = await store.paths();
  } catch (err) {
    return { error: `Could not list subscribers: ${errText(err)}` };
  }
  stats.subscribers = paths.length;
  await pool(paths, concurrency, async (path) => {
    let rec;
    try {
      rec = await store.read(path);
    } catch (_) {
      stats.failed++;
      return;
    }
    if (!rec) return;
    const why = skip && (await skip(rec, path, stats));
    if (why) return;
    const plan = planAlerts(rec, index, mode, now);
    if (!plan) { stats.nothingNew++; return; }
    if (!plan.send) {
      // A first snapshot for a newly followed recall: nothing to say yet.
      stats.nothingNew++;
      stats.baselined++;
      if (!dry) await store.write(path, applyPlan(rec, plan, now)).catch(() => {});
      return;
    }
    if (dry) {
      if (preview.length < 50) preview.push(describe(rec, plan));
      stats.sent++;
      return;
    }
    const out = await deliver(rec, plan, path);
    if (out.ok) {
      stats.sent++;
      await store.write(path, applyPlan(rec, plan, now)).catch(() => {});
    } else if (out.dead) {
      stats.removed++;
      await store.remove(path).catch(() => {});
    } else {
      stats.failed++;
      if (errors.length < 10) errors.push(out.error);
    }
  });
  return { ...stats, ...(dry ? { preview } : {}), ...(errors.length ? { errors } : {}) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const mode = q.mode === "urgent" ? "urgent" : "weekly";
  const dry = q.dry === "1" || q.dry === "true";
  const vapid = vapidConfig();
  const email = emailConfig();
  // "Configured" for the CRON_SECRET rule means "someone switched it on",
  // even if half its settings are missing.
  const emailWanted = Boolean(String(process.env.RESEND_API_KEY || "").trim());

  // Before auth, because it reveals nothing and does nothing: a deployment
  // without either channel answers every caller the same harmless no-op.
  if (!vapid && !emailWanted && !dry) {
    return res.status(200).json({
      ok: true, mode, sent: 0,
      skipped: "No alert channel is configured. Web push needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY " +
               "(generate with `npx web-push generate-vapid-keys`); email needs RESEND_API_KEY, ALERTS_FROM and " +
               "ALERTS_SECRET. Nothing was sent.",
    });
  }

  /* Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var
   * is set. It is REQUIRED past this point, not merely enforced when present:
   * without it, anyone could fire alerts at every subscriber on demand, and a
   * `?dry=1` preview would hand a stranger every subscriber's state and
   * follow terms. A deployment with a channel but no CRON_SECRET is
   * misconfigured, and says so. */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({
      ok: false, mode, sent: 0,
      error: "CRON_SECRET is not set. An alert channel is configured, so this endpoint refuses to run unauthenticated; " +
             "set CRON_SECRET (Vercel cron sends it automatically) and redeploy.",
    });
  }
  if ((req.headers || {}).authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const index = await readIndex();
  if (!index) {
    return res.status(503).json({
      ok: false, mode, sent: 0,
      error: "No national index (public/feeds/index.json) in this deployment; nothing to build alerts from.",
    });
  }
  const now = Date.now();
  const result = { ok: true, mode, dry, indexBuiltAt: index.builtAt };

  // ---- push
  const pStore = pushStore();
  if (!vapid) {
    result.push = { skipped: "VAPID keys not set." };
  } else if (!pStore.configured()) {
    result.push = { skipped: "No Vercel Blob store is attached (RR_BLOB_READ_WRITE_TOKEN)." };
  } else {
    let webpush = null;
    if (!dry) {
      webpush = (await import("web-push")).default;
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    }
    result.push = await runChannel({
      store: pStore, mode, dry, index, now, concurrency: CONCURRENCY,
      skip: (rec) => !rec.subscription,
      // Never echo endpoints; the state and the text are enough to review.
      describe: (rec, plan) => ({ stateAbbr: rec.stateAbbr, ...pushPayloadFor(plan), ids: plan.ids.length }),
      async deliver(rec, plan) {
        try {
          await webpush.sendNotification(rec.subscription, JSON.stringify(pushPayloadFor(plan)), {
            TTL: mode === "urgent" ? DAY / 1000 : (3 * DAY) / 1000,
            urgency: mode === "urgent" ? "high" : "normal",
          });
          return { ok: true };
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) return { dead: true };
          return { error: `${code || "error"}: ${errText(err)}` };
        }
      },
    });
  }

  // ---- email
  if (!emailWanted) {
    result.email = { skipped: "RESEND_API_KEY not set." };
  } else if (!email.ok) {
    result.email = { skipped: email.reason };
  } else {
    const eStore = emailStore();
    result.email = await runChannel({
      // One at a time: Resend allows ~2 requests a second.
      store: eStore, mode, dry, index, now, concurrency: 1,
      async skip(rec, path, stats) {
        if (rec.confirmed) return false;
        // Never confirmed: nothing is sent; tidy up once the request is old.
        const age = now - Date.parse(rec.createdAt || 0);
        if (!dry && mode === "urgent" && Number.isFinite(age) && age > PENDING_MAX_AGE_MS) {
          await eStore.remove(path).catch(() => {});
          stats.removed++;
        }
        return true;
      },
      // Never echo addresses.
      describe: (rec, plan) => {
        const m = emailFor(plan, { baseUrl: email.baseUrl, unsubscribeUrl: `${email.baseUrl}/api/push?channel=email&action=unsubscribe` });
        return { stateAbbr: rec.stateAbbr, subject: m.subject, ids: plan.ids.length };
      },
      async deliver(rec, plan, path) {
        const key = path.slice(EMAIL_PREFIX.length).replace(/\.json$/, "");
        const { unsubscribeUrl } = linksFor(email, key, rec);
        const m = emailFor(plan, { baseUrl: email.baseUrl, unsubscribeUrl });
        const out = await sendEmail({
          apiKey: email.apiKey, from: email.from, to: rec.email,
          subject: m.subject, html: m.html, text: m.text,
          headers: unsubscribeHeaders(unsubscribeUrl),
          // Same subscriber, same day, same content → Resend sends it once.
          idempotencyKey: `yanked-${mode}-${key.slice(0, 16)}-${new Date(now).toISOString().slice(0, 10)}-${snapshotHash({ s: plan.ids.join(",") })}`,
        });
        await sleep(SEND_GAP_MS);
        return out.ok ? { ok: true } : { error: `${out.status || "error"}: ${out.error}` };
      },
    });
  }

  return res.status(200).json(result);
}
