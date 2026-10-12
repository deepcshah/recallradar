/* Sync the recall database.
 *
 *   node scripts/sync/run.mjs [--dry-run] [--pglite <dir>] [--source fda|fsis|cpsc|announcements|all]
 *                             [--from-snapshots] [--full] [--lookback <days>] [--reindex]
 *                             [--expect id,id,...]
 *
 * Database:
 *   --pglite <dir>   a file-backed PGlite database (kept between runs)
 *   --dry-run        a fresh in-memory PGlite database, thrown away at exit —
 *                    nothing is written anywhere, even when DATABASE_URL is set
 *   otherwise        DATABASE_URL (Neon / Supabase). Not set -> exit 2 with a
 *                    message; the workflow turns that into a labelled dry run.
 *
 * Data:
 *   default           the agencies, live (openFDA incremental by report date;
 *                     a full window on the first run and weekly)
 *   --from-snapshots  the committed real snapshots in public/feeds/ — offline
 *                     verification, and a bootstrap for a new database
 *   --reindex         no ingest: re-derive recall_index (e.g. after bumping
 *                     CLASSIFIER_VERSION) and republish
 *
 * The summary goes to stdout, $GITHUB_STEP_SUMMARY and $SYNC_SUMMARY_FILE
 * when those are set.
 *
 * Exit 1 when a required source failed (announcements are best-effort, as in
 * the index build) or an --expect id is missing; the summary says which.
 */
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { openDb } from "../../src/lib/db.js";
import { runSync, spotCheck, summaryMarkdown, SOURCES, OPTIONAL_SOURCES } from "./pipeline.mjs";

function args(argv) {
  const a = { dryRun: false, pglite: null, source: "all", fromSnapshots: false, full: false, lookback: null, reindex: false, expect: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--pglite") a.pglite = next();
    else if (k === "--source") a.source = next();
    else if (k === "--from-snapshots") a.fromSnapshots = true;
    else if (k === "--full") a.full = true;
    else if (k === "--lookback") a.lookback = Number(next());
    else if (k === "--reindex") a.reindex = true;
    else if (k === "--expect") a.expect = String(next() || "").split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.source !== "all" && !SOURCES.includes(a.source)) throw new Error(`--source must be one of ${SOURCES.join(", ")}, all`);
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  let db;
  let target;
  if (a.pglite) {
    db = await openDb({ pglite: a.pglite });
    target = `Database: PGlite at \`${a.pglite}\`${a.dryRun ? " (dry run)" : ""}.`;
  } else if (a.dryRun) {
    db = await openDb({ pglite: true });
    target = process.env.DATABASE_URL
      ? "**DRY RUN** — a fresh in-memory PGlite database; DATABASE_URL was ignored and nothing was written anywhere."
      : "**DRY RUN** — a fresh in-memory PGlite database (DATABASE_URL is not set); nothing was written anywhere.";
  } else if (process.env.DATABASE_URL) {
    db = await openDb();
    target = "Database: Postgres (DATABASE_URL).";
  } else {
    console.error("sync: DATABASE_URL is not set. Pass --dry-run (throwaway PGlite) or --pglite <dir>.");
    return 2;
  }
  target += a.fromSnapshots ? " Data: the committed snapshots in public/feeds/ (real agency data, not fetched now)."
    : a.reindex ? " Re-derive and republish only; nothing fetched." : " Data: the agencies, live.";

  let code = 0;
  try {
    const out = await runSync({
      db,
      sources: a.source === "all" ? SOURCES : [a.source],
      fromSnapshots: a.fromSnapshots,
      dryRun: a.dryRun || !!a.pglite,
      full: a.full,
      lookbackDays: a.lookback || undefined,
      reindexOnly: a.reindex,
    });
    const spots = await spotCheck(db, out.published, a.expect);
    const md = summaryMarkdown({ title: `Recall database sync${a.dryRun ? " — dry run" : ""}`, target, out, spots });
    console.log("\n" + md);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
    // The workflow posts this file as a pull-request comment.
    if (process.env.SYNC_SUMMARY_FILE) await appendFile(process.env.SYNC_SUMMARY_FILE, md + "\n");
    const failed = out.results.filter((r) => !r.ok && !OPTIONAL_SOURCES.has(r.source));
    const missing = spots.filter((s) => !s.inDb || !s.chunk);
    if (failed.length) console.log(`sync: ${failed.map((r) => r.source).join(", ")} failed.`);
    if (missing.length) console.log(`sync: expected recalls missing: ${missing.map((s) => s.id).join(", ")}.`);
    code = failed.length || missing.length || out.published.skipped ? 1 : 0;
  } catch (err) {
    console.error(`sync: FAILED — ${(err && err.stack) || err}`);
    code = 1;
  } finally {
    await db.close();
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
