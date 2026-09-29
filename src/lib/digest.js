/* ─────────────────────────────────────────────────────────────────────────
 * THE QUICK-CHECK DIGEST — one sentence, answer first
 *
 * The home digest answers the question people actually open the app with —
 * "anything new I should know about?" — before it asks them to read a list.
 * Everything here is pure (no React, no DOM beyond guarded storage), so the
 * counting and the wording can be exercised from node against fixtures.
 *
 * The rules it keeps, because they are the product's rules:
 *
 *   - It counts, it does not reassure. "Nothing new in CA this week" is a
 *     statement about the notices we read, so it always travels with the
 *     total still in force and the words "that we know of". It never says
 *     "safe", "clear" or "all good".
 *   - "New" is by the date the agency put on the notice, not by whether it is
 *     still open. USDA flags most of its notices not-active within days (see
 *     FSIS_TRUST_CLOSED_DAYS in sources.js), so dropping ended records
 *     from "new this week" would hide a Class I recall issued on Tuesday.
 *     Ended records still sort after active ones, and their stories say so.
 *   - The window is the reader's last visit when we have one, and a week when
 *     we don't. A last visit older than MAX_SINCE_DAYS is clamped, and the
 *     sentence says the clamped window rather than a date the data may not
 *     reach back to.
 * ───────────────────────────────────────────────────────────────────────── */
import { categoryFor } from "./category.js";
import { reasonFor } from "./reason.js";
import { byAisle } from "./search-index.js";
import { resolveLoc, isAnnounced } from "./verdict.js";
import { markVisit } from "./follows.js";

const DAY_MS = 86400000;
export const WEEK_DAYS = 7;
/* Past this, "since your last visit (Feb 3)" promises a reach-back the area
 * list may not have — the live feeds are windowed — so say the window. */
export const MAX_SINCE_DAYS = 60;
/* How far back an aisle's stories reach. Stories are a way in, not the whole
 * list: a year of CPSC notices as 115 swipes is a chore, not a check. */
export const AISLE_WINDOW_DAYS = 30;
export const AISLE_MAX = 12;

const FOOD_SOURCES = new Set(["FDA Food", "USDA FSIS"]);
const sevRank = { high: 0, med: 1, low: 2 };

// ------------------------------------------------------------ record shape

/** 'YYYY-MM-DD' for a Date, an ISO string, or a bare day; '' when unknown.
 *  Normalized records carry a Date, index records a day string. */
export function dayOf(d) {
  if (!d) return "";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = d instanceof Date ? d : new Date(d);
  return isNaN(t) ? "" : t.toISOString().slice(0, 10);
}

/** The day a notice became news: the later of its own date and, for FDA,
 *  the day FDA published it (`posted`, the enforcement report date). An FDA
 *  recall initiated in August and classified in late September is new in
 *  late September — dated by initiation alone it never counted as new at
 *  all, since FDA posts notices weeks after they start. */
export function newsDay(r) {
  const a = dayOf(r && r.date);
  const b = dayOf(r && r.posted);
  return b > a ? b : a;
}

/** category.js key, whichever shape the record came in. Index records carry
 *  the key already; the live normalizers don't, and App computes it on read. */
export function categoryKeyOf(r) {
  if (!r) return "product";
  if (typeof r.category === "string" && r.category) return r.category;
  if (r.category && typeof r.category === "object" && r.category.key) return r.category.key;
  return categoryFor(r).key;
}

function isEnded(r) {
  // Same rule as verdict.js: `status` when present (normalizeFsis applies the
  // FSIS_TRUST_CLOSED_DAYS rule to it), the raw flag only for old records.
  return r.status ? r.status === "ended" : r.active === false;
}

/** Severity first, active before ended, then newest. */
export function bySeriousness(a, b) {
  return (sevRank[a.severity] ?? 1) - (sevRank[b.severity] ?? 1) ||
    (isEnded(a) ? 1 : 0) - (isEnded(b) ? 1 : 0) ||
    dayOf(b.date).localeCompare(dayOf(a.date));
}

// ------------------------------------------------------------ plain words

/* Titles are written for a press office: "Fontanini Foods LLC Recalls Raw,
 * Frozen Pork Sausage Products Due to Possible Foreign Matter Contamination".
 * A reader wants "pork sausage". Same idea as productPhrase in
 * search-index.js, tuned for a sentence rather than a search chip: commas
 * inside a USDA title are adjective lists, commas inside an FDA description
 * start the pack size and UPC. */
const LEAD = /^(?:all|certain|select|some|various|not|ready-to-eat|raw|frozen|fresh|imported|ineligible|fully|cooked|uncooked|refrigerated|shelf-stable|heat-treated)\s+/i;

export function shortProduct(product, maxWords = 5) {
  let t = String(product || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/\brecalls?\s+(.*)$/i);
  if (m && m[1].length > 3) {
    t = m[1].replace(/,\s*/g, " ");
  } else {
    t = t.split(/,|;|\s[-–—]\s|\(/)[0];
  }
  t = t.split(/\s(?:recalled|due to|because|that|which|for possible|for undeclared|over|after|produced|sold|distributed|imported without|containing)\s/i)[0];
  t = t.split(/\s(?:products?|items?)(?:\s|$)/i)[0].trim();
  while (LEAD.test(t) && t.split(" ").length > 2) t = t.replace(LEAD, "");
  const words = t.split(" ").filter(Boolean).slice(0, maxWords);
  while (words.length > 1 && /^(?:and|or|of|from|with|in|the|for|to|by|&|\d[\d.\/-]*|(?:fl\.?|oz|lbs?|g|kg|ml|ct|count|pack|pk)\.?)$/i.test(words[words.length - 1])) words.pop();
  let out = words.join(" ");
  // FDA descriptions are often SHOUTED; a sentence shouldn't be.
  if (out && out === out.toUpperCase() && /[A-Z]{3}/.test(out)) {
    out = out.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return out;
}

/* Hazards that read as "X in the product" versus hazards that are a property
 * of a thing — "Listeria in spinach" but "Fire hazard: power bank". */
const IN_HAZARDS = new Set(["allergen", "listeria", "salmonella", "ecoli", "contamination", "foreign", "chemical"]);
const PLAIN_HAZARD = {
  allergen: "Undeclared allergen",
  listeria: "Listeria",
  salmonella: "Salmonella",
  ecoli: "E. coli",
  contamination: "Possible contamination",
  foreign: "Foreign material",
  chemical: "Chemical hazard",
  fire: "Fire or shock hazard",
  choking: "Choking hazard",
  injury: "Injury hazard",
  labeling: "Labeling problem",
  quality: "Quality defect",
};

/** The hazard, the way reason.js names it (the big type on a story). */
export function hazardLabel(r) {
  const { key, label } = reasonFor(r || {});
  /* reason.js's catch-all buckets are filter names, not warnings: "Other
   * contamination" when the USDA title itself says "Possible Foreign Matter
   * Contamination". Only those buckets defer to the title, and only USDA's,
   * whose "due to" clause is a hazard name rather than a legal paragraph. */
  if ((key === "contamination" || key === "other" || key === "unspecified") && r && r.source === "USDA FSIS") {
    const due = dueClause(r);
    if (due) return due;
  }
  if (key === "other") {
    const own = ownPhrase(r);
    if (own) return own;
  }
  return label;
}

/** The agency's own short reason ("Import Violation"), when it is a phrase
 *  and not a paragraph. */
function ownPhrase(r) {
  const own = String((r && r.reason) || "").split(/\s[—–-]\s|;/)[0].trim();
  return own && own.length <= 40 ? own : "";
}

function dueClause(r) {
  const m = String(r.product || "").match(/\bdue to\s+(.{4,80}?)(?:\s*[.;(]|$)/i);
  if (!m) return "";
  const t = m[1].trim();
  return (t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .replace(/\b(listeria|salmonella|clostridium|e\. ?coli)\b/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** The one-line "what's wrong with what", e.g. "Listeria in bagged spinach".
 *
 *  USDA titles carry a better hazard than the structured reason does —
 *  reason says "Product Contamination", the title says "Due to Possible
 *  Foreign Matter Contamination" — so a title's "due to" clause wins when
 *  there is one. Nothing is invented: every word comes from the notice. */
export function plainHeadline(r) {
  if (!r) return "";
  const product = shortProduct(r.product);
  // USDA only: CPSC titles also say "due to", but what follows is a legal
  // paragraph ("Risk of Serious Injury or Death from…"), not a hazard name.
  const due = r.source === "USDA FSIS" ? dueClause(r) : "";
  const key = reasonFor(r).key;
  /* "Other reason" is a filter bucket, not something to tell a person; the
   * agency's own short phrase ("Import Violation") says more when it is short
   * enough to be a phrase. */
  const hazard = due || PLAIN_HAZARD[key] || ownPhrase(r);
  if (!hazard) return product || "Recall notice";
  if (!product) return hazard;
  /* A USDA title's product is generic ("Pork Sausage") and reads right in
   * lower case mid-sentence; an FDA description usually leads with a brand,
   * whose capitals are part of its name. */
  const shown = r.source === "USDA FSIS" ? product.toLowerCase() : product;
  return due || IN_HAZARDS.has(key) ? `${hazard} in ${shown}` : `${hazard}: ${product}`;
}

/** Generic advice, by kind of thing — never specifics the notice didn't give.
 *
 *  Medicine is the exception to "stop using it": stopping a prescribed drug
 *  can be worse than the defect, which is why FDA's own recall language tells
 *  patients to ask first. So meds get that instead of a blanket stop. */
export function whatToDo(r) {
  const cat = categoryKeyOf(r);
  const steps = [];
  if (cat === "drug" || cat === "device" || cat === "supplement") {
    steps.push("Check the lot number against the notice");
    steps.push(cat === "supplement" ? "Stop taking it if it matches" : "Ask your pharmacist or doctor before stopping a prescribed product");
    steps.push("Return it where you bought it");
  } else if (FOOD_SOURCES.has(r && r.source) || cat === "pet") {
    steps.push(cat === "pet" ? "Don't feed it" : "Don't eat it");
    steps.push("Check the lot code");
    steps.push("Return it for a refund or throw it away");
  } else {
    steps.push("Stop using it");
    steps.push("Check the model or lot number");
    steps.push("Contact the firm for the remedy");
  }
  const codes = String((r && r.codeInfo) || "").replace(/\s+/g, " ").trim();
  return { steps, lot: codes ? (codes.length > 90 ? codes.slice(0, 89).trimEnd() + "…" : codes) : "" };
}

// ------------------------------------------------------------ the sentence

function monthDay(iso) {
  const t = new Date(iso);
  return isNaN(t) ? "" : t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function noun(records) {
  if (!records.length) return "recalls";
  const food = records.filter((r) => FOOD_SOURCES.has(r.source)).length;
  const kind = food === records.length ? "food " : food === 0 && records.every((r) => r.source === "CPSC") ? "product " : "";
  return `${kind}recall${records.length === 1 ? "" : "s"}`;
}

/** Everything the headline needs, from one list of in-area records.
 *
 *  { window: { since, label, kind: 'visit'|'week'|'clamped' }, place,
 *    fresh, serious, top, activeTotal, sentence, quiet }
 *
 *  `scope` "near" words it for the reader's state ("This week in NY"); "us",
 *  or no usable location, words it for the country ("This week in the US").
 *  `place` is the state in near mode, null in us. `announced` counts company
 *  announcements in the window, which are never part of `fresh`. */
export function summarize(records, { loc, scope = "near", lastVisit, now = Date.now() } = {}) {
  const L = resolveLoc(loc);
  const us = scope === "us" || !L;
  const place = us ? null : L.stateAbbr;
  const all = Array.isArray(records) ? records : [];
  /* A company announcement FDA has not classified yet has no class and, often,
   * no distribution: it is listed (see `announced` below) but never counted as
   * a new recall or as serious. */
  const list = all.filter((r) => !isAnnounced(r));
  const announcedList = all.filter(isAnnounced);

  let kind = "week";
  let sinceMs = now - WEEK_DAYS * DAY_MS;
  const lv = lastVisit ? Date.parse(lastVisit) : NaN;
  if (Number.isFinite(lv) && lv < now) {
    if (now - lv > MAX_SINCE_DAYS * DAY_MS) {
      kind = "clamped";
      sinceMs = now - MAX_SINCE_DAYS * DAY_MS;
    } else {
      kind = "visit";
      sinceMs = lv;
    }
  }
  const since = new Date(sinceMs).toISOString();
  const sinceDay = since.slice(0, 10);
  /* A notice is dated to the day, a visit to the millisecond. A notice dated
   * the same day as the last visit may have been published after it, so it
   * counts as new — erring toward showing it twice, never toward hiding it. */
  const fresh = list.filter((r) => newsDay(r) >= sinceDay).sort(bySeriousness);
  const serious = fresh.filter((r) => r.severity === "high").length;
  const activeTotal = list.filter((r) => !isEnded(r)).length;

  const where = us ? "in the US" : `in ${place}`;
  const label =
    kind === "visit" ? `Since your last visit (${monthDay(since)})`
    : kind === "clamped" ? `In the last ${MAX_SINCE_DAYS} days ${where}`
    : `This week ${where}`;
  const announced = announcedList.filter((r) => newsDay(r) >= sinceDay).length;

  let sentence;
  let quiet;
  if (fresh.length) {
    sentence = `${label}: ${fresh.length} new ${noun(fresh)}` + (serious ? ` · ${serious} serious` : "");
    quiet = "";
  } else {
    sentence =
      kind === "visit" ? `Nothing new ${where} since your last visit.`
      : kind === "clamped" ? `Nothing new ${where} in the last ${MAX_SINCE_DAYS} days.`
      : `Nothing new ${where} this week.`;
    quiet = activeTotal
      ? `${activeTotal} recall${activeTotal === 1 ? " is" : "s are"} still in force ${where}, that we know of.`
      : us ? "No recall notice we read is in force right now — that we know of."
        : `No recall notice we read lists ${place} right now — that we know of.`;
  }
  return {
    window: { since, label, kind }, place, scope: us ? "us" : "near",
    fresh, serious, top: fresh[0] || null, activeTotal, announced, sentence, quiet,
  };
}

// ------------------------------------------------------------ aisles

export const AISLE_KEYS = ["produce", "meat", "dairy", "bakery", "baby", "pet", "meds", "home"];
export const AISLE_LABELS = {
  produce: "Produce", meat: "Meat", dairy: "Dairy", bakery: "Bakery",
  baby: "Baby", pet: "Pet", meds: "Meds", home: "Home",
};

/** [{ key, label, records }] in walking order, every aisle present (an
 *  empty one renders dimmed, which is itself information). Records are the
 *  in-area ones dated within `windowDays`, most serious first, capped — the
 *  full list is one tap away, and the cap is reported as `more`. */
export function aislesFor(records, { now = Date.now(), windowDays = AISLE_WINDOW_DAYS, max = AISLE_MAX } = {}) {
  const sinceDay = new Date(now - windowDays * DAY_MS).toISOString().slice(0, 10);
  const recent = (records || [])
    .filter((r) => newsDay(r) >= sinceDay)
    .map((r) => (typeof r.category === "string" ? r : { ...r, category: categoryKeyOf(r) }));
  const grouped = byAisle(recent);
  return AISLE_KEYS.map((key) => {
    const all = (grouped[key] || []).slice().sort(bySeriousness);
    return { key, label: AISLE_LABELS[key], records: all.slice(0, max), more: Math.max(0, all.length - max) };
  });
}

// ------------------------------------------------------------ seen state

const SEEN_KEY = "rr-seen";
const SEEN_MAX = 600;
export const SEEN_EVENT = "rr-seen-change";

/** Ids of recalls this browser has already viewed as a story. */
export function getSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch (_) {
    return new Set();
  }
}

/** Add ids; oldest fall off past SEEN_MAX so the key can't grow forever.
 *  Returns the new set (also when storage refused the write — the session
 *  still remembers, the next one simply shows the rings again). */
export function markSeen(ids) {
  const add = (Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === "string" && x);
  const seen = getSeen();
  let changed = false;
  for (const id of add) {
    if (seen.has(id)) continue;
    seen.add(id);
    changed = true;
  }
  if (!changed) return seen;
  const list = [...seen].slice(-SEEN_MAX);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch (_) { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(SEEN_EVENT)); } catch (_) { /* no window */ }
  return new Set(list);
}

// ------------------------------------------------------------ visit baseline

/* "Since your last visit" needs the PREVIOUS visit, and a reload must not
 * move it: markVisit() stamps now, so calling it on every mount would turn a
 * refresh into "nothing new since 4 seconds ago". The baseline is taken once
 * per tab — module memory first, sessionStorage so a reload keeps it — and
 * markVisit runs exactly once alongside it. */
const BASELINE_KEY = "rr-visit-baseline";
let baselineMemo;

export function visitBaseline() {
  if (baselineMemo !== undefined) return baselineMemo;
  try {
    const s = sessionStorage.getItem(BASELINE_KEY);
    if (s !== null) {
      baselineMemo = s || null;
      return baselineMemo;
    }
  } catch (_) { /* fall through to a fresh stamp */ }
  baselineMemo = markVisit();
  try { sessionStorage.setItem(BASELINE_KEY, baselineMemo || ""); } catch (_) { /* memo still holds */ }
  return baselineMemo;
}
