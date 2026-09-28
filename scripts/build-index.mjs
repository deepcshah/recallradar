/* Build the national recall index: public/feeds/index.json.
 *
 * Every other dataset in this app is scoped to a place before it is fetched —
 * the openFDA queries name a state, the area list keeps what covers it. That
 * makes the app blind to the question it is most often asked, "is *this*
 * recalled?", whenever the answer lives in some other state's notices. This
 * file is the location-free answer: every recall from all three agencies in
 * the last year, active and ended alike, in one static file the browser can
 * search without a server round trip (src/lib/search-index.js) and the server
 * can read off disk (src/lib/index-server.js).
 *
 * Sources:
 *   USDA FSIS and CPSC — the snapshots scripts/refresh-feeds.mjs has just
 *     written beside this file. Not refetched: that script already walked the
 *     identity ladder, retried, and health-checked them, and doing it twice
 *     would only give the two files a chance to disagree.
 *   FDA recalls press-release RSS — fetched here, best-effort (see "EARLY FDA
 *     ANNOUNCEMENTS" below). A failure is recorded, never fatal.
 *   openFDA food / drug / device enforcement — fetched here, nationwide, for
 *     the last LOOKBACK_DAYS by report_date, EVERY status. The per-state path
 *     asks for `status:"Ongoing"` because it answers "what is live near me";
 *     this answers "was it recalled", where Terminated is the answer rather
 *     than noise (see the note on /api/lookup in README.md).
 *
 * ── THE SAME RULE AS THE SNAPSHOTS: NEVER WRITE A COLLAPSED FEED ─────────
 * If openFDA fails, or answers with a fraction of what the committed index
 * already holds, its records are carried over from the previous index rather
 * than dropped, and `sources.fda.ok` is written as false. The client reads
 * that flag: an index search that finds no FDA record while FDA is marked
 * stale says "FDA not checked" and asks openFDA live, instead of implying
 * that nothing was found. An empty result has to say what was checked.
 *
 * ── SIZE ─────────────────────────────────────────────────────────────────
 * A year of openFDA is several thousand records, most of them long prose. The
 * budget is ~3 MB raw (a few hundred KB over the wire, gzipped by the CDN),
 * and it is met by trimming text, never by dropping records: the build
 * retries at progressively tighter text caps until it fits, and logs the size
 * it settled on. `distribution` is kept verbatim up to its cap because it is
 * the evidence a verdict quotes back to the reader.
 *
 * Usage:
 *   node scripts/build-index.mjs            fetch openFDA, fall back on failure
 *   node scripts/build-index.mjs --offline  snapshots only; FDA carried over
 *
 * Exit 1 only when the index could not be written at all, or (online) when
 * FDA was not refreshed — the file is still written in that case, so the
 * previous FDA records keep serving and the run goes red.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fsisStatus, fsisGeography, fmtFdaDate, LOOKBACK_DAYS, statesIn, fdaLastUpdated } from "../src/lib/sources.js";
import { categoryFor } from "../src/lib/category.js";
import { reasonFor } from "../src/lib/reason.js";
import { upcsIn } from "../src/lib/upc.js";
import { coverageFromText } from "../src/lib/search-index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FEED_DIR = resolve(ROOT, "public/feeds");
const OUT = resolve(FEED_DIR, "index.json");

const DAY_MS = 86400000;
const FDA_KINDS = ["food", "drug", "device"];
const FDA_LABEL = { food: "FDA Food", drug: "FDA Drug", device: "FDA Device" };
const FDA_URL = "https://www.accessdata.fda.gov/scripts/ires/index.cfm"; // FDA IRES recall search

/* openFDA's paging limits: 1000 per page, and skip may not pass 25000. A
 * window with more than that is split in half by date and each half fetched
 * on its own — a year of any one kind is nowhere near it today, but a limit
 * we would hit silently is worth one recursive call to rule out. */
const PAGE = 1000;
const SKIP_CAP = 25000;
const TIMEOUT_MS = 60000;
const ATTEMPTS = 3;
const GAP_MS = 4000;

/* FDA is healthy when it produces at least `floor` records, and has not
 * fallen below `collapse` of the FDA records already committed. A year of
 * enforcement reports across three centres is thousands of records; a few
 * hundred means something upstream changed shape. */
const FDA_HEALTH = { floor: 300, collapse: 0.5 };

const SIZE_BUDGET = 3 * 1024 * 1024;
/* Text caps, loosest first. `text` covers product and reason, `firm` the
 * company name, `dist` the verbatim distribution text. */
const CAP_TIERS = [
  { text: 320, firm: 120, dist: 400 },
  { text: 220, firm: 100, dist: 320 },
  { text: 160, firm: 80, dist: 240 },
  { text: 120, firm: 60, dist: 180 },
  { text: 90, firm: 50, dist: 140 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cap(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

function isoDay(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function list(v) {
  return (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String).filter(Boolean);
}

function severityFromFdaClass(cls) {
  if (/class i{3}/i.test(cls)) return "low";
  if (/class i{2}/i.test(cls)) return "med";
  if (/class i/i.test(cls)) return "high";
  return "med";
}

/* Fields every source fills the same way, applied last so the three mappers
 * below only decide what is genuinely source-specific. `upcs` is omitted when
 * empty: most notices carry none, and an empty array on thousands of records
 * is weight with no information in it. */
function finish(rec, upcText) {
  const { coverage, states } = coverageFromText(rec.distribution, rec.source);
  rec.states = states;
  rec.coverage = coverage;
  rec.category = categoryFor(rec).key;
  rec.reasonKey = reasonFor(rec).key;
  const upcs = upcsIn(upcText);
  if (upcs.length) rec.upcs = upcs;
  return rec;
}

// ------------------------------------------------------------ mappers
/* Ids match the ones the normalizers in src/lib/sources.js mint, so a record
 * found here and the same record in the area list are the same record — which
 * is what lets a share link (/r/:id) resolve from either side. */

/** One raw openFDA enforcement result -> index record. */
export function fdaToIndex(kind, r, caps = CAP_TIERS[0]) {
  const status = /ongoing|pending/i.test(r.status || "") ? "active" : "ended";
  const rec = {
    id: `fda-${kind}-${r.recall_number || r.event_id}`,
    source: FDA_LABEL[kind],
    product: cap(r.product_description || "(no product description)", caps.text),
    firm: cap(r.recalling_firm, caps.firm),
    reason: cap(r.reason_for_recall, caps.text),
    classification: r.classification || "",
    severity: severityFromFdaClass(r.classification || ""),
    date: isoDay(r.recall_initiation_date) || isoDay(r.report_date),
    status,
    distribution: cap(r.distribution_pattern, caps.dist),
    url: FDA_URL,
  };
  const end = isoDay(r.termination_date);
  if (status === "ended" && end) rec.endDate = end;
  /* The enforcement report's date: when FDA published the notice, usually
   * weeks after initiation — the day it is news (digest.js newsDay). Only
   * stored when it differs, to keep the index small. */
  const posted = isoDay(r.report_date);
  if (posted && posted !== rec.date) rec.posted = posted;
  /* Coverage is read from the FULL distribution text, not the capped copy:
   * a state named at character 500 is still a state the product went to. */
  const full = finish({ ...rec, distribution: r.distribution_pattern || "" },
    [r.code_info, r.product_description].filter(Boolean).join(" \n "));
  return { ...full, distribution: rec.distribution };
}

/** One slimmed FSIS snapshot notice (slimFsis shape) -> index record. */
export function fsisToIndex(r, caps = CAP_TIERS[0]) {
  const risk = String(r.field_risk_level || "");
  /* USDA's states field is read by the same function normalizeFsis uses,
   * so the index and the area list agree on what a notice covers: Census
   * regions ("Midwest") expand to their states with the verbatim word kept as
   * evidence, and an empty field is 'unstated' ("Region not stated"), not the
   * nationwide claim USDA never made. coverageFromText knows neither rule. */
  const geo = fsisGeography(r.field_states);
  const urlPath = String(r.field_recall_url || "");
  /* Only an explicit "False" can make an ended recall, and even that is not
   * believed for a young notice. The first index built from a real snapshot
   * had 51 of 54 USDA notices flagged "False" — including a Class I pork
   * recall issued three days earlier. Whatever `field_active_notice` tracks,
   * on fresh notices it is not the recall's lifecycle, and here the flag
   * becomes a verdict headline ("This recall has ended"), which is the one
   * wrong answer that tells someone to eat the sausage. So a closure is only
   * taken at its word once the notice is older than FSIS_TRUST_CLOSED_DAYS;
   * before that the record stays active. Wrong in that direction costs a
   * reader a check of their freezer. A notice with no flag at all is active,
   * as in normalizeFsis. (slimFsis does not keep USDA's closed-date field;
   * if it ever does, that should replace this age test.) */
  // The rule itself is fsisStatus in src/lib/sources.js, shared with
  // normalizeFsis so the area list and the index give one answer.
  const ended = fsisStatus(r.field_active_notice, r.field_recall_date) === "ended";
  const rec = {
    id: `fsis-${r.field_recall_number || urlPath}`,
    source: "USDA FSIS",
    product: cap(r.field_title || r.field_product_items || "(untitled FSIS recall)", caps.text),
    firm: cap(r.field_establishment, caps.firm),
    reason: cap([list(r.field_recall_reason).join(", "), r.field_recall_classification].filter(Boolean).join(" — "), caps.text),
    classification: risk || r.field_recall_classification || "",
    severity: /high/i.test(risk) ? "high" : /low|marginal/i.test(risk) ? "low" : "med",
    date: isoDay(r.field_recall_date),
    status: ended ? "ended" : "active",
    distribution: cap(geo.text, caps.dist),
    url: urlPath
      ? (urlPath.startsWith("http") ? urlPath : "https://www.fsis.usda.gov" + urlPath)
      : "https://www.fsis.usda.gov/recalls",
  };
  finish(rec, [r.field_title, r.field_product_items, r.field_summary].filter(Boolean).join(" \n "));
  // FSIS's states field is the whole statement; take coverage from it, uncapped.
  rec.states = geo.states;
  rec.coverage = geo.kind;
  return rec;
}

/** One slimmed CPSC snapshot notice (slimCpsc shape) -> index record.
 *  CPSC recalls do not end the way FDA's do — there is no termination field —
 *  so every one is active, as the area list already treats them. */
export function cpscToIndex(r, caps = CAP_TIERS[0]) {
  const products = (r.Products || []).map((p) => p.Name).filter(Boolean);
  const hazards = (r.Hazards || []).map((h) => h.Name).filter(Boolean);
  const retailers = (r.Retailers || []).map((x) => (x && x.Name) || "").filter(Boolean).join(", ");
  const rec = {
    id: `cpsc-${r.RecallID || r.RecallNumber}`,
    source: "CPSC",
    product: cap(r.Title || products.join("; ") || "(untitled CPSC recall)", caps.text),
    firm: cap((r.Manufacturers || []).map((m) => m.Name).filter(Boolean).join(", "), caps.firm),
    reason: cap(hazards.join("; ") || r.Description, caps.text),
    classification: "",
    severity: "med", // CPSC does not classify
    date: isoDay(r.RecallDate),
    status: "active",
    distribution: cap([retailers, r.SoldAtLabel].filter(Boolean).join(" · ") || "Nationwide (consumer product)", caps.dist),
    url: r.URL || "https://www.cpsc.gov/Recalls",
  };
  return finish(rec, [r.Title, products.join(" "), r.Description].filter(Boolean).join(" \n "));
}

// ------------------------------------------------------------ openFDA
async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (res.status === 404) return { meta: { results: { total: 0 } }, results: [] }; // openFDA's "no matches"
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.replace(/\s+/g, " ").slice(0, 160)}`);
    return JSON.parse(text);
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error(`timed out after ${TIMEOUT_MS}ms`) : err;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries(label, load) {
  let last;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      return await load();
    } catch (err) {
      last = err;
      console.log(`  ${label}: attempt ${i}/${ATTEMPTS} failed — ${err.message}`);
      if (i < ATTEMPTS) await sleep(GAP_MS);
    }
  }
  throw last;
}

function fdaUrl(kind, from, to, skip) {
  // The key is optional: without it openFDA allows 1000 requests a day per
  // IP, which a run of this script (a dozen pages) is nowhere near.
  const key = process.env.OPENFDA_KEY || process.env.openfda || "";
  return `https://api.fda.gov/${kind}/enforcement.json` +
    `?search=report_date:[${fmtFdaDate(from)}+TO+${fmtFdaDate(to)}]` +
    `&sort=report_date:desc&limit=${PAGE}&skip=${skip}` +
    (key ? `&api_key=${encodeURIComponent(key)}` : "");
}

/* `meta` collects openFDA's meta.last_updated (newest seen) for the caller. */
async function fetchFdaWindow(kind, from, to, meta = {}) {
  const first = await withRetries(`fda ${kind}`, () => fetchJson(fdaUrl(kind, from, to, 0)));
  const updated = fdaLastUpdated(first);
  if (updated && !(meta.lastUpdated >= updated)) meta.lastUpdated = updated;
  const total = (first.meta && first.meta.results && first.meta.results.total) || 0;
  if (total > SKIP_CAP + PAGE) {
    const mid = new Date(from.getTime() + Math.floor((to.getTime() - from.getTime()) / 2 / DAY_MS) * DAY_MS);
    if (mid <= from) throw new Error(`more than ${SKIP_CAP + PAGE} ${kind} records in one day`);
    console.log(`  fda ${kind}: ${total} records in window, splitting at ${fmtFdaDate(mid)}`);
    const next = new Date(mid.getTime() + DAY_MS);
    return [...await fetchFdaWindow(kind, from, mid, meta), ...await fetchFdaWindow(kind, next, to, meta)];
  }
  const out = [...(first.results || [])];
  for (let skip = PAGE; skip < total && skip <= SKIP_CAP; skip += PAGE) {
    const page = await withRetries(`fda ${kind} skip=${skip}`, () => fetchJson(fdaUrl(kind, from, to, skip)));
    out.push(...(page.results || []));
    if (!(page.results || []).length) break;
  }
  if (out.length < total) throw new Error(`paged ${out.length} of ${total} ${kind} records`);
  return out;
}

// ------------------------------------------------------------ FDA announcements
/* ── EARLY FDA ANNOUNCEMENTS ──────────────────────────────────────────────
 * A company's recall press release is posted to FDA's recalls RSS feed the
 * day it is issued; the openFDA enforcement record — classification,
 * distribution list — follows weeks later. For the weeks in between the
 * recall is in the news and absent from openFDA, which is exactly when
 * people search for it. So the feed's last ANNOUNCE_DAYS of items go into the
 * index as their own records:
 *
 *   source 'FDA announcement', status 'announced' (not 'active': nothing has
 *   been classified), announcement: true, classification "Not yet
 *   classified", url = the press release.
 *
 * Geography is read only from sentences about distribution ("distributed
 * in…", "sold at… in…"), and only from the words after that verb, because a
 * release's first sentence names the firm's home town — "Acme, of Brooklyn,
 * New York, is recalling…" — which is not where the product went. Nothing
 * found is coverage 'unstated', and verdict.js answers that with ANNOUNCED
 * and keeps it out of area counts.
 *
 * Once openFDA has the recall, the announcement is redundant: it is dropped
 * when an FDA enforcement record from the same firm (normalized name tokens)
 * is dated within ANNOUNCE_DEDUPE_DAYS of it.
 *
 * Best-effort throughout: a failed or malformed feed is recorded in
 * sources.fdaAnnouncements and never fails the run; the previous index's
 * announcements (still inside the window) are carried over instead.
 * ───────────────────────────────────────────────────────────────────────── */
export const FDA_RSS_URL = "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml";
export const ANNOUNCE_SOURCE = "FDA announcement";
const ANNOUNCE_DAYS = 60;
const ANNOUNCE_DEDUPE_DAYS = 45;

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018",
  rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  reg: "\u00ae", trade: "\u2122", copy: "\u00a9", eacute: "\u00e9", ntilde: "\u00f1",
};

export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v == null ? m : v;
  });
}

/* One element's text: CDATA sections verbatim, everything else entity-
 * decoded (the XML layer); then any HTML inside is stripped and its own
 * entities decoded (the HTML layer). */
function xmlText(raw) {
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = re.lastIndex;
  }
  out += decodeEntities(raw.slice(last));
  return decodeEntities(out
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ") // their text is code, not prose
    .replace(/<\/?(?:br|p|div|li|ul|ol|h\d|tr|td|table)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? xmlText(m[1]) : "";
}

/* The press release link becomes an href in the app and a meta refresh in
 * share pages: only http(s), and re-serialized by the URL parser so stray
 * quotes, spaces and angle brackets come out percent-encoded. */
function safeHttpUrl(v) {
  try {
    const u = new URL(String(v || "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch (_) {
    return "";
  }
}

/** Parse RSS 2.0 items — a deliberately small, dependency-free reader for
 *  one known feed: <item> blocks with title, link, pubDate (or dc:date) and
 *  description; CDATA and entities handled. Items without a title or link
 *  are skipped. `pubDate` comes back as an ISO day, or null. */
export function parseRss(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const block = m[1];
    const title = tag(block, "title");
    const link = safeHttpUrl(tag(block, "link") || tag(block, "guid"));
    if (!title || !link) continue;
    const when = tag(block, "pubDate") || tag(block, "dc:date");
    items.push({ title, link, pubDate: announceDay(when), description: tag(block, "description") });
  }
  return items;
}

function announceDay(v) {
  if (!v) return null;
  let t = Date.parse(v);
  // Some zone names are not understood everywhere; the day is what matters.
  if (!Number.isFinite(t)) t = Date.parse(String(v).replace(/\s+[A-Z]{2,5}$/, " GMT"));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const FIRM_STOP = new Set(("inc incorporated llc l l c ltd limited co corp corporation company companies " +
  "the and of dba foods food products product brands brand group holdings usa us america american " +
  "international enterprises cooperative coop co-op association").split(" "));

/** Distinctive lower-case tokens of a firm name, for matching an
 *  announcement to its enforcement record. */
export function firmTokens(name) {
  return [...new Set(String(name || "").toLowerCase().replace(/&/g, " ").split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FIRM_STOP.has(w)))];
}

/** Same firm: at least 75% of the shorter name's tokens appear in the longer
 *  one ("United Sugar Producers & Refiners" ~ "... Refiners Cooperative"),
 *  so one shared generic-ish word ("United") is not enough — and neither is
 *  a shared place name: "Hudson Valley Greens" is not "Hudson Valley
 *  Creamery" (2 of 3). A false match here HIDES a recall (the announcement
 *  is dropped as a duplicate), so the rule errs towards keeping both. */
export function sameFirm(a, b) {
  const A = firmTokens(a);
  const B = firmTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  const shared = short.filter((w) => long.has(w)).length;
  return shared > 0 && shared / short.length >= 0.75;
}

const VERB_RE = /\s+(?:issues?|announces?|initiates?|expands?|extends?|is\s+(?:voluntarily\s+)?recalling|voluntarily\s+recalls?|recalls?)\b/i;

function firmFromAnnouncement(title, description) {
  const clean = (f) => f.replace(/,\s*(?:of|in|based in|located in|headquartered in)\s.*$/i, "").replace(/[,.\s]+$/, "").trim();
  const t = title.match(new RegExp(`^(.{2,90}?)${VERB_RE.source}`, "i"));
  if (t) return clean(t[1]);
  const d = description.match(/^(.{2,120}?)\s+(?:is\s+(?:voluntarily\s+)?recalling|(?:has\s+)?(?:voluntarily\s+)?(?:announced|issued|initiated|recalled|recalls))\b/i);
  return d ? clean(d[1]) : "";
}

const DIST_RE = /\b(?:distributed|distribution|sold|shipped|available for (?:purchase|sale))\b/i;
const ANNOUNCE_NATIONWIDE_RE = /\bnation\s?wide\b|\b(?:throughout|across) the (?:u\.?s\.?|united states)\b|\ball 50 states\b/i;

/** Where a release says the product went: coverage from distribution
 *  sentences only (see the section note). */
export function announcementGeography(description) {
  const sentences = String(description || "").split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((x) => DIST_RE.test(x));
  const tails = hits.map((x) => x.slice(x.search(DIST_RE))).join(" ");
  if (ANNOUNCE_NATIONWIDE_RE.test(tails)) return { coverage: "nationwide", states: [], text: hits.join(" ") };
  const states = statesIn(tails);
  return states.length ? { coverage: "states", states, text: hits.join(" ") } : { coverage: "unstated", states: [], text: "" };
}

/* categoryFor keys off the source, so guess which FDA centre a release
 * belongs to from its own words; food is the default, as it is most of them. */
function guessFdaSource(text) {
  if (/\b(?:tablets?|capsules?|injection|injectable|drug|medication|pharmac\w*|ophthalmic|eye drops?|oral solution|\d+\s?mg)\b/i.test(text)) return "FDA Drug";
  if (/\b(?:device|catheter|infusion pump|syringes?|implant\w*|test kits?|monitor|ventilator|glucose meter)\b/i.test(text)) return "FDA Device";
  return "FDA Food";
}

function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** One parsed RSS item -> index record. */
export function announcementToIndex(item, caps = CAP_TIERS[0]) {
  const title = item.title;
  const description = item.description || "";
  const geo = announcementGeography(description);
  const reasonInTitle = (title.match(/\b(?:because of|due to|for)\s+(?:possible\s+|potential\s+)?(.{4,})$/i) || [])[1] || "";
  const rec = {
    id: `fda-ann-${shortHash(item.link)}`,
    source: ANNOUNCE_SOURCE,
    product: cap(title, caps.text),
    firm: cap(firmFromAnnouncement(title, description), caps.firm),
    // "Because of Possible Health Risk" says nothing; the release body does.
    reason: cap(reasonInTitle && !/^health (?:risk|hazard)/i.test(reasonInTitle) ? reasonInTitle : description, caps.text),
    classification: "Not yet classified",
    severity: "med",
    date: item.pubDate,
    status: "announced",
    announcement: true,
    distribution: cap(geo.text, caps.dist),
    states: geo.states,
    coverage: geo.coverage,
    url: item.link,
  };
  const guessed = { ...rec, source: guessFdaSource(`${title} ${description}`) };
  rec.category = categoryFor(guessed).key;
  rec.reasonKey = reasonFor({ reason: `${title} ${description}`, classification: "" }).key;
  const upcs = upcsIn(description);
  if (upcs.length) rec.upcs = upcs;
  return rec;
}

/** Drop announcements openFDA already covers: same firm, enforcement record
 *  dated within ANNOUNCE_DEDUPE_DAYS. Returns { kept, dropped }. */
export function dropAnnouncedDuplicates(announcements, fdaRecords) {
  const kept = [];
  const dropped = [];
  for (const a of announcements) {
    const t = Date.parse(a.date);
    const dup = a.firm && Number.isFinite(t) && fdaRecords.some((r) => {
      const d = Date.parse(r.date);
      return Number.isFinite(d) && Math.abs(d - t) <= ANNOUNCE_DEDUPE_DAYS * DAY_MS && sameFirm(a.firm, r.firm);
    });
    (dup ? dropped : kept).push(a);
  }
  return { kept, dropped };
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "Mozilla/5.0 (compatible; YankedRecallIndex/1.0)" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out after 30000ms") : err;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ build
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (_) {
    return null;
  }
}

function dedupe(records) {
  const seen = new Set();
  return records.filter((r) => {
    if (!r.id || !r.date || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/**
 * Build the index. Returns
 *   { index, changed, bytes, fdaOk, problems }
 * and writes public/feeds/index.json unless nothing but timestamps changed.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.offline]   skip openFDA; carry the previous FDA records
 * @param {object}   [opts.fdaRaw]    { food: [...], drug: [...], device: [...] }
 *                                    raw openFDA results to use instead of
 *                                    fetching (fixtures)
 *                                    Each kind may also be a whole openFDA
 *                                    response ({ meta, results }), so
 *                                    meta.last_updated is exercised too.
 * @param {string}   [opts.fdaRss]    FDA recalls RSS XML to use instead of
 *                                    fetching (fixtures)
 * @param {Date}     [opts.now]       build time (fixtures)
 * @param {boolean}  [opts.write=true]
 * @param {string}   [opts.out]       output path (default public/feeds/index.json)
 */
export async function buildIndex({ offline = false, fdaRaw = null, fdaRss = null, now = new Date(), write = true, out = OUT } = {}) {
  const from = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const cutoff = from.toISOString().slice(0, 10);
  const problems = [];

  const prev = await readJson(out);
  const prevRecalls = (prev && Array.isArray(prev.recalls)) ? prev.recalls : [];
  const prevFda = prevRecalls.filter((r) => String(r.source).startsWith("FDA") && r.source !== ANNOUNCE_SOURCE && String(r.date) >= cutoff);

  // ── snapshots
  const fsisSnap = await readJson(resolve(FEED_DIR, "fsis.json"));
  const cpscSnap = await readJson(resolve(FEED_DIR, "cpsc.json"));
  const fsisList = (fsisSnap && Array.isArray(fsisSnap.notices)) ? fsisSnap.notices : [];
  const cpscList = (cpscSnap && Array.isArray(cpscSnap.notices)) ? cpscSnap.notices : [];
  if (!fsisList.length) problems.push("USDA FSIS snapshot missing or empty");
  if (!cpscList.length) problems.push("CPSC snapshot missing or empty");

  // ── openFDA: raw results per kind, or null when that kind must be carried over
  const raw = {};
  const kinds = {};
  const updated = {}; // kind -> openFDA meta.last_updated
  for (const kind of FDA_KINDS) {
    if (fdaRaw) {
      const given = fdaRaw[kind] || [];
      raw[kind] = Array.isArray(given) ? given : (given.results || []);
      if (!Array.isArray(given)) updated[kind] = fdaLastUpdated(given);
    } else if (offline) {
      raw[kind] = null;
      kinds[kind] = { ok: false, error: "offline build" };
      continue;
    } else {
      try {
        console.log(`fda ${kind}:`);
        const meta = {};
        raw[kind] = await fetchFdaWindow(kind, from, now, meta);
        updated[kind] = meta.lastUpdated || null;
        console.log(`  fda ${kind}: ${raw[kind].length} records`);
      } catch (err) {
        raw[kind] = null;
        kinds[kind] = { ok: false, error: String((err && err.message) || err) };
        console.log(`  fda ${kind}: FAILED — ${kinds[kind].error}`);
        continue;
      }
    }
    kinds[kind] = { ok: true, count: raw[kind].length };
  }

  // ── FDA announcements (RSS): best-effort, never fails the run
  const prevAnn = prevRecalls.filter((r) => r.source === ANNOUNCE_SOURCE);
  const annSince = new Date(now.getTime() - ANNOUNCE_DAYS * DAY_MS).toISOString().slice(0, 10);
  let annItems = null;
  let annError = null;
  if (fdaRss != null) {
    annItems = parseRss(fdaRss);
  } else if (offline) {
    annError = "not fetched (offline build)";
  } else {
    try {
      annItems = parseRss(await fetchText(FDA_RSS_URL));
      if (!annItems.length) throw new Error("feed parsed to zero items");
    } catch (err) {
      annItems = null;
      annError = String((err && err.message) || err);
      console.log(`  fda announcements: FAILED — ${annError} (carrying over the previous ones)`);
    }
  }
  const annRecent = annItems ? annItems.filter((it) => it.pubDate && it.pubDate >= annSince) : null;

  /* Health: judged across all three kinds together, against the committed
   * copy. A refresh that fetched fine but shrank to a fraction is refused
   * exactly as a failed fetch is — its records are replaced by the previous
   * ones — because "openFDA answered" and "openFDA answered correctly" are
   * different claims. Fixture builds skip this; they are small on purpose. */
  const fetchedCount = FDA_KINDS.reduce((n, k) => n + (raw[k] ? raw[k].length : 0), 0);
  let fdaOk = FDA_KINDS.every((k) => kinds[k].ok);
  if (fdaOk && !fdaRaw) {
    if (fetchedCount < FDA_HEALTH.floor) {
      problems.push(`openFDA returned only ${fetchedCount} records, below the floor of ${FDA_HEALTH.floor}`);
      fdaOk = false;
    } else if (prevFda.length >= FDA_HEALTH.floor && fetchedCount < prevFda.length * FDA_HEALTH.collapse) {
      problems.push(`openFDA collapsed from ${prevFda.length} committed records to ${fetchedCount}`);
      fdaOk = false;
    }
    if (!fdaOk) for (const k of FDA_KINDS) raw[k] = null;
  }
  for (const k of FDA_KINDS) {
    if (!kinds[k].ok && !offline) problems.push(`openFDA ${k}: ${kinds[k].error}`);
  }

  const prevSrc = (prev && prev.sources) || {};
  const fdaFetchedAt = fdaOk
    ? now.toISOString()
    : (prevSrc.fda && prevSrc.fda.fetchedAt) || null;
  /* openFDA's own "data as of" date, per kind; carried with the records when
   * they are carried. The headline value is the newest across kinds. */
  const prevByKind = (prevSrc.fda && prevSrc.fda.lastUpdatedByKind) || {};
  const lastUpdatedByKind = {};
  for (const k of FDA_KINDS) {
    const v = raw[k] ? updated[k] : prevByKind[k];
    if (v) lastUpdatedByKind[k] = v;
  }
  const fdaLastUpdatedAll = Object.values(lastUpdatedByKind).sort().pop() || null;

  // ── assemble at the loosest caps that fit the budget
  let recalls, body, tier, annDedupe;
  for (tier of CAP_TIERS) {
    const fda = [];
    for (const kind of FDA_KINDS) {
      if (raw[kind]) fda.push(...raw[kind].map((r) => fdaToIndex(kind, r, tier)));
      /* Carried over as they were written — possibly at a tighter cap than
       * this tier, which is fine: they are stale either way, and flagged. */
      else fda.push(...prevFda.filter((r) => r.source === FDA_LABEL[kind]));
    }
    const ann = annRecent
      ? annRecent.map((it) => announcementToIndex(it, tier))
      : prevAnn.filter((r) => String(r.date) >= annSince);
    annDedupe = dropAnnouncedDuplicates(ann, fda);
    recalls = dedupe([
      ...fsisList.map((r) => fsisToIndex(r, tier)),
      ...cpscList.map((r) => cpscToIndex(r, tier)),
      ...fda,
      ...annDedupe.kept,
    ]).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.id.localeCompare(b.id));
    body = JSON.stringify(recalls);
    if (body.length <= SIZE_BUDGET) break;
    console.log(`  index: ${(body.length / 1048576).toFixed(2)} MB at text cap ${tier.text} — over budget, trimming`);
  }
  if (body.length > SIZE_BUDGET) {
    problems.push(`index is ${(body.length / 1048576).toFixed(2)} MB even at the tightest caps`);
  }

  const count = (pred) => recalls.filter(pred).length;
  const newest = (pred) => recalls.filter(pred).reduce((m, r) => (String(r.date) > m ? String(r.date) : m), "") || null;
  const isFda = (r) => String(r.source).startsWith("FDA") && r.source !== ANNOUNCE_SOURCE;
  const fdaCount = count(isFda);
  const index = {
    builtAt: now.toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    sources: {
      /* Every source: ok, count, fetchedAt (when we fetched it) and newest
       * (its newest recall date in this index). FDA adds lastUpdated —
       * openFDA's meta.last_updated, the data's own date — overall and per
       * kind. freshnessOf in src/lib/search-index.js reads these. */
      fda: {
        ok: fdaOk,
        count: fdaCount,
        fetchedAt: fdaFetchedAt,
        lastUpdated: fdaLastUpdatedAll,
        lastUpdatedByKind,
        newest: newest(isFda),
        ...(fdaOk ? null : { note: offline ? "not fetched (offline build); records carried over from the previous index" : "openFDA refresh failed; records carried over from the previous index" }),
      },
      fsis: { ok: fsisList.length > 0, count: count((r) => r.source === "USDA FSIS"), fetchedAt: (fsisSnap && fsisSnap.fetchedAt) || null, newest: newest((r) => r.source === "USDA FSIS") },
      cpsc: { ok: cpscList.length > 0, count: count((r) => r.source === "CPSC"), fetchedAt: (cpscSnap && cpscSnap.fetchedAt) || null, newest: newest((r) => r.source === "CPSC") },
      fdaAnnouncements: {
        ok: !!annItems,
        count: count((r) => r.source === ANNOUNCE_SOURCE),
        fetchedAt: annItems ? now.toISOString() : (prevSrc.fdaAnnouncements && prevSrc.fdaAnnouncements.fetchedAt) || null,
        newest: newest((r) => r.source === ANNOUNCE_SOURCE),
        droppedAsDuplicates: annDedupe.dropped.length,
        ...(annError ? { note: `${annError}; announcements carried over from the previous index` } : null),
      },
    },
    count: recalls.length,
    recalls,
  };

  /* Only rewrite when the content moved. `builtAt` changes on every run, so
   * stamping it unconditionally would commit an identical index four times a
   * day forever — the same reasoning as write() in refresh-feeds.mjs. */
  const okSig = (s) => JSON.stringify(Object.fromEntries(Object.entries(s || {}).map(([k, v]) => [k, !!(v && v.ok)])));
  const changed = !prev || JSON.stringify(prev.recalls) !== body || okSig(prev.sources) !== okSig(index.sources);
  const text = JSON.stringify(index) + "\n";
  if (write && changed) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
  }

  console.log(
    `index: ${recalls.length} recalls (FDA ${fdaCount}${fdaOk ? "" : " carried over"}, ` +
    `FSIS ${index.sources.fsis.count}, CPSC ${index.sources.cpsc.count}, ` +
    `announcements ${index.sources.fdaAnnouncements.count}${annItems ? "" : " carried over"}), ` +
    `${(text.length / 1048576).toFixed(2)} MB at text cap ${tier.text}` +
    `${write ? (changed ? " — written" : " — unchanged, not rewriting") : " — dry run"}`);

  return { index, changed, bytes: text.length, fdaOk, problems };
}

// ------------------------------------------------------------ CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offline = process.argv.includes("--offline");
  try {
    const { fdaOk, problems } = await buildIndex({ offline });
    for (const p of problems) console.log(`  problem: ${p}`);
    process.exit(!offline && !fdaOk ? 1 : 0);
  } catch (err) {
    console.error(`index: FAILED — ${(err && err.stack) || err}`);
    process.exit(1);
  }
}
