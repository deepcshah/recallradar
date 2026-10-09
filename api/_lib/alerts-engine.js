/* The one alerts engine, shared by both delivery channels (web push and
 * email). send-digest.js runs it from the crons; it decides WHAT a
 * subscriber should hear about, and two renderers turn that into a push
 * payload or an email. Neither renderer decides anything.
 *
 * A subscriber record (push or email — the same fields) carries:
 *   stateAbbr, follows (terms), recalls (followed ids), snapshots, prefs,
 *   lastSentIds
 *
 * Two runs:
 *
 *   weekly  (Saturdays)  the state digest — new recalls in the reader's state
 *                        this week. Only with prefs.weekly.
 *   urgent  (daily)      - a new serious (Class I / high-risk) recall in the
 *                          state, with prefs.urgent;
 *                        - a new recall matching a follow term
 *                          (recall-watch.js followRelevant: in the state, or
 *                          naming no geography);
 *                        - an UPDATE to a followed recall
 *                          (recall-watch.js diffRecall: closed, states added,
 *                          reclassified, an announcement classified by FDA).
 *                        Follow matches and updates are what a follow is, so
 *                        they don't depend on prefs.urgent.
 *
 * Everything is read from the national index (readIndex), never the live
 * agencies — see the note at the top of send-digest.js.
 *
 * DEDUPE. `lastSentIds` holds every recall id the subscriber has been told
 * about, and "u:<id>:<snapshot hash>" for each update. A new recall is never
 * sent twice by either run; an update is sent once per distinct new state of
 * the recall. Snapshots advance only after a successful send, so a failed
 * send is retried next run rather than lost.
 *
 * WHAT IS NEVER SENT. "Nothing new", "no matches", "safe": an empty run sends
 * nothing at all. A recall closing is reported as closed, with the reminder
 * that recalled product outlives the paperwork — not as good news.
 */
import { isInArea, isAnnounced } from "../../src/lib/verdict.js";
import { matchFollows } from "../../src/lib/follows.js";
import { reasonFor } from "../../src/lib/reason.js";
import { ABBR_TO_NAME } from "../../src/lib/states.js";
import { findRecall } from "../../src/lib/index-server.js";
import { cleanPrefs, DEFAULT_PREFS, MAX_SENT_IDS } from "../../src/lib/push-store.js";
import {
  diffRecall, snapshotHash, recallSnapshot, cleanSnapshot, followRelevant, describeChange, changeLabel,
} from "../../src/lib/recall-watch.js";

const DAY = 24 * 60 * 60 * 1000;
/** The digest's "this week". */
export const WEEK_DAYS = 7;
/** How far back urgent looks. Long enough to cover a missed cron run and the
 *  index being rebuilt a day late; short enough that a brand-new subscriber
 *  isn't handed a month of backlog as "urgent". */
export const URGENT_DAYS = 3;

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

export function recallPath(id, st) {
  return `/?r=${encodeURIComponent(id)}${st ? `&st=${encodeURIComponent(st)}` : ""}`;
}

// ------------------------------------------------------------ windows
/* Index dates are calendar days ("2026-09-25"), not instants, so the window
 * is counted in whole UTC days: "the last 3 days" on the 28th includes all of
 * the 25th. Comparing instants instead dropped a recall dated the 25th from a
 * run at 3pm on the 28th — exactly the notice the urgent cron exists for. */
function withinDays(r, days, now) {
  // The later of the notice's date and FDA's publication date (digest.js newsDay).
  const d = String(r.date || "").slice(0, 10);
  const p = String(r.posted || "").slice(0, 10);
  const day = p > d ? p : d;
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

function recentAnywhere(index, days, now) {
  return (index && Array.isArray(index.recalls) ? index.recalls : [])
    .filter((r) => r && r.status !== "ended" && withinDays(r, days, now));
}

// ------------------------------------------------------------ snapshots
/** Snapshots for a subscriber's followed ids: keep the ones already held
 *  (they are the baseline the next diff runs against), take new ones from
 *  the index, and drop ids no longer followed. An id the index doesn't have
 *  gets no snapshot; the cron takes one the first time it appears. */
export function baselineSnapshots(ids, index, prev = {}) {
  const out = {};
  for (const id of ids || []) {
    const kept = prev && cleanSnapshot(prev[id]);
    if (kept) { out[id] = kept; continue; }
    const r = findRecall(index, id);
    if (r) out[id] = recallSnapshot(r);
  }
  return out;
}

// ------------------------------------------------------------ planning
/**
 * What one subscriber should be sent in this run. Pure: no I/O.
 *
 * @returns {null | {
 *   send: boolean,              false: nothing to send, but snapshots moved
 *                               (a first baseline) and should be saved
 *   mode, st, stateName,
 *   weekly?: { week, serious, lead, matches },
 *   items:   [{ kind:'serious'|'follow', r, term? }],
 *   updates: [{ id, record, changes, key }],
 *   ids:     dedupe keys to add to lastSentIds on success,
 *   snapshots: the subscriber's snapshots after this run (on success)
 * }}
 */
export function planAlerts(sub, index, mode, now = Date.now()) {
  const st = sub && sub.stateAbbr;
  const stateName = ABBR_TO_NAME[st];
  if (!stateName) return null;
  const prefs = cleanPrefs(sub.prefs) || { ...DEFAULT_PREFS };
  const sent = new Set(Array.isArray(sub.lastSentIds) ? sub.lastSentIds : []);
  const follows = Array.isArray(sub.follows) ? sub.follows : [];

  if (mode !== "urgent") {
    if (!prefs.weekly) return null;
    /* Company announcements FDA has not classified are never counted as "new
     * recalls" (the app's digest headline doesn't count them either, see
     * digest.js summarize) — they can still reach a reader as a follow match. */
    const inArea = areaRecalls(index, st, WEEK_DAYS, now).sort(rank);
    const week = inArea.filter((r) => !isAnnounced(r));
    if (!week.length || week.every((r) => sent.has(r.id))) return null;
    const serious = week.filter((r) => r.severity === "high");
    const lead = serious[0] || week[0];
    const matches = matchFollows(inArea, follows);
    return {
      send: true, mode: "weekly", st, stateName,
      weekly: { week, serious, lead, matches },
      items: [], updates: [],
      ids: week.map((r) => r.id),
      snapshots: null,
    };
  }

  // ---- urgent / daily
  const items = [];
  const byId = new Set();
  if (prefs.urgent) {
    for (const r of areaRecalls(index, st, URGENT_DAYS, now).filter((x) => x.severity === "high" && !sent.has(x.id)).sort(rank)) {
      byId.add(r.id);
      items.push({ kind: "serious", r });
    }
  }
  const candidates = recentAnywhere(index, URGENT_DAYS, now)
    .filter((r) => !sent.has(r.id) && followRelevant(r, st));
  for (const { term, records } of matchFollows(candidates, follows)) {
    for (const r of records.sort(rank)) {
      if (byId.has(r.id)) continue;
      byId.add(r.id);
      items.push({ kind: "follow", r, term });
    }
  }

  const ids = Array.isArray(sub.recalls) ? sub.recalls : [];
  const prevSnaps = sub.snapshots && typeof sub.snapshots === "object" ? sub.snapshots : {};
  const snapshots = {};
  const updates = [];
  let moved = false;
  const pool = index && Array.isArray(index.recalls) ? index.recalls : [];
  for (const id of ids) {
    const prev = cleanSnapshot(prevSnaps[id]);
    const current = findRecall(index, (prev && prev.m) || id);
    const { changes, next, record } = diffRecall(prev, current, pool);
    if (next) snapshots[id] = next;
    if (!prev) {
      if (next) moved = true; // a first baseline, recorded silently
      continue;
    }
    if (!changes.length) continue;
    const key = `u:${id}:${snapshotHash(next)}`;
    moved = true;
    if (sent.has(key)) continue; // already told (a retried write); just move the baseline
    updates.push({ id, record, changes, key });
  }
  if (Object.keys(prevSnaps).some((k) => !ids.includes(k))) moved = true; // unfollowed: prune

  const keys = [...items.map((x) => x.r.id), ...updates.map((u) => u.key)];
  if (!items.length && !updates.length) {
    return moved ? { send: false, mode: "urgent", st, stateName, items, updates, ids: [], snapshots } : null;
  }
  return { send: true, mode: "urgent", st, stateName, items, updates, ids: keys, snapshots };
}

/** The record after a successful send (or a silent baseline). */
export function applyPlan(rec, plan, now = Date.now()) {
  const out = { ...rec };
  if (plan.snapshots) out.snapshots = plan.snapshots;
  if (plan.send) {
    out.lastSentIds = [...new Set([...plan.ids, ...(rec.lastSentIds || [])])].slice(0, MAX_SENT_IDS);
    out.lastSentAt = new Date(now).toISOString();
  }
  return out;
}

// ------------------------------------------------------------ push
/** One notification per run: specific when there is one thing to say, a
 *  summary when there are several. */
export function pushPayloadFor(plan) {
  const { st, stateName } = plan;
  if (plan.mode === "weekly") {
    const { week, serious, lead, matches } = plan.weekly;
    let body = `This week in ${st}: ${plural(week.length, "new recall")}`;
    if (serious.length) body += ` · ${serious.length} serious`;
    body += ` — ${headlineOf(lead)}`;
    if (matches.length) body += `. Matches: ${matches.slice(0, 3).map((h) => `“${h.term}”`).join(", ")}`;
    return {
      title: `Recalls this week in ${stateName}`,
      body,
      url: week.length === 1 ? recallPath(lead.id, st) : "/",
      tag: "yanked-digest",
      ...(week.length === 1 ? { recallId: lead.id } : {}),
    };
  }
  const { items, updates } = plan;
  if (items.length === 1 && !updates.length) {
    const { r, term } = items[0];
    return {
      title: term ? `Recall matching “${term}” in ${stateName}` : `Serious recall in ${stateName}`,
      body: headlineOf(r),
      url: recallPath(r.id, st),
      tag: `yanked-${r.id}`,
      recallId: r.id,
    };
  }
  if (!items.length && updates.length === 1) {
    const u = updates[0];
    const id = (u.record && u.record.id) || u.id;
    return {
      title: `Update: ${changeLabel(u.changes[0])}`,
      body: `${u.record ? shortProduct(u.record.product) : "A recall you follow"} — ${describeChange(u.changes[0], st)}`,
      url: recallPath(id, st),
      tag: `yanked-u-${u.id}`,
      recallId: id,
    };
  }
  const nSerious = items.filter((x) => x.kind === "serious").length;
  const nFollow = items.filter((x) => x.kind === "follow").length;
  const parts = [];
  if (nSerious) parts.push(plural(nSerious, "serious recall"));
  if (nFollow) parts.push(`${plural(nFollow, "match", "matches")} for products you follow`);
  if (updates.length) parts.push(`${plural(updates.length, "update")} to recalls you follow`);
  const lines = [
    ...updates.map((u) => `${changeLabel(u.changes[0])}: ${u.record ? shortProduct(u.record.product, 40) : u.id}`),
    ...items.map((x) => headlineOf(x.r)),
  ];
  return {
    title: `${stateName}: ${parts.join(" · ")}`,
    body: lines.slice(0, 2).join(" · ") + (lines.length > 2 ? ` · +${lines.length - 2} more` : ""),
    url: "/",
    tag: "yanked-urgent",
  };
}

// ------------------------------------------------------------ email
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only http(s) links from a record make it into an email. */
function safeUrl(u) {
  try {
    const x = new URL(String(u || ""));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : "";
  } catch (_) {
    return "";
  }
}

function subjectFor(plan) {
  const { stateName } = plan;
  if (plan.mode === "weekly") {
    const { week, serious } = plan.weekly;
    return `Recalls this week in ${stateName}: ${plural(week.length, "new recall")}${serious.length ? `, ${serious.length} serious` : ""}`;
  }
  const p = pushPayloadFor(plan);
  if (plan.items.length + plan.updates.length === 1) return `${p.title}: ${p.body}`.slice(0, 140);
  return p.title.slice(0, 140);
}

/**
 * Render one plan as an email.
 * @param {object} plan  from planAlerts
 * @param {{ baseUrl: string, unsubscribeUrl: string }} links
 * @returns {{ subject, html, text }}
 */
export function emailFor(plan, { baseUrl, unsubscribeUrl }) {
  const st = plan.st;
  const sections = []; // { title, rows: [{ head, sub, href, notice }] }
  const row = (r, extra) => ({
    head: headlineOf(r),
    sub: [r.firm, r.classification, r.source].filter(Boolean).join(" · "),
    note: extra || "",
    href: `${baseUrl}${recallPath(r.id, st)}`,
    notice: safeUrl(r.url),
  });

  if (plan.mode === "weekly") {
    const { week, matches } = plan.weekly;
    sections.push({ title: `New this week in ${plan.stateName}`, rows: week.slice(0, 12).map((r) => row(r)) });
    if (week.length > 12) sections[0].more = `+${week.length - 12} more in the app`;
    if (matches.length) {
      sections.push({
        title: "Matching products you follow",
        rows: matches.slice(0, 5).flatMap((m) => m.records.slice(0, 3).map((r) => row(r, `Matches “${m.term}”`))),
      });
    }
  } else {
    if (plan.updates.length) {
      sections.push({
        title: "Updates to recalls you follow",
        rows: plan.updates.map((u) => {
          const r = u.record || { id: u.id, product: u.id };
          const base = row(r);
          return { ...base, note: u.changes.map((c) => describeChange(c, st)).join(" ") };
        }),
      });
    }
    const serious = plan.items.filter((x) => x.kind === "serious");
    if (serious.length) sections.push({ title: `Serious recalls in ${plan.stateName}`, rows: serious.map((x) => row(x.r)) });
    const follows = plan.items.filter((x) => x.kind === "follow");
    if (follows.length) {
      sections.push({ title: "Matching products you follow", rows: follows.map((x) => row(x.r, `Matches “${x.term}”`)) });
    }
  }

  const subject = subjectFor(plan);
  const why = plan.mode === "weekly"
    ? `You get this weekly digest for ${plan.stateName} because you confirmed Yanked email alerts.`
    : `You get these alerts because you confirmed Yanked email alerts for ${plan.stateName} and the products and recalls you follow.`;
  const caveat = "Yanked reads public FDA, USDA and CPSC notices and is not an official source. Check the product codes against the official notice.";

  const text = [
    subject, "",
    ...sections.flatMap((s) => [
      s.title.toUpperCase(),
      ...s.rows.flatMap((r) => [`- ${r.head}`, ...(r.note ? [`  ${r.note}`] : []), `  ${r.href}`]),
      ...(s.more ? [s.more] : []), "",
    ]),
    caveat, "", why,
    `Unsubscribe (one click): ${unsubscribeUrl}`,
    `Change what you follow: ${baseUrl}/`,
    `Follows missing on a device? Open ${baseUrl}/ → Alerts → Restore from email.`,
  ].join("\n");

  const h = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;background:#f1f1f1;font-family:-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<p style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6d6d6d">Yanked alerts</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${h(subject)}</h1>
${sections.map((s) => `<div style="background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:14px 16px;margin:0 0 12px">
<p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6d6d6d">${h(s.title)}</p>
${s.rows.map((r) => `<div style="padding:8px 0;border-top:1px solid #efefef">
<a href="${h(r.href)}" style="font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none">${h(r.head)}</a>
${r.sub ? `<div style="font-size:12px;color:#616161;margin-top:2px">${h(r.sub)}</div>` : ""}
${r.note ? `<div style="font-size:13px;color:#1a1a1a;margin-top:4px">${h(r.note)}</div>` : ""}
<div style="font-size:12px;margin-top:4px"><a href="${h(r.href)}" style="color:#1f7a4c">Open in Yanked</a>${r.notice ? ` · <a href="${h(r.notice)}" style="color:#1f7a4c">Official notice</a>` : ""}</div>
</div>`).join("")}
${s.more ? `<p style="margin:8px 0 0;font-size:12px;color:#6d6d6d">${h(s.more)}</p>` : ""}
</div>`).join("")}
<p style="font-size:12px;line-height:1.5;color:#616161">${h(caveat)}</p>
<p style="font-size:12px;line-height:1.5;color:#616161">${h(why)}<br>
<a href="${h(unsubscribeUrl)}" style="color:#1f7a4c">Unsubscribe</a> (one click) · <a href="${h(baseUrl)}/" style="color:#1f7a4c">Change what you follow</a><br>
Follows missing on a device? Open Yanked → Alerts → Restore from email.</p>
</div></body></html>`;
  return { subject, html, text };
}
