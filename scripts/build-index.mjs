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

import { fsisStatus, fsisGeography, fmtFdaDate, LOOKBACK_DAYS } from "../src/lib/sources.js";
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

async function fetchFdaWindow(kind, from, to) {
  const first = await withRetries(`fda ${kind}`, () => fetchJson(fdaUrl(kind, from, to, 0)));
  const total = (first.meta && first.meta.results && first.meta.results.total) || 0;
  if (total > SKIP_CAP + PAGE) {
    const mid = new Date(from.getTime() + Math.floor((to.getTime() - from.getTime()) / 2 / DAY_MS) * DAY_MS);
    if (mid <= from) throw new Error(`more than ${SKIP_CAP + PAGE} ${kind} records in one day`);
    console.log(`  fda ${kind}: ${total} records in window, splitting at ${fmtFdaDate(mid)}`);
    const next = new Date(mid.getTime() + DAY_MS);
    return [...await fetchFdaWindow(kind, from, mid), ...await fetchFdaWindow(kind, next, to)];
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
 * @param {boolean}  [opts.write=true]
 * @param {string}   [opts.out]       output path (default public/feeds/index.json)
 */
export async function buildIndex({ offline = false, fdaRaw = null, write = true, out = OUT } = {}) {
  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const cutoff = from.toISOString().slice(0, 10);
  const problems = [];

  const prev = await readJson(out);
  const prevRecalls = (prev && Array.isArray(prev.recalls)) ? prev.recalls : [];
  const prevFda = prevRecalls.filter((r) => String(r.source).startsWith("FDA") && String(r.date) >= cutoff);

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
  for (const kind of FDA_KINDS) {
    if (fdaRaw) {
      raw[kind] = fdaRaw[kind] || [];
    } else if (offline) {
      raw[kind] = null;
      kinds[kind] = { ok: false, error: "offline build" };
      continue;
    } else {
      try {
        console.log(`fda ${kind}:`);
        raw[kind] = await fetchFdaWindow(kind, from, now);
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

  const fdaFetchedAt = fdaOk
    ? now.toISOString()
    : (prev && prev.sources && prev.sources.fda && prev.sources.fda.fetchedAt) || null;

  // ── assemble at the loosest caps that fit the budget
  let recalls, body, tier;
  for (tier of CAP_TIERS) {
    const fda = [];
    for (const kind of FDA_KINDS) {
      if (raw[kind]) fda.push(...raw[kind].map((r) => fdaToIndex(kind, r, tier)));
      /* Carried over as they were written — possibly at a tighter cap than
       * this tier, which is fine: they are stale either way, and flagged. */
      else fda.push(...prevFda.filter((r) => r.source === FDA_LABEL[kind]));
    }
    recalls = dedupe([
      ...fsisList.map((r) => fsisToIndex(r, tier)),
      ...cpscList.map((r) => cpscToIndex(r, tier)),
      ...fda,
    ]).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.id.localeCompare(b.id));
    body = JSON.stringify(recalls);
    if (body.length <= SIZE_BUDGET) break;
    console.log(`  index: ${(body.length / 1048576).toFixed(2)} MB at text cap ${tier.text} — over budget, trimming`);
  }
  if (body.length > SIZE_BUDGET) {
    problems.push(`index is ${(body.length / 1048576).toFixed(2)} MB even at the tightest caps`);
  }

  const count = (pred) => recalls.filter(pred).length;
  const fdaCount = count((r) => String(r.source).startsWith("FDA"));
  const index = {
    builtAt: now.toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    sources: {
      fda: {
        ok: fdaOk,
        count: fdaCount,
        fetchedAt: fdaFetchedAt,
        ...(fdaOk ? null : { note: offline ? "not fetched (offline build); records carried over from the previous index" : "openFDA refresh failed; records carried over from the previous index" }),
      },
      fsis: { ok: fsisList.length > 0, count: count((r) => r.source === "USDA FSIS"), fetchedAt: (fsisSnap && fsisSnap.fetchedAt) || null },
      cpsc: { ok: cpscList.length > 0, count: count((r) => r.source === "CPSC"), fetchedAt: (cpscSnap && cpscSnap.fetchedAt) || null },
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
    `FSIS ${index.sources.fsis.count}, CPSC ${index.sources.cpsc.count}), ` +
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
