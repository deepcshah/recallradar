/* Cron (see vercel.json): push notifications, built from the national index.
 *
 *   GET /api/send-digest               weekly per-state digest (Saturdays)
 *   GET /api/send-digest?mode=urgent   daily: new serious recalls in the
 *                                      reader's state, plus new matches for
 *                                      the products they follow
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
 * DEDUPE. Each subscription carries `lastSentIds`: every recall id it has
 * already been told about, by either mode. Urgent never repeats an id. The
 * weekly digest counts the whole week (that is the honest number) but is only
 * sent when at least one of those recalls is news to this subscriber.
 *
 * Dead subscriptions — a 404 or 410 from the push service, which is how it
 * says the browser unsubscribed or the app was uninstalled — are deleted on
 * the spot. Anything else is counted as a failure and retried next run.
 *
 * With VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY unset this is a no-op that says
 * so in its JSON, so the cron is safe to ship before push is switched on.
 */
import { readIndex } from "../src/lib/index-server.js";
import { isInArea } from "../src/lib/verdict.js";
import { matchFollows } from "../src/lib/follows.js";
import { reasonFor } from "../src/lib/reason.js";
import { ABBR_TO_NAME } from "../src/lib/states.js";
import { pushStore, vapidConfig, MAX_SENT_IDS } from "../src/lib/push-store.js";

const DAY = 24 * 60 * 60 * 1000;
/** The digest's "this week". */
export const WEEK_DAYS = 7;
/** How far back urgent looks. Long enough to cover a missed cron run and the
 *  index being rebuilt a day late; short enough that a brand-new subscriber
 *  isn't handed a month of backlog as "urgent". */
export const URGENT_DAYS = 3;
const CONCURRENCY = 8;

// ------------------------------------------------------------ wording
/* Food hazards read as "Listeria in bagged spinach"; product hazards read
 * badly that way ("Fire, burn or shock in mattresses"), so they take a colon. */
const IN_PHRASE = new Set(["allergen", "listeria", "salmonella", "ecoli", "contamination", "foreign", "chemical"]);

/** "Fontanini Foods LLC Recalls Raw, Frozen Pork Sausage Products Due to …"
 *  → "Raw, Frozen Pork Sausage Products". Agency titles put the firm first and
 *  the reason last; on a lock screen only the thing itself fits. */
export function shortProduct(product, max = 60) {
  let p = String(product || "").replace(/\s+/g, " ").trim();
  const m = p.match(/\b(?:Recalls|Expands Recall of|Issues (?:a )?(?:Voluntary )?Recall of)\s+(.+)/i);
  if (m) p = m[1];
  p = p.replace(/\s+(?:Recalled\b|Due to\b|Because\b|Imported Without\b|Produced Without\b|Distributed Without\b|That\b|for Possible\b)[\s\S]*$/i, "");
  p = p.replace(/[;,:.\s]+$/, "");
  if (p.length > max) p = p.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return p || String(product || "").slice(0, max);
}

export function headlineOf(r) {
  const what = shortProduct(r.product);
  const { key, label } = reasonFor(r);
  if (key === "other" || key === "unspecified") return what;
  return IN_PHRASE.has(key) ? `${label} in ${what}` : `${label}: ${what}`;
}

function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

/** Most serious first, then newest. */
function rank(a, b) {
  const s = (x) => (x.severity === "high" ? 0 : x.severity === "med" ? 1 : 2);
  return s(a) - s(b) || String(b.date).localeCompare(String(a.date));
}

function recallUrl(r, st) {
  return `/?r=${encodeURIComponent(r.id)}&st=${encodeURIComponent(st)}`;
}

/* Index dates are calendar days ("2026-09-25"), not instants, so the window
 * is counted in whole UTC days: "the last 3 days" on the 28th includes all of
 * the 25th. Comparing instants instead dropped a recall dated the 25th from a
 * run at 3pm on the 28th — exactly the notice the urgent cron exists for. */
function withinDays(r, days, now) {
  const day = String(r.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const from = new Date(now - days * DAY).toISOString().slice(0, 10);
  const to = new Date(now + DAY).toISOString().slice(0, 10);
  return day >= from && day <= to;
}

/** In-area, not ended, dated within `days`. */
export function areaRecalls(index, stateAbbr, days, now = Date.now()) {
  const loc = { stateAbbr };
  return (index && Array.isArray(index.recalls) ? index.recalls : [])
    .filter((r) => r && r.status !== "ended" && withinDays(r, days, now) && isInArea(r, loc));
}

/** What one subscriber should be sent this run, or null for nothing.
 *  Pure: no I/O, so it can be exercised directly.
 *  @returns {{ payload: {title, body, url, tag, recallId?}, ids: string[] } | null} */
export function planPush(sub, index, mode, now = Date.now()) {
  const st = sub && sub.stateAbbr;
  const stateName = ABBR_TO_NAME[st];
  if (!stateName) return null;
  const sent = new Set(Array.isArray(sub.lastSentIds) ? sub.lastSentIds : []);
  const follows = Array.isArray(sub.follows) ? sub.follows : [];

  if (mode === "urgent") {
    const recent = areaRecalls(index, st, URGENT_DAYS, now).filter((r) => !sent.has(r.id));
    const serious = recent.filter((r) => r.severity === "high").sort(rank);
    const followHits = matchFollows(recent, follows); // [{term, records}]
    const byId = new Map();
    for (const r of serious) byId.set(r.id, { r, term: null });
    for (const { term, records } of followHits) {
      for (const r of records) if (!byId.has(r.id)) byId.set(r.id, { r, term });
    }
    const items = [...byId.values()];
    if (!items.length) return null;
    const ids = items.map((x) => x.r.id);

    if (items.length === 1) {
      const { r, term } = items[0];
      return {
        ids,
        payload: {
          title: term
            ? `Recall matching “${term}” in ${stateName}`
            : `Serious recall in ${stateName}`,
          body: headlineOf(r),
          url: recallUrl(r, st),
          tag: `yanked-${r.id}`,
          recallId: r.id,
        },
      };
    }
    const nSerious = items.filter((x) => x.r.severity === "high").length;
    const nFollow = items.filter((x) => x.term).length;
    const parts = [];
    if (nSerious) parts.push(plural(nSerious, "serious recall"));
    if (nFollow) parts.push(`${plural(nFollow, "match", "matches")} for products you follow`);
    return {
      ids,
      payload: {
        title: `${stateName}: ${parts.join(" · ")}`,
        body: items.slice(0, 2).map((x) => headlineOf(x.r)).join(" · ") + (items.length > 2 ? ` · +${items.length - 2} more` : ""),
        url: "/",
        tag: "yanked-urgent",
      },
    };
  }

  // weekly
  const week = areaRecalls(index, st, WEEK_DAYS, now).sort(rank);
  if (!week.length || week.every((r) => sent.has(r.id))) return null;
  const serious = week.filter((r) => r.severity === "high");
  const lead = serious[0] || week[0];
  let body = `This week in ${st}: ${plural(week.length, "new recall")}`;
  if (serious.length) body += ` · ${serious.length} serious`;
  body += ` — ${headlineOf(lead)}`;
  const hits = matchFollows(week, follows);
  if (hits.length) body += `. Matches: ${hits.slice(0, 3).map((h) => `“${h.term}”`).join(", ")}`;
  return {
    ids: week.map((r) => r.id),
    payload: {
      title: `Recalls this week in ${stateName}`,
      body,
      url: week.length === 1 ? recallUrl(lead, st) : "/",
      tag: "yanked-digest",
      ...(week.length === 1 ? { recallId: lead.id } : {}),
    },
  };
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const mode = q.mode === "urgent" ? "urgent" : "weekly";
  const dry = q.dry === "1" || q.dry === "true";
  const vapid = vapidConfig();

  // Before auth, because it reveals nothing and does nothing: a deployment
  // without push answers every caller the same harmless no-op.
  if (!vapid && !dry) {
    return res.status(200).json({
      ok: true, mode, sent: 0,
      skipped: "Push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (and VAPID_SUBJECT) " +
               "to enable it. Generate a pair with `npx web-push generate-vapid-keys`. Nothing was sent.",
    });
  }

  /* Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` when the env var
   * is set. It is REQUIRED past this point, not merely enforced when present:
   * without it, anyone could fire pushes at every subscriber on demand, and a
   * `?dry=1` preview would hand a stranger every subscriber's state and
   * follow terms — the only personal data this app keeps. A deployment with
   * VAPID keys but no CRON_SECRET is misconfigured, and says so. */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({
      ok: false, mode, sent: 0,
      error: "CRON_SECRET is not set. Push is configured, so this endpoint refuses to run unauthenticated; " +
             "set CRON_SECRET (Vercel cron sends it automatically) and redeploy.",
    });
  }
  if ((req.headers || {}).authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const store = pushStore();
  if (!store.configured()) {
    return res.status(200).json({
      ok: true, mode, sent: 0,
      skipped: "No Vercel Blob store is attached, so there are no subscriptions to send to. " +
               "Attach one (RR_BLOB_READ_WRITE_TOKEN) and redeploy.",
    });
  }
  const index = await readIndex();
  if (!index) {
    return res.status(503).json({
      ok: false, mode, sent: 0,
      error: "No national index (public/feeds/index.json) in this deployment; nothing to build a digest from.",
    });
  }

  let webpush = null;
  if (!dry) {
    webpush = (await import("web-push")).default;
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  const stats = { subscribers: 0, sent: 0, nothingNew: 0, removed: 0, failed: 0 };
  const preview = [];
  const errors = [];
  const now = Date.now();

  let paths;
  try {
    paths = await store.paths();
  } catch (err) {
    return res.status(502).json({ ok: false, mode, error: `Could not list subscriptions: ${String((err && err.message) || err).slice(0, 160)}` });
  }
  stats.subscribers = paths.length;

  await pool(paths, CONCURRENCY, async (path) => {
    let rec;
    try {
      rec = await store.read(path);
    } catch (_) {
      stats.failed++;
      return;
    }
    if (!rec || !rec.subscription) return;
    const plan = planPush(rec, index, mode, now);
    if (!plan) { stats.nothingNew++; return; }
    if (dry) {
      // Never echo endpoints; the state and the text are enough to review.
      if (preview.length < 50) preview.push({ stateAbbr: rec.stateAbbr, ...plan.payload, ids: plan.ids.length });
      stats.sent++;
      return;
    }
    try {
      await webpush.sendNotification(rec.subscription, JSON.stringify(plan.payload), {
        TTL: mode === "urgent" ? DAY / 1000 : (3 * DAY) / 1000,
        urgency: mode === "urgent" ? "high" : "normal",
      });
      stats.sent++;
      const lastSentIds = [...new Set([...plan.ids, ...(rec.lastSentIds || [])])].slice(0, MAX_SENT_IDS);
      await store.write(path, { ...rec, lastSentIds, lastSentAt: new Date(now).toISOString() }).catch(() => {});
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        stats.removed++;
        await store.remove(path).catch(() => {});
      } else {
        stats.failed++;
        if (errors.length < 10) errors.push(`${code || "error"}: ${String((err && (err.body || err.message)) || err).slice(0, 120)}`);
      }
    }
  });

  return res.status(200).json({
    ok: true, mode, dry, indexBuiltAt: index.builtAt, ...stats,
    ...(dry ? { preview } : {}),
    ...(errors.length ? { errors } : {}),
  });
}
