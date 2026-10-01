/* What openFDA actually has, against what our index has — run live.
 *
 *   node scripts/check-live-fda.mjs
 *
 * scripts/check-data.mjs tests logic offline and can say nothing about the
 * data. This is the other half, and it only means anything where api.fda.gov
 * is reachable: the refresh workflow's GitHub runner (it is blocked in some
 * sandboxes — then every row says "unreachable", which is the truth).
 *
 * It answers three questions, in the job summary:
 *   1. How current is openFDA? Its own meta.last_updated and newest
 *      report_date, per kind. A recall classified after that date cannot be
 *      in it, whatever the news says.
 *   2. Did our index get it? The index's FDA count and lastUpdated next to
 *      openFDA's.
 *   3. Is the recall someone heard about there yet? Every query in
 *      scripts/watchlist.json, run live, and whether its hits are in the index.
 *
 * Informational: it never fails the run (the workflow marks the step
 * continue-on-error too), because "not published yet" is not our bug — but it
 * prints a warning line for the cases that are: an index with no FDA records
 * while openFDA answers, or an index older than openFDA by more than a week.
 */
import { readFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["food", "drug", "device"];
const KEY = process.env.OPENFDA_KEY ? `&api_key=${process.env.OPENFDA_KEY}` : "";

async function openFda(kind, query) {
  const url = `https://api.fda.gov/${kind}/enforcement.json?${query}${KEY}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) return { ok: true, total: 0, results: [], lastUpdated: null };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    return {
      ok: true,
      total: (body.meta && body.meta.results && body.meta.results.total) || 0,
      results: body.results || [],
      lastUpdated: (body.meta && body.meta.last_updated) || null,
    };
  } catch (err) {
    return { ok: false, error: err && err.name === "TimeoutError" ? "timed out" : String((err && err.message) || err) };
  }
}

const day = (s) => (/^\d{8}$/.test(String(s)) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || "—");
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const index = JSON.parse(await readFile(resolve(ROOT, "public/feeds/index.json"), "utf8"));
const watch = JSON.parse(await readFile(resolve(ROOT, "scripts/watchlist.json"), "utf8")).entries || [];
const indexIds = new Set(index.recalls.map((r) => r.id));
const indexFda = index.recalls.filter((r) => /^FDA (Food|Drug|Device)/.test(r.source)).length;

const out = [];
const warn = [];
out.push("## Live FDA check", "", "### 1. How current is openFDA", "",
  "| kind | openFDA last_updated | newest report_date | total records |", "|---|---|---|---|");
let reachable = false;
let openLatest = null;
for (const kind of KINDS) {
  const r = await openFda(kind, "sort=report_date:desc&limit=1");
  if (!r.ok) { out.push(`| ${kind} | unreachable (${r.error}) | — | — |`); continue; }
  reachable = true;
  if (r.lastUpdated && (!openLatest || r.lastUpdated > openLatest)) openLatest = r.lastUpdated;
  out.push(`| ${kind} | ${r.lastUpdated || "—"} | ${day(r.results[0] && r.results[0].report_date)} | ${r.total} |`);
}

const idxFda = index.sources && index.sources.fda;
out.push("", "### 2. Our index", "",
  `- built ${index.builtAt}; FDA records: **${indexFda}**; sources.fda.ok: ${idxFda ? idxFda.ok : "—"}; ` +
  `lastUpdated: ${(idxFda && idxFda.lastUpdated) || "—"}`);
if (reachable && indexFda === 0) warn.push("The index has NO FDA records while openFDA is answering — the index build is not getting FDA data.");
if (openLatest && idxFda && idxFda.lastUpdated && daysBetween(idxFda.lastUpdated, openLatest) > 7)
  warn.push(`The index's FDA data (${idxFda.lastUpdated}) is more than a week behind openFDA (${openLatest}).`);

out.push("", "### 3. Watch list (scripts/watchlist.json)", "");
if (!watch.length) out.push("_empty_");
for (const w of watch) {
  const r = await openFda(w.kind || "food", `search=${w.search}&sort=report_date:desc&limit=10`);
  out.push(`**${w.label}**`, `- query: \`${w.search}\``);
  if (!r.ok) { out.push(`- openFDA: unreachable (${r.error}) — not checked`, ""); continue; }
  if (!r.total) {
    out.push(`- openFDA: **not published yet** (no match in data as of ${openLatest || "unknown"})`, "");
    continue;
  }
  out.push(`- openFDA: **${r.total} match${r.total === 1 ? "" : "es"}**`);
  for (const rec of r.results) {
    const id = `fda-${w.kind || "food"}-${rec.recall_number}`;
    const inIdx = indexIds.has(id);
    if (!inIdx) warn.push(`Watch-list hit ${rec.recall_number} (${rec.recalling_firm}) is in openFDA but not in the index.`);
    out.push(`  - ${rec.recall_number} · ${rec.recalling_firm} · ${rec.classification} · report ${day(rec.report_date)} · ` +
      `${String(rec.distribution_pattern || "").slice(0, 80)} · index: ${inIdx ? "yes" : "**NO**"}`);
  }
  out.push("");
}

if (warn.length) out.push("### ⚠️ Needs a look", "", ...warn.map((w) => `- ${w}`), "");

const text = out.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
