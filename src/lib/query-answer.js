/* ─────────────────────────────────────────────────────────────────────────
 * ONE ANSWER FOR A SEARCH — what pressing Enter shows
 *
 * Typing shows the evidence: every matching notice. Enter asks the question
 * people actually have — "is the thing I'm worried about recalled where I
 * live?" — and answers it in one line, with the reasons under it and the
 * notices one tap away. Five answers:
 *
 *   recalled   an active notice for it reached the reader's state (or went
 *              nationwide) — "Yes — 1 active recall reached New York"
 *   check      something could affect them but the notice doesn't say where
 *              it went, or it was announced and FDA hasn't said yet
 *   clear      matching notices exist, but none active reached their state —
 *              "No active recall for “romaine” reached New York"
 *   none       no notice we hold matches at all
 *   needsLoc   no location, so there is no verdict to give, only coverage
 *
 * "clear" is the one people come for, and the one most easily overstated.
 * It is calm, never green, never "safe": it says what was checked (which
 * agencies, as of when) and why each match doesn't apply ("2 went to other
 * states, 1 has ended"), and the list is right there for anyone who wants to
 * look. What it can't know — a recall too new to be in the data, a product
 * no agency here covers — is said as plainly as the good news.
 *
 * Only notices that are ABOUT the query count (relevance ≥ 2, the same tiers
 * as the list): a cookie whose ingredients mention sugar does not make
 * "sugar" recalled in your state.
 * ───────────────────────────────────────────────────────────────────────── */
import { verdictFor, resolveLoc, VERDICTS } from "./verdict.js";
import { relevanceOf } from "./relevance.js";

const isEnded = (r) => (r.status ? r.status === "ended" : r.active === false);
const dayOf = (r) => String((r && (r.posted || r.date)) || "").slice(0, 10);

/** The cards to cycle through, best first: notices that reached the reader,
 *  then ones that might have, then the rest; within each, closest match,
 *  then newest. Ended notices last. */
export function bestGuesses(records, q, loc, max = 5) {
  const L = resolveLoc(loc);
  const rank = {
    [VERDICTS.IN_AREA]: 0, [VERDICTS.UNSTATED]: 1, [VERDICTS.ANNOUNCED]: 1,
    [VERDICTS.NEEDS_LOCATION]: 1, [VERDICTS.NOT_LISTED]: 2, [VERDICTS.ENDED]: 3,
  };
  return [...(records || [])]
    .map((r) => ({ r, v: verdictFor(r, L).verdict, rel: relevanceOf(r, q) }))
    .sort((a, b) =>
      (isEnded(a.r) - isEnded(b.r)) ||
      (b.rel >= 2) - (a.rel >= 2) ||
      ((rank[a.v] ?? 2) - (rank[b.v] ?? 2)) ||
      (b.rel - a.rel) ||
      dayOf(b.r).localeCompare(dayOf(a.r)))
    .slice(0, max)
    .map((x) => x.r);
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * @returns {{ kind, headline, lines: string[], counts }}
 *   kind: "recalled" | "check" | "clear" | "none" | "needsLoc"
 */
export function answerFor(records, q, loc) {
  const L = resolveLoc(loc);
  const all = records || [];
  const about = all.filter((r) => relevanceOf(r, q) >= 2);
  const pool = about.length ? about : all;
  const counts = { inArea: 0, unstated: 0, announced: 0, notListed: 0, ended: 0, needsLoc: 0 };
  const states = new Set();
  for (const r of pool) {
    const v = verdictFor(r, L).verdict;
    if (v === VERDICTS.IN_AREA) counts.inArea++;
    else if (v === VERDICTS.UNSTATED) counts.unstated++;
    else if (v === VERDICTS.ANNOUNCED) counts.announced++;
    else if (v === VERDICTS.NOT_LISTED) { counts.notListed++; (r.states || []).forEach((s) => states.add(s)); }
    else if (v === VERDICTS.ENDED) counts.ended++;
    else if (v === VERDICTS.NEEDS_LOCATION) counts.needsLoc++;
  }
  const quoted = `“${q}”`;
  const where = L ? L.state : "";

  if (!pool.length) {
    return {
      kind: "none",
      headline: `No recall matches ${quoted}`,
      lines: ["No FDA, USDA or CPSC notice we hold uses those words."],
      counts,
    };
  }
  if (!L) {
    const active = pool.filter((r) => !isEnded(r)).length;
    return {
      kind: "needsLoc",
      headline: active
        ? `${plural(active, "active recall")} ${active === 1 ? "matches" : "match"} ${quoted}`
        : `Only ended recalls match ${quoted}`,
      lines: ["Set your location to check whether any of them reached you."],
      counts,
    };
  }

  const why = [];
  if (counts.notListed) {
    const list = [...states].sort();
    const named = list.length && list.length <= 4 ? ` (${list.join(", ")})` : "";
    why.push(`${counts.notListed} went only to other states${named}`);
  }
  if (counts.ended) why.push(`${counts.ended} ${counts.ended === 1 ? "has" : "have"} ended`);

  if (counts.inArea) {
    return {
      kind: "recalled",
      headline: `Yes — ${plural(counts.inArea, "active recall")} for ${quoted} reached ${where}`,
      lines: [`Check the brand, size and lot code on yours against ${counts.inArea === 1 ? "the notice" : "each notice"} — not every package of ${quoted} is affected.`],
      counts,
    };
  }
  if (counts.unstated || counts.announced) {
    const bits = [];
    if (counts.unstated) bits.push(`${plural(counts.unstated, "notice")} ${counts.unstated === 1 ? "doesn't" : "don't"} say where it went`);
    if (counts.announced) bits.push(`${plural(counts.announced, "recall")} ${counts.announced === 1 ? "was" : "were"} just announced, before FDA said where`);
    return {
      kind: "check",
      headline: `Can't rule it out in ${where}`,
      lines: [bits.join("; ") + ".", ...(why.length ? [`The others: ${why.join(", ")}.`] : [])],
      counts,
    };
  }
  return {
    kind: "clear",
    headline: `No active recall for ${quoted} reached ${where}`,
    lines: [`${plural(pool.length, "notice")} ${pool.length === 1 ? "matches" : "match"}: ${why.join(", ")}.`],
    counts,
  };
}
