/* Fetch the government recall feeds and write them into public/feeds/.
 *
 * This runs on a GitHub Actions runner, not on Vercel, and that is the entire
 * point. Every other path to USDA in this app leaves from the same place — a
 * Vercel serverless function — so they all fail together for whatever reason
 * that one caller is being refused. A GitHub runner is a different network,
 * different IP reputation, different everything; if USDA will answer anyone,
 * it will answer this.
 *
 * The output is committed to the repository, which is what makes it the
 * bottom tier that cannot fail: it ships with the deployment as a static
 * asset, needs no Blob store, no environment variable, no runtime fetch and no
 * cooperation from USDA at request time. If every live path is blocked and the
 * cache is cold, the app still has meat and poultry recalls, dated honestly.
 *
 * Usage:  node scripts/refresh-feeds.mjs
 * Exit 0 when at least one feed was written, 1 when none were — a red run in
 * Actions is the signal worth having, and the previous snapshot stays
 * committed and serving either way.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { slimFsis, slimCpsc, CPSC_LOOKBACK_DAYS } from "../src/lib/sources.js";
import { FEED_HEADERS, FSIS_ENDPOINTS, cpscUrl } from "../src/lib/feeds.js";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/feeds");

/* Generous by the standards of a serverless function, trivial for a runner
 * with a six-hour budget and nobody waiting on it. */
const TIMEOUT_MS = 60000;
const ATTEMPTS = 3;
const GAP_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: FEED_HEADERS, signal: ctrl.signal });
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

async function withRetries(label, url) {
  let last;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      last = err;
      console.log(`  ${label}: attempt ${i}/${ATTEMPTS} failed — ${err.message}`);
      if (i < ATTEMPTS) await sleep(GAP_MS);
    }
  }
  throw last;
}

/* Never overwrite a good snapshot with an empty one. An upstream that answers
 * 200 with zero notices is far more likely to be having a bad day than it is
 * to be reporting that America has no active meat recalls. */
async function write(name, notices) {
  if (!Array.isArray(notices) || !notices.length) {
    throw new Error("upstream returned no notices — keeping the previous snapshot");
  }
  const path = resolve(OUT_DIR, `${name}.json`);

  /* Only rewrite when the notices actually changed. `fetchedAt` moves on every
   * run, so stamping it unconditionally would commit a new copy of an
   * unchanged file several times a day, forever. */
  const body = JSON.stringify(notices);
  try {
    const prev = JSON.parse(await readFile(path, "utf8"));
    if (JSON.stringify(prev.notices) === body) {
      console.log(`  ${name}: unchanged (${notices.length} notices) — not rewriting`);
      return { name, ok: true, count: notices.length, changed: false };
    }
  } catch (_) { /* first run, or an unreadable previous file */ }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path,
    JSON.stringify({ fetchedAt: new Date().toISOString(), count: notices.length, notices }, null, 0) + "\n");
  console.log(`  ${name}: wrote ${notices.length} notices`);
  return { name, ok: true, count: notices.length, changed: true };
}

async function main() {
  const jobs = [
    ["fsis", async () => slimFsis(await withRetries("fsis", FSIS_ENDPOINTS[0]))],
    ["cpsc", async () => slimCpsc(await withRetries("cpsc", cpscUrl(CPSC_LOOKBACK_DAYS)))],
  ];

  const results = [];
  for (const [name, load] of jobs) {
    console.log(`${name}:`);
    try {
      results.push(await write(name, await load()));
    } catch (err) {
      console.log(`  ${name}: FAILED — ${err.message}`);
      results.push({ name, ok: false, error: err.message });
    }
  }

  const ok = results.filter((r) => r.ok);
  console.log(`\n${ok.length}/${results.length} feeds refreshed.`);
  if (!ok.length) {
    console.log("Nothing was written. The committed snapshots are untouched and still serving.");
    process.exit(1);
  }
}

await main();
