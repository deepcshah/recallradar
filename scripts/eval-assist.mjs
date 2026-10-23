#!/usr/bin/env node
/* Eval for the recall assistant ("Get help", api/_lib/assist.js).
 *
 *   ANTHROPIC_API_KEY=… node scripts/eval-assist.mjs
 *   ANTHROPIC_API_KEY=… ASSIST_MODEL=claude-sonnet-5-5 ASSIST_EFFORT=low node scripts/eval-assist.mjs
 *
 *   --n 8            recalls per task (default 8: newest CPSC; `next` adds 4 devices)
 *   --task next|alts only one task
 *   --ids a,b,c      exactly these recall ids
 *   --concurrency 3  runs in flight
 *
 * Runs the real agent (same code, same prompt, no cache) on a fixed set of
 * recalls from the committed index, saves every answer, and grades each one
 * with checks that need no second model:
 *
 *   next  the official notice is among the sources · 3–6 steps · a summary ·
 *         any phone number appears on a page it cited or the notice (else
 *         "ungrounded") · the claim link is on a cited site or the notice ·
 *         the remedy word agrees with the notice text when the notice names one
 *   alts  the official notice is among the sources · 3–5 items · something to
 *         look for · no item from the recalled brand · no item that matches a
 *         CPSC recall in the index
 *
 * Output: a table here, and evals/runs/<time>-<model>-<effort>/ with one JSON
 * per answer (answer, checks, seconds, tokens unknown) and summary.md — keep
 * two runs and diff them to compare models. evals/runs/ is gitignored.
 *
 * Every run calls the API: about a cent to a few tens of cents per answer
 * depending on model, effort and how much it searches.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndex } from "../src/lib/index-server.js";
import { assistTasksFor } from "../src/lib/assist.js";

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const N = Number(arg("n", 8));
const ONLY = arg("task", "");
const IDS = arg("ids", "").split(",").filter(Boolean);
const CONC = Number(arg("concurrency", 3));
const MODEL = process.env.ASSIST_MODEL || "claude-opus-5-5";
const EFFORT = process.env.ASSIST_EFFORT || "medium";

/* ─────────────────────────────── grading ──────────────────────────────── */

const digits = (s) => String(s || "").replace(/\D/g, "");
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
const words = (s) => String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];

/** "ONTHEWEI Recalls Baby Bath Seats…" -> "onthewei" — CPSC titles lead
 *  with the firm; FDA records carry `firm`. */
export function recalledBrand(r) {
  const m = String(r.product || "").match(/^(.+?)\s+(?:Recalls|Recall)\b/);
  return String(r.firm || (m && m[1]) || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
}

const REMEDY_WORDS = {
  refund: /refund/i,
  replacement: /replace/i,
  repair: /repair|retrofit|update/i,
  refund_or_replacement: /refund|replace/i,
};

/** Pages text: the notice and whatever sources it cited, fetched once. */
async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 recallradar-eval" } });
    if (!res.ok) return "";
    return (await res.text()).replace(/<[^>]+>/g, " ").slice(0, 400000);
  } catch (_) {
    return "";
  }
}

/** -> [{ name, pass: true|false|null, note }]; null = couldn't verify. */
export function grade(task, record, result, { pagesText = "", index = [] } = {}) {
  const r = result || {};
  const checks = [];
  const add = (name, pass, note = "") => checks.push({ name, pass, note });
  const sources = (r.sources || []).map((s) => s.url);
  const noticeHost = hostOf(record.url);
  add("cites notice", noticeHost ? sources.some((u) => hostOf(u) === noticeHost) : null, noticeHost);

  if (task === "next") {
    const n = (r.steps || []).length;
    add("3–6 steps", n >= 3 && n <= 6, `${n}`);
    add("summary", !!String(r.summary || "").trim());
    const phone = digits(r.contact && r.contact.phone);
    if (phone) add("phone grounded", pagesText ? digits(pagesText).includes(phone.slice(-10)) : null, r.contact.phone);
    const claim = r.contact && r.contact.url;
    if (claim) {
      const h = hostOf(claim);
      add("claim link grounded", sources.some((u) => hostOf(u) === h) || (pagesText ? pagesText.includes(h) : false), h);
    }
    const re = REMEDY_WORDS[r.remedy];
    if (re) add("remedy matches notice", pagesText ? re.test(pagesText) : null, r.remedy);
  } else {
    const items = r.items || [];
    add("3–5 items", items.length >= 3 && items.length <= 5, `${items.length}`);
    add("look-for list", (r.lookFor || []).length > 0);
    const brand = recalledBrand(record);
    const same = brand ? items.filter((it) => String(it.brand || "").toLowerCase().includes(brand) || String(it.name || "").toLowerCase().includes(brand)) : [];
    add("not the recalled brand", same.length === 0, same.map((x) => x.name).join("; "));
    const cpsc = index.filter((x) => x.source === "CPSC" && x.id !== record.id);
    const hits = items.filter((it) => {
      const b = String(it.brand || "").toLowerCase().trim();
      if (b.length < 3) return false;
      const nameWords = words(it.name).filter((w) => !["baby", "the", "and", "for", "with"].includes(w));
      return cpsc.some((x) => {
        const p = String(x.product || "").toLowerCase();
        return p.includes(b) && nameWords.some((w) => p.includes(w));
      });
    });
    add("no recalled alternatives", hits.length === 0, hits.map((x) => `${x.brand} ${x.name}`).join("; "));
  }
  return checks;
}

/* ──────────────────────────────── running ─────────────────────────────── */

function pickCases(recalls) {
  const byId = new Map(recalls.map((r) => [r.id, r]));
  if (IDS.length) {
    return IDS.flatMap((id) => {
      const r = byId.get(id);
      if (!r) { console.warn(`skip ${id}: not in the index`); return []; }
      return assistTasksFor(r).filter((t) => !ONLY || t === ONLY).map((task) => ({ task, record: r }));
    });
  }
  const newest = (src) => recalls.filter((r) => r.source === src && r.status !== "announced")
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, N);
  const cpsc = newest("CPSC");
  const devices = newest("FDA Device").slice(0, 4);
  const cases = [];
  if (!ONLY || ONLY === "next") for (const r of [...cpsc, ...devices]) cases.push({ task: "next", record: r });
  if (!ONLY || ONLY === "alts") for (const r of cpsc) cases.push({ task: "alts", record: r });
  return cases;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (e.g. in .env.local, then `set -a; . ./.env.local; set +a`).");
    process.exit(2);
  }
  const { runAgent } = await import("../api/_lib/assist.js");
  const index = await readIndex();
  const recalls = (index && index.recalls) || [];
  const cases = pickCases(recalls);
  if (!cases.length) { console.error("no cases"); process.exit(2); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join("evals", "runs", `${stamp}-${MODEL}-${EFFORT}`);
  mkdirSync(dir, { recursive: true });
  console.log(`${cases.length} runs · ${MODEL} · effort ${EFFORT} · → ${dir}\n`);

  const rows = await pool(cases, CONC, async ({ task, record }) => {
    const t0 = Date.now();
    let result = null, error = "";
    try { result = (await runAgent(task, record)).result; } catch (err) { error = (err && err.message) || String(err); }
    const seconds = Math.round((Date.now() - t0) / 1000);
    const urls = [record.url, ...((result && result.sources) || []).map((s) => s.url)].filter(Boolean).slice(0, 5);
    const pagesText = result ? (await Promise.all(urls.map(fetchText))).join("\n") : "";
    const checks = result ? grade(task, record, result, { pagesText, index: recalls }) : [{ name: "answered", pass: false, note: error }];
    writeFileSync(join(dir, `${record.id}-${task}.json`), JSON.stringify({ task, id: record.id, product: record.product, model: MODEL, effort: EFFORT, seconds, error, checks, result }, null, 2));
    const failed = checks.filter((c) => c.pass === false);
    const mark = failed.length ? "✗" : "✓";
    console.log(`${mark} ${task.padEnd(4)} ${record.id.padEnd(22)} ${String(seconds).padStart(3)}s  ${failed.map((c) => `${c.name}${c.note ? ` (${c.note})` : ""}`).join(", ")}`);
    return { task, id: record.id, seconds, checks, error };
  });

  const all = rows.flatMap((r) => r.checks);
  const passed = rows.filter((r) => r.checks.every((c) => c.pass !== false)).length;
  const byCheck = {};
  for (const c of all) {
    const b = (byCheck[c.name] ||= { pass: 0, fail: 0, unknown: 0 });
    b[c.pass === true ? "pass" : c.pass === false ? "fail" : "unknown"]++;
  }
  const secs = rows.map((r) => r.seconds).sort((a, b) => a - b);
  const median = secs[Math.floor(secs.length / 2)];
  const md = [
    `# Assistant eval — ${MODEL}, effort ${EFFORT}`,
    "",
    `${passed}/${rows.length} answers passed every check · median ${median}s · slowest ${secs[secs.length - 1]}s`,
    "",
    "| Check | Pass | Fail | Couldn't verify |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(byCheck).map(([k, v]) => `| ${k} | ${v.pass} | ${v.fail} | ${v.unknown} |`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "summary.md"), md);
  console.log(`\n${md}`);
  process.exit(passed === rows.length ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
