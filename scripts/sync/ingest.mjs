/* Where each source's payloads come from: the agencies (live), or the
 * committed real snapshots (--from-snapshots). Fetching, retrying and health
 * checking are the existing code's — refresh-feeds.mjs's FEEDS and
 * healthProblems for USDA and CPSC, build-index.mjs's fetchFdaWindow and
 * FDA_HEALTH for openFDA, its RSS reader for announcements. Nothing is
 * reimplemented here; this file only decides windows and keys.
 *
 * Every ingester returns
 *   { mode, items: [{key, format, payload}], upstreamLastUpdated?, fetchedAt?,
 *     problems: [] }
 * and a non-empty `problems` means: do not store this fetch (the rule the
 * snapshots have always had — never write a collapsed feed).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FEEDS, healthProblems } from "../refresh-feeds.mjs";
import {
  FDA_KINDS, FDA_HEALTH, fetchFdaWindow, fetchText, parseRss, FDA_RSS_URL, ANNOUNCE_SOURCE,
} from "../build-index.mjs";
import { fdaId, fdaLastUpdated, LOOKBACK_DAYS, CPSC_LOOKBACK_DAYS } from "../../src/lib/sources.js";
import { rawToCanonical } from "./normalize.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SNAPSHOTS = {
  fsis: resolve(ROOT, "public/feeds/fsis.json"),
  cpsc: resolve(ROOT, "public/feeds/cpsc.json"),
  index: resolve(ROOT, "public/feeds/index.json"),
};

const DAY_MS = 86400000;
/* An incremental openFDA run re-reads this far behind the newest report date
 * we hold: openFDA publishes weekly and backfills, so the last three weeks
 * are where late arrivals land. */
export const FDA_OVERLAP_DAYS = 21;
/* ...and a full window at least this often, because a recall's status changes
 * (Ongoing -> Terminated) without its report date moving, so an incremental
 * window never sees it. Twelve requests a week. */
export const FDA_FULL_EVERY_DAYS = 7;

const day = (d) => d.toISOString().slice(0, 10);

function uniqueByKey(items) {
  const seen = new Set();
  return items.filter((it) => (it.key && !seen.has(it.key) ? seen.add(it.key) : false));
}

/** Key a raw payload by the recall id its mapper mints. */
function keyed(format, payloads) {
  return uniqueByKey(payloads.map((payload) => {
    let key = null;
    try { key = rawToCanonical(format, payload).id; } catch (_) { /* unmappable: skipped */ }
    return { key, format, payload };
  }));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function one(db, sql, params) {
  const [r] = await db.query(sql, params);
  return r || {};
}

// ───────────────────────────────────────────────────────────── openFDA
export async function ingestFda({ db, now, full = false, lookbackDays = LOOKBACK_DAYS, fdaRaw = null, log }) {
  const { max_posted: maxPosted, last_full: lastFull } = await one(db,
    `select (select max(posted)::text from recalls where feed = 'fda') as max_posted,
            (select extract(epoch from max(started_at))::float8 from sync_runs
              where source = 'fda' and ok and mode = 'full') as last_full`);
  const oldest = new Date(now.getTime() - lookbackDays * DAY_MS);
  const isFull = !!(fdaRaw || full || !maxPosted || !lastFull ||
    now.getTime() - lastFull * 1000 > FDA_FULL_EVERY_DAYS * DAY_MS);
  const from = isFull ? oldest
    : new Date(Math.max(oldest.getTime(), Date.parse(maxPosted + "T00:00:00Z") - FDA_OVERLAP_DAYS * DAY_MS));
  const mode = fdaRaw ? "fixture" : isFull ? "full" : "incremental";

  const items = [];
  let lastUpdated = null;
  for (const kind of FDA_KINDS) {
    let results;
    if (fdaRaw) {
      const given = fdaRaw[kind] || [];
      results = Array.isArray(given) ? given : given.results || [];
      const u = Array.isArray(given) ? null : fdaLastUpdated(given);
      if (u && !(lastUpdated >= u)) lastUpdated = u;
    } else {
      log(`  fda ${kind}: ${day(from)} .. ${day(now)} (${mode})`);
      const meta = {};
      results = await fetchFdaWindow(kind, from, now, meta);
      if (meta.lastUpdated && !(lastUpdated >= meta.lastUpdated)) lastUpdated = meta.lastUpdated;
      log(`  fda ${kind}: ${results.length} records`);
    }
    for (const r of results) items.push({ key: fdaId(kind, r), format: `openfda:${kind}`, payload: r });
  }

  const problems = [];
  if (!fdaRaw) {
    const { n: held } = await one(db,
      `select count(*)::int as n from recalls where feed = 'fda' and posted >= $1::date`, [day(from)]);
    if (isFull && items.length < FDA_HEALTH.floor) {
      problems.push(`openFDA returned only ${items.length} records for a full window, below the floor of ${FDA_HEALTH.floor}`);
    }
    if (held >= (isFull ? FDA_HEALTH.floor : 50) && items.length < held * FDA_HEALTH.collapse) {
      problems.push(`openFDA collapsed: ${items.length} records where the database holds ${held} for the same window`);
    }
  }
  return { mode, items: uniqueByKey(items), upstreamLastUpdated: lastUpdated, fetchedAt: now.toISOString(), problems,
    details: { from: day(from), to: day(now) } };
}

// ───────────────────────────────────────────────────────────── USDA / CPSC
async function ingestFeed(name, format, { db, now, prevCountSql }) {
  const feed = FEEDS.find((f) => f.name === name);
  const got = await feed.load();
  const raw = Array.isArray(got.raw) ? got.raw : (got.raw && got.raw.results) || [];
  const { n: prev } = await one(db, prevCountSql, [now.toISOString()]);
  const problems = healthProblems(name, got.notices, got.shape, prev ? { count: prev } : null);
  return {
    mode: "full",
    items: keyed(format, raw),
    fetchedAt: now.toISOString(),
    problems,
    details: { rawCount: raw.length, slimCount: got.notices.length, ...(got.shape && got.shape.rung ? { rung: got.shape.rung } : null) },
  };
}

export function ingestFsis(ctx) {
  return ingestFeed("fsis", "fsis-api", {
    ...ctx,
    prevCountSql: `select count(*)::int as n from recalls where feed = 'fsis'
                     and (status = 'active' or initiated >= ($1::timestamptz - interval '${LOOKBACK_DAYS} days')::date)`,
  });
}

export function ingestCpsc(ctx) {
  return ingestFeed("cpsc", "cpsc-api", {
    ...ctx,
    prevCountSql: `select count(*)::int as n from recalls where feed = 'cpsc'
                     and initiated >= ($1::timestamptz - interval '${CPSC_LOOKBACK_DAYS} days')::date`,
  });
}

// ───────────────────────────────────────────────────────────── FDA RSS
export async function ingestAnnouncements({ now }) {
  const items = parseRss(await fetchText(FDA_RSS_URL));
  if (!items.length) throw new Error("feed parsed to zero items");
  return { mode: "full", items: keyed("rss-item", items), fetchedAt: now.toISOString(), problems: [] };
}

// ───────────────────────────────────────────────────────────── snapshots
/* The committed files are real agency data, fetched by the refresh workflow;
 * `fetchedAt` is carried so the manifest says how old they are rather than
 * when they were copied in. FDA's records exist only as index records, so
 * they enter as format `index-record`. */
export async function fromSnapshots(source, paths = {}) {
  const p = { ...SNAPSHOTS, ...paths };
  if (source === "fsis" || source === "cpsc") {
    const snap = await readJson(p[source]);
    const notices = Array.isArray(snap.notices) ? snap.notices : [];
    return {
      mode: "snapshot", items: keyed(`${source}-snapshot`, notices), fetchedAt: snap.fetchedAt || null,
      problems: notices.length ? [] : [`${source} snapshot is empty`], details: { path: p[source], count: notices.length },
    };
  }
  const index = await readJson(p.index);
  const recs = (index.recalls || []).filter((r) => source === "announcements"
    ? r.source === ANNOUNCE_SOURCE
    : /^FDA (Food|Drug|Device)$/.test(r.source));
  const src = (index.sources || {})[source === "announcements" ? "fdaAnnouncements" : "fda"] || {};
  return {
    mode: "snapshot",
    items: uniqueByKey(recs.map((r) => ({ key: r.id, format: "index-record", payload: r }))),
    upstreamLastUpdated: source === "fda" ? src.lastUpdated || null : null,
    fetchedAt: src.fetchedAt || null,
    problems: recs.length ? [] : [`the committed index holds no ${source} records`],
    warnings: src.ok === false ? [`the committed index marks ${source} as not refreshed (${src.note || "no note"})`] : [],
    details: { path: p.index, count: recs.length, builtAt: index.builtAt || null },
  };
}
