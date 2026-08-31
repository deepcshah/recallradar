/* Fetch the government recall feeds and write them into public/feeds/.
 *
 * This runs on a GitHub Actions runner, not on Vercel. Every other path to
 * USDA in this app leaves from the same place — a Vercel serverless function —
 * so they all fail together for whatever reason that one caller is refused.
 * A runner is a different network with a different address, and it is Node,
 * which USDA demonstrably accepts where curl is refused.
 *
 * The output is committed to the repository, which is what makes it the tier
 * that cannot fail: it ships with the deployment as a static asset. Since the
 * snapshot tier was added to src/lib/feed-cache.js, the *server* reads it too,
 * so what this job fetches now answers /api/recalls as well as the browser.
 * That is the whole point of the job — data pulled where USDA will talk to us,
 * usable everywhere the app runs.
 *
 * ── WHY THIS FILE GREW A HEALTH CHECK ────────────────────────────────────
 * The first real run was green and produced a snapshot holding ONE recall:
 * 1.5 KB of USDA next to 393 KB of CPSC. Nothing had failed. USDA answered
 * 200 on the "product" rung, the fetch worked, the commit worked, the job went
 * green — and the feed was empty in every way that matters to a reader.
 *
 * Two things were wrong, and only one of them was the filter (see slimFsis).
 * The other was this script: it exited 0 if *either* feed was written, so a
 * total USDA failure was green as long as CPSC turned up, and it had no
 * opinion whatsoever about how much data arrived. A job that cannot go red
 * when the data is wrong is not a monitor, it is a cron with a log file.
 *
 * So every feed is now required, every feed has a floor, and a feed that
 * collapses against the copy already committed is refused rather than written
 * over the top of a good one. The previous snapshot keeps serving and the run
 * goes red, which is the signal worth having.
 *
 * Usage:  node scripts/refresh-feeds.mjs
 * Exit 0 only when every feed fetched, passed its checks, and is on disk.
 */
import { writeFile, mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { slimFsis, slimCpsc, fsisIsActive, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";
import { FEED_HEADERS, FSIS_ENDPOINTS, FSIS_HEADER_SETS, cpscUrl, fetchFirstOk } from "../src/lib/feeds.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "public/feeds");
const REPORT_DIR = resolve(ROOT, ".feed-report");

/* Generous by the standards of a serverless function, trivial for a runner
 * with nobody waiting on it. */
const TIMEOUT_MS = 60000;
const ATTEMPTS = 3;
const GAP_MS = 5000;

/* How far a feed may fall before the run is a failure rather than a refresh.
 *
 * `floor` is the absolute minimum a healthy feed can plausibly produce. USDA
 * publishes dozens of meat and poultry recalls a year and slimFsis keeps two
 * years of them, so five is not a target, it is a smoke alarm: below it,
 * something upstream has changed shape. `collapse` is the same question asked
 * relatively — a feed that drops to a fifth of the copy already committed has
 * not had a quiet week, it has broken. */
const HEALTH = {
  fsis: { floor: 5, collapse: 0.2 },
  cpsc: { floor: 20, collapse: 0.2 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

async function fetchJson(url, headers = FEED_HEADERS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`);
    }
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

/** The snapshot already committed, so a new one can be compared to it. */
async function previous(name) {
  try {
    const prev = JSON.parse(await readFile(resolve(OUT_DIR, `${name}.json`), "utf8"));
    return Array.isArray(prev.notices) ? prev : null;
  } catch (_) {
    return null; // first run, or an unreadable previous file
  }
}

/* What the raw USDA payload actually looks like, recorded on every run.
 *
 * This exists because the one-notice snapshot could not be diagnosed from the
 * log: "wrote 1 notices" is equally consistent with "USDA has one active
 * recall" and "the field we filter on stopped saying what it used to", and
 * those want opposite fixes. Guessing between them is how you ship the wrong
 * one. So the shape of the upstream response is written out as an artifact —
 * the distribution of the flag, the spread of years, the key list — and the
 * next run answers the question instead of raising it again. */
function describeFsis(raw) {
  const all = Array.isArray(raw) ? raw : (raw && raw.results) || [];
  const flag = {};
  const byYear = {};
  for (const r of all) {
    const v = r.field_active_notice === undefined ? "(absent)" : JSON.stringify(r.field_active_notice);
    flag[v] = (flag[v] || 0) + 1;
    const y = String(r.field_recall_date || "").slice(0, 4) || "(no date)";
    byYear[y] = (byYear[y] || 0) + 1;
  }
  const dates = all.map((r) => r.field_recall_date).filter(Boolean).sort();
  return {
    rawCount: all.length,
    keys: Object.keys(all[0] || {}),
    fieldActiveNoticeValues: flag,
    activeByOurTest: all.filter((r) => fsisIsActive(r.field_active_notice)).length,
    recallsByYear: byYear,
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
  };
}

function describeCpsc(raw) {
  const all = Array.isArray(raw) ? raw : [];
  const dates = all.map((r) => r.RecallDate).filter(Boolean).sort();
  return {
    rawCount: all.length,
    keys: Object.keys(all[0] || {}),
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
  };
}

const FEEDS = [
  {
    name: "fsis",
    label: "USDA FSIS",
    /* Walk the same identity ladder the app does: the crawler-shaped
     * User-Agent this project used to send is refused, and a bare product
     * token is not. Running the ladder here too means the runner and the
     * request path measure the same thing rather than diverging quietly. */
    load: async () => {
      const { data, headers } = await withRetries("fsis", () =>
        fetchFirstOk(FSIS_ENDPOINTS, FSIS_HEADER_SETS, TIMEOUT_MS, TIMEOUT_MS * 3));
      console.log(`  fsis: answered the "${headers}" rung`);
      return { raw: data, notices: slimFsis(data), shape: { rung: headers, ...describeFsis(data) } };
    },
  },
  {
    name: "cpsc",
    label: "CPSC",
    load: async () => {
      const raw = await withRetries("cpsc", () => fetchJson(cpscUrl(CPSC_LOOKBACK_DAYS)));
      return { raw, notices: slimCpsc(raw), shape: describeCpsc(raw) };
    },
  },
];

/** Is this result fit to replace what is already committed?
 *  @returns {string[]} the reasons it is not; empty means healthy.
 */
function healthProblems(name, notices, shape, prev) {
  const { floor, collapse } = HEALTH[name];
  const problems = [];

  if (!Array.isArray(notices) || !notices.length) {
    problems.push("upstream returned no notices at all");
    return problems; // everything below is noise once this is true
  }
  if (notices.length < floor) {
    problems.push(`only ${notices.length} notices, below the floor of ${floor}`);
  }
  if (prev && prev.count >= floor && notices.length < prev.count * collapse) {
    problems.push(
      `collapsed from ${prev.count} committed notices to ${notices.length} ` +
      `(${pct(notices.length, prev.count)}% of the copy already on disk)`);
  }
  /* A raw feed in the hundreds slimming down to a handful is the exact shape
   * of the bug that produced the one-notice snapshot: the fetch is fine and
   * the filter has stopped matching. */
  if (shape.rawCount > 50 && notices.length < shape.rawCount * 0.02) {
    problems.push(
      `the slimming filter kept ${notices.length} of ${shape.rawCount} raw records ` +
      `(${pct(notices.length, shape.rawCount)}%) — check whether the upstream fields it ` +
      `reads still have the shape they used to`);
  }
  return problems;
}

/** Only rewrite when the notices actually changed. `fetchedAt` moves on every
 *  run, so stamping it unconditionally would commit a new copy of an unchanged
 *  file several times a day, forever. */
async function write(name, notices, shape, prev) {
  const body = JSON.stringify(notices);
  if (prev && JSON.stringify(prev.notices) === body) return false;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, `${name}.json`),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      count: notices.length,
      rawCount: shape.rawCount ?? null, // so the ratio is auditable after the fact
      notices,
    }, null, 0) + "\n");
  return true;
}

async function report(results) {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(resolve(REPORT_DIR, "report.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + "\n");

  const rows = results.map((r) => {
    const state = !r.ok ? "❌ failed" : r.problems.length ? "❌ unhealthy" : r.changed ? "✅ updated" : "✅ unchanged";
    const kept = r.ok ? `${r.count} of ${r.rawCount} raw (${pct(r.count, r.rawCount)}%)` : "—";
    const was = r.previousCount == null ? "none" : String(r.previousCount);
    return `| ${r.label} | ${state} | ${kept} | ${was} | ${(r.problems[0] || r.error || "").slice(0, 120)} |`;
  });

  const lines = [
    "## Recall feed refresh",
    "",
    "| Feed | Result | Kept | Previously committed | Note |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "A feed is only written when it passes its health checks — a collapsed or",
    "empty feed leaves the committed snapshot untouched and turns this run red.",
    "The full upstream shape is in the `feed-report` artifact.",
    "",
  ];
  console.log("\n" + lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

async function main() {
  const results = [];

  for (const feed of FEEDS) {
    console.log(`${feed.name}:`);
    const prev = await previous(feed.name);
    const base = { name: feed.name, label: feed.label, previousCount: prev ? prev.notices.length : null };

    let got;
    try {
      got = await feed.load();
    } catch (err) {
      const error = String((err && err.message) || err);
      console.log(`  ${feed.name}: FAILED — ${error}`);
      results.push({ ...base, ok: false, problems: [], error, shape: null });
      continue;
    }

    const { notices, shape } = got;
    const prevMeta = prev ? { count: prev.notices.length, notices: prev.notices } : null;
    const problems = healthProblems(feed.name, notices, shape, prevMeta);

    console.log(`  ${feed.name}: kept ${notices.length} of ${shape.rawCount} raw notices (${pct(notices.length, shape.rawCount)}%)`);

    if (problems.length) {
      for (const p of problems) console.log(`  ${feed.name}: REFUSING TO WRITE — ${p}`);
      console.log(`  ${feed.name}: the previous snapshot is untouched and still serving.`);
      results.push({ ...base, ok: true, changed: false, count: notices.length, rawCount: shape.rawCount, problems, shape });
      continue;
    }

    const changed = await write(feed.name, notices, shape, prev);
    console.log(`  ${feed.name}: ${changed ? `wrote ${notices.length} notices` : `unchanged (${notices.length} notices) — not rewriting`}`);
    results.push({ ...base, ok: true, changed, count: notices.length, rawCount: shape.rawCount, problems: [], shape });
  }

  await report(results);

  /* Every feed is required. The old rule — "green if at least one of the two
   * was written" — is exactly how a total USDA failure passed unnoticed. */
  const bad = results.filter((r) => !r.ok || r.problems.length);
  if (bad.length) {
    console.log(`${bad.length} of ${results.length} feeds are not healthy: ${bad.map((r) => r.label).join(", ")}.`);
    process.exit(1);
  }
  console.log(`All ${results.length} feeds refreshed and healthy.`);
}

await main();
