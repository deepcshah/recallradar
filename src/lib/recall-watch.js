/* ─────────────────────────────────────────────────────────────────────────
 * RECALL WATCH — "notify me about updates" on one specific recall
 *
 * A followed recall is an id plus a SNAPSHOT of the few public fields whose
 * change is worth telling someone about:
 *
 *   { s: "active" | "ended" | "announced",   status
 *     k: "nationwide" | "states" | "unstated",  coverage kind
 *     st: ["MN", "WI"],                       states the notice names (sorted)
 *     c: "I" | "II" | "III" | "unclassified" | "<agency word>",  class
 *     a: true?,                               a company announcement
 *     f: "Example Foods",                     firm (announcements only — to
 *                                             find the enforcement record)
 *     d: "2026-09-25",                        the notice's date
 *     m: "fda-food-…"? }                      the enforcement record an
 *                                             announcement turned into
 *
 * Everything in it is public recall data copied from the notice; nothing in
 * it is about the reader. The browser keeps one per followed recall in
 * localStorage (follows.js), and — only when an alert channel is on — the
 * server keeps its own copy per subscriber, computed by the SERVER from the
 * national index (never taken from the client), so the cron can diff.
 *
 * What counts as an update, and what deliberately does not:
 *
 *   status       active → ended (the agency closed it), or the reverse.
 *   distribution states ADDED, or coverage widened to nationwide. A state
 *                disappearing is not announced: index rebuilds re-read the
 *                distribution text, and "TX was removed" from a parser change
 *                would be a false all-clear — the one message this app never
 *                sends.
 *   class        the classification changed (II → I, or unclassified → I).
 *   classified   a followed FDA announcement (press release) now has its
 *                enforcement record: same firm (firm.js sameFirm), FDA, dated
 *                within 45 days — the same rule the index build uses to drop
 *                the announcement.
 *
 * Pure and isomorphic: runs in the browser (the Alerts inbox) and in node
 * (api/_lib/alerts-engine.js), so both say the same thing about one change.
 * ───────────────────────────────────────────────────────────────────────── */
import { coverageOf, isAnnounced, isInArea } from "./verdict.js";
import { sameFirm } from "./firm.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/* A recall id as the app mints them (sources.js / build-index.mjs):
 * fda-food-F-1234-2026, fda-food-e98765-1x2y3z, fda-ann-h7u17f, fsis-023-2026,
 * fsis-PHA-08082026-01, cpsc-10991. Agency prefix required; a conservative
 * character set; nothing that could be a path or a URL. The server refuses
 * anything else (push-store.js cleanRecallIds), so the app only offers
 * "Notify me" on ids that pass — "fda-food-N/A" from an old index does not. */
const RECALL_ID = /^(?:fda-(?:food|drug|device|ann)|fsis|cpsc)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isRecallId(v) {
  return typeof v === "string" && RECALL_ID.test(v) && !v.includes("..");
}
/** Same window build-index.mjs uses to drop an announcement as a duplicate. */
export const ANNOUNCE_MATCH_DAYS = 45;

function dayOf(d) {
  if (!d) return "";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const t = d instanceof Date ? d : new Date(d);
  return isNaN(t) ? "" : t.toISOString().slice(0, 10);
}

export function statusKey(r) {
  if (!r) return "";
  if (isAnnounced(r)) return "announced";
  const ended = r.status ? r.status === "ended" : r.active === false;
  return ended ? "ended" : "active";
}

/** "Class I", "High - Class I" → "I"; "Not yet classified" → "unclassified";
 *  anything else (CPSC's empty, USDA's "Public Health Alert") → its own word,
 *  lower-cased, so a change between two of them is still a change. */
export function classKey(r) {
  const c = String((r && r.classification) || "").trim();
  const m = /\bclass\s+(I{1,3})\b/i.exec(c);
  if (m) return m[1].toUpperCase();
  if (!c || /not\s+yet\s+classified/i.test(c)) return "unclassified";
  return c.toLowerCase().slice(0, 40);
}

const CLASS_WORDS = { I: "Class I", II: "Class II", III: "Class III", unclassified: "not yet classified" };
export function classLabel(k) {
  return CLASS_WORDS[k] || k || "unknown";
}

/** The snapshot of one record (see the top of this file). */
export function recallSnapshot(r) {
  if (!r) return null;
  const cov = coverageOf(r);
  const snap = {
    s: statusKey(r),
    k: cov.kind,
    st: [...cov.states].sort(),
    c: classKey(r),
    d: dayOf(r.date),
  };
  if (isAnnounced(r)) {
    snap.a = true;
    snap.f = String(r.firm || "").slice(0, 80);
  }
  return snap;
}

/** A short stable fingerprint of a snapshot, for dedupe keys ("u:<id>:<h>").
 *  djb2 over a canonical string — not a security hash, and not meant to be. */
export function snapshotHash(snap) {
  if (!snap) return "0";
  const canon = [snap.s, snap.k, (snap.st || []).join(","), snap.c, snap.a ? "a" : "", snap.m || ""].join("|");
  let h = 5381;
  for (let i = 0; i < canon.length; i++) h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Strict check of a stored/received snapshot. Returns a clean copy or null. */
export function cleanSnapshot(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = ["active", "ended", "announced"].includes(v.s) ? v.s : null;
  const k = ["nationwide", "states", "unstated"].includes(v.k) ? v.k : null;
  if (!s || !k) return null;
  const st = Array.isArray(v.st) ? v.st.filter((x) => typeof x === "string" && /^[A-Z]{2}$/.test(x)).slice(0, 60) : [];
  const c = typeof v.c === "string" ? v.c.slice(0, 40) : "unclassified";
  const d = typeof v.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.d) ? v.d : "";
  const out = { s, k, st, c, d };
  if (v.a === true) {
    out.a = true;
    out.f = typeof v.f === "string" ? v.f.slice(0, 80) : "";
  }
  if (typeof v.m === "string" && v.m.length <= 100) out.m = v.m;
  return out;
}

/** The FDA enforcement record a followed announcement became, or null. */
export function enforcementFor(snap, records) {
  if (!snap || !snap.a || !snap.f) return null;
  const t = Date.parse(snap.d);
  if (!Number.isFinite(t)) return null;
  for (const r of records || []) {
    if (!r || isAnnounced(r) || !String(r.source || "").startsWith("FDA")) continue;
    const d = Date.parse(dayOf(r.date));
    if (!Number.isFinite(d) || Math.abs(d - t) > ANNOUNCE_MATCH_DAYS * DAY_MS) continue;
    if (sameFirm(snap.f, r.firm)) return r;
  }
  return null;
}

/**
 * What changed between a snapshot and the record as it is now.
 *
 * @param {object|null} prev     the stored snapshot (null: nothing to compare
 *                               against yet — never an update, only a baseline)
 * @param {object|null} current  the record now, or null when it isn't found
 * @param {object[]} [pool]      records to search for an announcement's
 *                               enforcement record (the index's recalls)
 * @returns {{ changes: object[], next: object|null, record: object|null }}
 *   changes  [{ kind: 'status'|'states'|'nationwide'|'class'|'classified', … }]
 *   next     the snapshot to store after this has been reported
 *   record   the record the changes are about (the enforcement record for
 *            'classified')
 */
export function diffRecall(prev, current, pool = null) {
  const p = cleanSnapshot(prev);
  let rec = current || null;
  const changes = [];

  // An announcement that has turned into an enforcement record. The id the
  // reader followed may have left the index (the build drops announcements
  // once openFDA has them), so look for its successor by firm and date.
  if (p && p.a && !p.m) {
    const succ = (rec && !isAnnounced(rec) && String(rec.source || "").startsWith("FDA")) ? rec : enforcementFor(p, pool);
    if (succ) {
      const next = { ...recallSnapshot(succ), m: succ.id };
      delete next.a; delete next.f;
      changes.push({ kind: "classified", to: classKey(succ), id: succ.id });
      return { changes, next, record: succ };
    }
  }
  if (!rec) return { changes, next: p, record: null };
  const now = recallSnapshot(rec);
  if (p && p.m) now.m = p.m;
  if (p && p.a && now.a && p.f && !now.f) now.f = p.f;
  if (!p) return { changes, next: now, record: rec };

  if (p.s !== now.s && !(p.s === "announced" || now.s === "announced")) {
    changes.push({ kind: "status", from: p.s, to: now.s });
  }
  if (now.k === "nationwide" && p.k !== "nationwide") {
    changes.push({ kind: "nationwide" });
  } else if (now.k === "states") {
    const had = new Set(p.k === "states" ? p.st : []);
    const added = now.st.filter((s) => !had.has(s));
    // From "unstated" to a list is also new distribution information.
    if (added.length && p.k !== "nationwide") changes.push({ kind: "states", added });
  }
  if (p.c !== now.c && !(p.a && now.a)) {
    changes.push({ kind: "class", from: p.c, to: now.c });
  }
  return { changes, next: now, record: rec };
}

/** One change in words. Plain, never reassuring: an ended recall is not
 *  "safe", and the sentence says the product may still be at home. */
export function describeChange(ch, stateAbbr) {
  switch (ch && ch.kind) {
    case "status":
      if (ch.to === "ended") return "The agency has closed this recall. Recalled product can still be in homes — check yours.";
      if (ch.to === "active") return "This recall is listed as active again.";
      return `Status changed to ${ch.to}.`;
    case "nationwide":
      return "Distribution is now listed as nationwide.";
    case "states": {
      const mine = stateAbbr && ch.added.includes(stateAbbr);
      const list = ch.added.slice(0, 8).join(", ") + (ch.added.length > 8 ? ` +${ch.added.length - 8}` : "");
      return `${mine ? `Now includes ${stateAbbr}. ` : ""}States added to the distribution list: ${list}.`;
    }
    case "class":
      return `Classification changed: ${classLabel(ch.from)} → ${classLabel(ch.to)}.`;
    case "classified":
      return `FDA has now classified this recall (${classLabel(ch.to)}) and published its distribution.`;
    default:
      return "This recall was updated.";
  }
}

/** A short label for a list row or a notification title. */
export function changeLabel(ch) {
  switch (ch && ch.kind) {
    case "status": return ch.to === "ended" ? "Closed by the agency" : "Status changed";
    case "nationwide": return "Now nationwide";
    case "states": return `${ch.added.length} state${ch.added.length === 1 ? "" : "s"} added`;
    case "class": return `Now ${classLabel(ch.to)}`;
    case "classified": return "Classified by FDA";
    default: return "Updated";
  }
}

/** Does a follow-TERM match deserve the reader's attention, for a reader in
 *  `stateAbbr`? In their area, or naming no geography at all (a brand they
 *  buy, recalled with no distribution published, is exactly what a follow is
 *  for). A notice that names other states and not theirs is left out — the
 *  same "in your area" line the digest draws. No state: every match. Ended
 *  recalls never alert. Shared by the inbox and the cron. */
export function followRelevant(r, stateAbbr) {
  if (!r || statusKey(r) === "ended") return false;
  if (!stateAbbr) return true;
  if (isInArea(r, { stateAbbr })) return true;
  return coverageOf(r).kind === "unstated";
}
