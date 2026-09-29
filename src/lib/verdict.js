/* ─────────────────────────────────────────────────────────────────────────
 * THE VERDICT — one recall, one location, one honest sentence
 *
 * Every surface that answers "does this recall concern me?" — the recall
 * sheet, a shared link, the OG card, a push notification — goes through
 * `verdictFor`, so the answer is worded once and cannot drift between them.
 *
 * There are four answers, and the one that is missing is deliberate:
 *
 *   in_area     the notice lists your state, or says nationwide
 *   not_listed  the notice lists states, and yours is not among them
 *   unstated    the notice names no geography at all
 *   ended       the agency has closed the recall
 *   announced   a company announcement FDA has not classified yet, naming no
 *               geography (one that names states gets the answers above)
 *
 * There is no "safe". A distribution list is what the recalling firm told the
 * agency it shipped to; product is re-shipped by distributors, carried across
 * state lines by people, and sold on through channels no notice records. So
 * `not_listed` is phrased as exactly what we know — your state is not on the
 * list — and always carries the caveat that lists can be incomplete. The same
 * rule the scanner follows for an unmatched barcode (see the README).
 *
 * `unstated` is not `nationwide`. "Sold at Trader Joe's stores" names a chain
 * and nothing else; flattening that into "nationwide" invents a claim the
 * agency never made, and flattening it into "not listed" invents the opposite.
 *
 * Coverage is split from the verdict on purpose. `coverageOf` reads only the
 * notice — which states it names, or that it says nationwide — and knows
 * nothing about where the reader is, so it can be computed once when the
 * national index is built and stored on the record. `verdictFor` is the only
 * place a location meets it.
 * ───────────────────────────────────────────────────────────────────────── */
import { ABBR_TO_NAME, abbrForName } from "./states.js";
import { chainsInText, byId } from "./retailers.js";

export const VERDICTS = {
  IN_AREA: "in_area",
  NOT_LISTED: "not_listed",
  UNSTATED: "unstated",
  ENDED: "ended",
  /* Not in the four above because it is not an answer about the recall: we
   * were not told where the reader is. Everything except an ended recall
   * gets this when `loc` is null, rather than a guess. */
  NEEDS_LOCATION: "needs_location",
  /* A company press release the FDA has posted but not yet classified: no
   * enforcement record, so no distribution list. When the release itself
   * names states (or says nationwide) the normal geographic answer is given
   * instead, with `announced: true` and a `note` saying where it came from. */
  ANNOUNCED: "announced",
};

/** A company announcement (FDA press-release feed) with no enforcement record
 *  behind it yet. See scripts/build-index.mjs. */
export function isAnnounced(r) {
  return !!r && (r.status === "announced" || r.announcement === true);
}

const ANNOUNCED_NOTE =
  "From the company's announcement. The FDA hasn't classified this recall or published its distribution list yet.";

export const NATIONWIDE_RE =
  /nation\s?wide|national distribution|throughout the (?:u\.?s|united states)|all (?:50 )?(?:u\.?s\.? )?states|across the (?:u\.?s|united states)|(?:^|\W)usa?(?:\W|$)|worldwide|international/i;

const STATE_ABBRS = Object.keys(ABBR_TO_NAME);

/* Longest names first, and each match is blanked out before the next name is
 * tried. Without that, "West Virginia" also matched "Virginia" and a notice
 * shipped only to WV told a Virginian it was "Distributed in Virginia" — the
 * one direction of error this module exists to never make loudly. */
const NAMES_LONGEST_FIRST = Object.entries(ABBR_TO_NAME)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([abbr, name]) => [abbr, new RegExp(`(^|[^A-Za-z])${name}(?=[^A-Za-z]|$)`, "gi")]);

const ABBR_RES = STATE_ABBRS.map((abbr) => [abbr, new RegExp(`(^|[^A-Za-z])${abbr}([^A-Za-z]|$)`)]);

/** Which states a piece of distribution text names, as sorted two-letter
 *  codes. Empty means it named none — which is either nationwide or unstated,
 *  and telling those apart is NATIONWIDE_RE's job, not this one's. */
export function statesIn(text) {
  let t = String(text || "");
  const found = new Set();
  for (const [abbr, re] of NAMES_LONGEST_FIRST) {
    if (re.test(t)) {
      found.add(abbr);
      re.lastIndex = 0;
      t = t.replace(re, "$1 ");
    }
    re.lastIndex = 0;
  }
  // Case-sensitive: "OR", "IN" and "DE" are states; "or", "in", "de" are not.
  // Case cannot help in text with no lower case at all ("DISTRIBUTED IN
  // CALIFORNIA"), so there an ambiguous code only counts in a list of states
  // ("IL, IN, IA") — see AMBIGUOUS_STATE_ABBRS.
  const shouting = !/[a-z]/.test(t);
  for (const [abbr, re] of ABBR_RES) {
    if (!re.test(t)) continue;
    if (shouting && AMBIGUOUS_STATE_ABBRS.has(abbr) && !inStateList(t, abbr)) continue;
    found.add(abbr);
  }
  return [...found].sort();
}

/* ─────────────────────────────────────────────────────────────────────────
 * Two-letter codes that are also ordinary words
 *
 * openFDA's text search is case-insensitive, so `distribution_pattern:"IN"`
 * matches the word "in" and returns nearly every notice. The rule for this
 * list: a code belongs here when its lower-case form is a word that turns up
 * in ordinary distribution prose — an English word (in, or, me, ok, hi), a
 * Spanish/Arabic article common in firm and brand names that notices quote
 * (de, la, al — "Productos de la Sierra", "Al Safa"), or a routine
 * abbreviation (co = company, id = identifier). Codes whose lower-case forms
 * are rare in notices (pa, ma, oh, ne, mo, ga, …) are left out: querying them
 * costs nothing extra. For these, sources.js queries only the full state
 * name, and statesIn's case-sensitive match is what finds the abbreviation.
 * ───────────────────────────────────────────────────────────────────────── */
export const AMBIGUOUS_STATE_ABBRS = new Set(["IN", "OR", "ME", "OK", "HI", "DE", "LA", "AL", "CO", "ID"]);

/** In an all-caps text, is this code in a list with another state code
 *  ("CA, OR, WA", "IN/OH", "IN AND OH")? Bare whitespace does not count:
 *  "IN CA" is "in California". */
function inStateList(t, abbr) {
  const other = `(?:${STATE_ABBRS.filter((a) => a !== abbr).join("|")})`;
  const sep = "\\s*(?:[,;/&]|\\bAND\\b)\\s*";
  const re = new RegExp(`(?:(?:^|[^A-Z])${other}${sep}${abbr}(?![A-Z]))|(?:(?:^|[^A-Z])${abbr}${sep}${other}(?![A-Z]))`);
  return re.test(t);
}

/** Normalize whatever location shape a caller holds into both spellings.
 *  Returns null when neither resolves to a state we know. */
export function resolveLoc(loc) {
  if (!loc) return null;
  let abbr = loc.stateAbbr ? String(loc.stateAbbr).toUpperCase() : null;
  if (abbr && !ABBR_TO_NAME[abbr]) abbr = null;
  if (!abbr && loc.state) abbr = abbrForName(loc.state);
  if (!abbr) return null;
  return { stateAbbr: abbr, state: ABBR_TO_NAME[abbr] };
}

/** Where a notice says the product went, independent of any reader.
 *
 *  Trusts, in order: a `coverage` already computed into the national index;
 *  the normalizer's `scope` of nationwide; the normalizer's `states`; and last
 *  the verbatim distribution text. A record whose scope is `unstated` is
 *  never re-read into "nationwide" — the normalizer already decided the text
 *  did not say so, and for FSIS that decision was made on structured fields
 *  this function cannot see. */
export function coverageOf(record) {
  const r = record || {};
  const listed = Array.isArray(r.states) ? r.states.filter((s) => ABBR_TO_NAME[s]).sort() : [];
  if (r.coverage === "nationwide") return { kind: "nationwide", states: [] };
  if (r.coverage === "states" && listed.length) return { kind: "states", states: listed };
  if (r.coverage === "unstated") return { kind: "unstated", states: [] };
  if (r.scope === "nationwide") return { kind: "nationwide", states: [] };
  if (listed.length) return { kind: "states", states: listed };
  if (r.scope === "unstated") return { kind: "unstated", states: [] };
  const text = String(r.distribution || "");
  if (NATIONWIDE_RE.test(text)) return { kind: "nationwide", states: [] };
  const found = statesIn(text);
  if (found.length) return { kind: "states", states: found };
  return { kind: "unstated", states: [] };
}

/** Chains the notice names. Normalized records carry `retailerIds`; records
 *  from the national index may not, so fall back to reading the text the
 *  normalizers read. */
function retailersOf(r) {
  if (Array.isArray(r.retailerIds)) return r.retailerIds;
  return chainsInText([r.distribution, r.product, r.reason, r.firm].filter(Boolean).join(" \n "))
    .map((c) => c.id);
}

function isEnded(r) {
  // `status` wins whenever it is present. normalizeFsis now keeps USDA's raw
  // "not active" flag as `active` for the Closed chip, but only turns it into
  // status 'ended' past FSIS_TRUST_CLOSED_DAYS (see fsisStatus in sources.js),
  // so reading `active === false` here would bring back the young Class I
  // notice headlined "This recall has ended". `active === false` alone is the
  // pre-status FSIS spelling, honoured only for records cached before
  // `status` existed.
  return r.status ? r.status === "ended" : r.active === false;
}

/** Does this recall belong in the "anywhere in ST" list?
 *
 *  Nationwide, or naming the reader's state — as it always was. A notice that
 *  names no geography earns a place only by naming a chain we can put on a
 *  map: without one it is a recall we cannot tie to anywhere, and listing it
 *  under a heading about your area would be a lie. It is still a real recall,
 *  so the normalizers keep it and the verdict sheet can explain it; it is the
 *  area list alone that leaves it out.
 *
 *  Ended recalls are deliberately NOT excluded here: closed FSIS notices are
 *  listed with a Closed chip, because recalled food outlives the paperwork. */
export function isInArea(record, loc) {
  const L = resolveLoc(loc);
  if (!record || !L) return false;
  const cov = coverageOf(record);
  if (cov.kind === "nationwide") return true;
  if (cov.kind === "states") return cov.states.includes(L.stateAbbr);
  /* An announcement with no geography is never "yours": nothing has been
   * published about where it went, so it must not swell an area count.
   * Search still shows it, with the ANNOUNCED verdict. */
  if (isAnnounced(record)) return false;
  return retailersOf(record).length > 0;
}

function listStates(states) {
  return states.join(", ");
}

function fmtDay(d) {
  if (!d) return "";
  const t = new Date(d);
  if (isNaN(t)) return "";
  return t.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function coverageSentence(cov, r) {
  if (cov.kind === "nationwide") return "The notice lists nationwide distribution.";
  if (cov.kind === "states") return `Sent to ${listStates(cov.states)}.`;
  const chains = retailersOf(r).map((id) => byId(id)).filter(Boolean).map((c) => c.label);
  return chains.length
    ? `The notice names ${chains.slice(0, 3).join(", ")} but no state, and doesn't say nationwide.`
    : "The notice names no state and doesn't say nationwide.";
}

const CAVEAT =
  "Distribution lists can be incomplete — products are sometimes re-shipped by distributors.";

/** The one sentence, plus what it rests on.
 *
 *  { verdict, headline, detail, states, evidence, announced?, note? }
 *    states    — the states the notice names (empty for nationwide/unstated)
 *    evidence  — the distribution text exactly as the agency published it, so
 *                any surface can show the reader what the verdict was read from
 *    announced — true for a company announcement not yet classified by FDA;
 *                `note` then says so, whatever the verdict
 */
export function verdictFor(record, loc) {
  const r = record || {};
  if (isAnnounced(r) && !isEnded(r)) {
    const cov = coverageOf(r);
    if (cov.kind === "unstated") {
      return {
        states: [],
        evidence: String(r.distribution || ""),
        verdict: VERDICTS.ANNOUNCED,
        headline: "Announced, not yet classified",
        detail: "The company announced this recall; the FDA hasn't published where it was distributed yet. Check the notice.",
        announced: true,
        note: ANNOUNCED_NOTE,
      };
    }
    return { ...geographicVerdict({ ...r, status: "active" }, loc), announced: true, note: ANNOUNCED_NOTE };
  }
  return geographicVerdict(r, loc);
}

function geographicVerdict(record, loc) {
  const r = record || {};
  const cov = coverageOf(r);
  const evidence = String(r.distribution || "");
  const base = { states: cov.states, evidence };
  const L = resolveLoc(loc);

  if (isEnded(r)) {
    const when = fmtDay(r.endDate);
    return {
      ...base,
      verdict: VERDICTS.ENDED,
      headline: "This recall has ended",
      detail:
        `The agency closed this recall${when ? ` on ${when}` : ""}. That means the firm finished ` +
        "recovering what it could reach — not that every package came back. If you have the product, " +
        "it is still the recalled product. " + coverageSentence(cov, r),
    };
  }

  if (!L) {
    return {
      ...base,
      verdict: VERDICTS.NEEDS_LOCATION,
      headline: "Add your location to check your state",
      detail: coverageSentence(cov, r),
    };
  }

  if (cov.kind === "nationwide") {
    return {
      ...base,
      verdict: VERDICTS.IN_AREA,
      headline: "Distributed nationwide",
      detail: `The notice lists nationwide distribution, which includes ${L.state}. ` +
        "A store near you may never have stocked the recalled lot — check the product codes.",
    };
  }

  if (cov.kind === "states") {
    if (cov.states.includes(L.stateAbbr)) {
      return {
        ...base,
        verdict: VERDICTS.IN_AREA,
        headline: `Distributed in ${L.state}`,
        detail: `Sent to ${listStates(cov.states)}. ${L.state} is listed. ` +
          "A store near you may never have stocked the recalled lot — check the product codes.",
      };
    }
    return {
      ...base,
      verdict: VERDICTS.NOT_LISTED,
      headline: `Not reported in ${L.state}`,
      detail: `Sent to ${listStates(cov.states)}. ${L.state} isn't listed. ${CAVEAT}`,
    };
  }

  return {
    ...base,
    verdict: VERDICTS.UNSTATED,
    headline: "The notice doesn't say where it was sold",
    detail: coverageSentence(cov, r) + " Check the official notice, and the product codes, before assuming it didn't reach you.",
  };
}
