/* One sync: ingest -> raw_records -> normalize -> recalls (+ recall_changes)
 * -> derive -> recall_index -> publish -> published. Every source writes a
 * sync_runs row whatever happens to it, and one source failing never stops
 * the others (the previous data for it keeps being published, marked not ok
 * in the manifest).
 */
import { migrate } from "../db/migrate.mjs";
import { ingestFda, ingestFsis, ingestCpsc, ingestAnnouncements, fromSnapshots } from "./ingest.mjs";
import { writeRaw, normalizeFeed } from "./normalize.mjs";
import { deriveIndex, CLASSIFIER_VERSION } from "./derive.mjs";
import { publish } from "./publish.mjs";

export const SOURCES = ["fda", "fsis", "cpsc", "announcements"];
/* Best-effort, as in the index build: its failure is recorded, never fatal. */
export const OPTIONAL_SOURCES = new Set(["announcements"]);

const LIVE = { fda: ingestFda, fsis: ingestFsis, cpsc: ingestCpsc, announcements: ingestAnnouncements };

async function syncSource(db, source, opts) {
  const { now, dryRun, fromSnapshots: snap, log } = opts;
  const started = new Date();
  const [{ id: runId }] = await db.query(
    `insert into sync_runs (source, mode, started_at, dry_run) values ($1, $2, $3::timestamptz, $4::boolean)
     returning id::int as id`, [source, snap ? "snapshot" : "pending", started.toISOString(), !!dryRun]);
  const result = { source, runId, ok: false, mode: snap ? "snapshot" : null, fetched: 0, raw_new: 0,
    inserted: 0, updated: 0, unchanged: 0, changes: 0, upstreamLastUpdated: null, newestPosted: null, error: null, warnings: [], upstream: false };
  let details = {};
  try {
    log(`${source}:`);
    /* Failures while FETCHING (network, a 4xx/5xx, a timeout) or a health
     * refusal are the agency's side — `upstream: true`. Anything after that
     * (writing raw, normalizing, publishing) is ours. The PR dry run uses the
     * difference: an agency outage is a warning there, our bug is a failure. */
    let got;
    try {
      got = snap
        ? await fromSnapshots(source, opts.snapshotPaths)
        : await LIVE[source]({ db, now, full: opts.full, lookbackDays: opts.lookbackDays, fdaRaw: opts.fdaRaw, log });
    } catch (err) {
      result.upstream = !snap;
      throw err;
    }
    result.mode = got.mode;
    result.fetched = got.items.length;
    result.upstreamLastUpdated = got.upstreamLastUpdated || null;
    result.warnings = got.warnings || [];
    details = { ...(got.details || {}), fetchedAt: got.fetchedAt || null, ...(result.warnings.length ? { warnings: result.warnings } : null) };
    if (got.problems.length) {
      result.upstream = true;
      throw new Error(`refused (health check): ${got.problems.join("; ")}`);
    }
    const raw = await writeRaw(db, { source, runId, now, items: got.items });
    result.raw_new = raw.raw_new;
    const n = await normalizeFeed(db, { feed: source, runId, now });
    Object.assign(result, { inserted: n.inserted, updated: n.updated, unchanged: n.unchanged, changes: n.changes });
    if (n.failed) result.warnings.push(`${n.failed} raw records could not be normalized`);
    const [{ newest }] = await db.query(
      `select max(greatest(posted, initiated))::text as newest from recalls where feed = $1`, [source]);
    result.newestPosted = newest || null;
    result.ok = true;
    log(`  ${source}: ${result.mode}, fetched ${result.fetched}, raw new ${result.raw_new}, ` +
      `inserted ${result.inserted}, updated ${result.updated}, unchanged ${result.unchanged}, changes ${result.changes}`);
  } catch (err) {
    result.error = String((err && err.message) || err).slice(0, 1000);
    log(`  ${source}: FAILED — ${result.error}`);
  }
  await db.query(
    `update sync_runs set mode = $2, finished_at = $3::timestamptz, ok = $4::boolean, fetched = $5::int,
       raw_new = $6::int, inserted = $7::int, updated = $8::int, unchanged = $9::int,
       upstream_last_updated = $10::date, newest_posted = $11::date, error = $12, details = $13::jsonb
     where id = $1::bigint`,
    [runId, result.mode || "failed", new Date().toISOString(), result.ok, result.fetched, result.raw_new,
      result.inserted, result.updated, result.unchanged, result.upstreamLastUpdated, result.newestPosted,
      result.error, JSON.stringify(details)]);
  return result;
}

/**
 * @param {object}   o
 * @param {object}   o.db              src/lib/db.js adapter
 * @param {string[]} [o.sources]       default all four
 * @param {boolean}  [o.fromSnapshots] ingest the committed real snapshots instead of the network
 * @param {object}   [o.snapshotPaths] { fsis, cpsc, index } overrides (check-db uses a real git-history snapshot)
 * @param {boolean}  [o.dryRun]        recorded on sync_runs; the caller chooses the throwaway database
 * @param {boolean}  [o.full]          openFDA: the whole lookback window, not the incremental one
 * @param {number}   [o.lookbackDays]
 * @param {object}   [o.fdaRaw]        { food, drug, device }: real recorded openFDA responses instead of fetching (tests)
 * @param {boolean}  [o.reindexOnly]   no ingest: derive + publish only
 * @param {number}   [o.classifierVersion]
 * @param {Date}     [o.now]
 */
export async function runSync(o) {
  const log = o.log || console.log;
  const now = o.now || new Date();
  const version = o.classifierVersion || CLASSIFIER_VERSION;
  const migrations = await migrate(o.db, { log });
  const results = [];
  if (!o.reindexOnly) {
    for (const source of o.sources || SOURCES) {
      results.push(await syncSource(o.db, source, { ...o, now, log }));
    }
  }
  const derived = await deriveIndex(o.db, { version, now });
  log(`index: derived ${derived.derived} rows at classifier v${derived.version}, removed ${derived.removed} of other versions`);
  const published = await publish(o.db, { now, version });
  if (published.skipped) log(`publish: NOT PUBLISHED — ${published.skipped}; the previous publication keeps serving`);
  else log(`publish: ${published.chunks.length} chunks (${published.written} written, ${published.unchanged} unchanged, ` +
    `${published.removed} removed), ${published.manifest.totals.recalls} recalls`);
  return { now, migrations, results, derived, published };
}

/** Which of `ids` are in the database and in the published chunks. */
export async function spotCheck(db, published, ids) {
  if (!ids || !ids.length) return [];
  const inDb = new Map((await db.query(
    `select id, status, firm, product from recalls where id = any(array(select jsonb_array_elements_text($1::jsonb)))`,
    [JSON.stringify(ids)])).map((r) => [r.id, r]));
  const where = new Map();
  for (const c of published.chunks) for (const r of JSON.parse(c.body).records) where.set(r.id, c.key);
  return ids.map((id) => ({ id, inDb: inDb.has(id), chunk: where.get(id) || null, firm: inDb.has(id) ? inDb.get(id).firm : null,
    status: inDb.has(id) ? inDb.get(id).status : null }));
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** The run as markdown, for the console and $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown({ title, target, out, spots = [] }) {
  const lines = [`## ${title}`, "", target, ""];
  if (out.results.length) {
    lines.push("| Source | Result | Mode | Fetched | Raw new | Inserted | Updated | Unchanged | Changes | Upstream last_updated | Newest | Note |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |");
    for (const r of out.results) {
      lines.push(`| ${r.source} | ${r.ok ? "✅ ok" : "❌ failed"} | ${r.mode || "—"} | ${r.fetched} | ${r.raw_new} | ${r.inserted} | ` +
        `${r.updated} | ${r.unchanged} | ${r.changes} | ${r.upstreamLastUpdated || "—"} | ${r.newestPosted || "—"} | ` +
        `${String(r.error || r.warnings.join("; ") || "").replace(/\|/g, "/").slice(0, 200)} |`);
    }
    lines.push("");
  }
  const m = out.published.manifest;
  if (out.published.skipped) {
    lines.push(`> **Not published: ${out.published.skipped}.** The previous publication (or, with none, the committed index) keeps serving. What would have been published:`, "");
  }
  lines.push(`**Index:** ${out.derived.derived} rows derived at classifier v${out.derived.version}` +
    `${out.derived.removed ? `, ${out.derived.removed} old-version rows removed` : ""}.`, "",
  `**Published:** ${m.totals.recalls} recalls (${m.totals.active} active), data version \`${m.dataVersion}\`, ` +
    `${m.chunks.length} chunks — ${out.published.written} written, ${out.published.unchanged} unchanged, ${out.published.removed} removed; ` +
    `${out.published.droppedAnnouncements} announcements dropped as covered by openFDA.`, "",
  "| Source | ok | Published | lastUpdated | newestPosted | syncedAt |", "| --- | --- | ---: | --- | --- | --- |",
  ...Object.entries(m.sources).map(([k, s]) => `| ${k} | ${s.ok ? "yes" : "no"} | ${s.count} | ${s.lastUpdated || "—"} | ${s.newestPosted || "—"} | ${s.syncedAt || "—"} |`),
  "", "| Chunk | From | To | Records | Size | Hash |", "| --- | --- | --- | ---: | ---: | --- |",
  ...m.chunks.map((c) => `| ${c.key} | ${c.from} | ${c.to} | ${c.count} | ${kb(c.bytes)} | \`${c.hash}\` |`),
  `| **total** | | | ${m.chunks.reduce((n, c) => n + c.count, 0)} | ${kb(m.chunks.reduce((n, c) => n + c.bytes, 0))} | |`, "");
  if (spots.length) {
    lines.push("**Spot checks**", "", "| Recall | In database | Published in | Firm | Status |", "| --- | --- | --- | --- | --- |",
      ...spots.map((s) => `| ${s.id} | ${s.inDb ? "✅ yes" : "❌ no"} | ${s.chunk || "—"} | ${s.firm || "—"} | ${s.status || "—"} |`), "");
  }
  return lines.join("\n");
}
