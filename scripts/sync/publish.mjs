/* recalls ⋈ recall_index -> the manifest and chunks in `published`.
 *
 * The published set keeps the committed index's windows, so a client sees
 * the same records whichever source answered /api/data:
 *   FDA, CPSC   news day within LOOKBACK_DAYS (365)
 *   USDA FSIS   active at any age, otherwise news day within LOOKBACK_DAYS
 *               (slimFsis's rule)
 *   FDA announcements  the last ANNOUNCE_DAYS (60), minus those an openFDA
 *               record from the same firm already covers
 *               (dropAnnouncedDuplicates)
 * The database itself keeps everything; only what is served is windowed.
 *
 * Only chunks whose content changed are rewritten (their hash is their
 * content's), chunks that no longer exist are deleted, and the manifest is
 * replaced — all in one transaction, so /api/data never sees a manifest that
 * names a chunk not yet written.
 */
import { buildPublication, toIndexRecord, sha16 } from "../../src/lib/publication.js";
import { LOOKBACK_DAYS } from "../../src/lib/sources.js";
import { ANNOUNCE_DAYS, dropAnnouncedDuplicates } from "../build-index.mjs";
import { CLASSIFIER_VERSION } from "./derive.mjs";

const DAY_MS = 86400000;
/* A publication smaller than this fraction of the current one is refused. */
export const PUBLISH_COLLAPSE = 0.5;
const GROUP_OF_FEED = { fda: "fda", fsis: "fsis", cpsc: "cpsc", announcements: "fdaAnnouncements" };

/** The manifest's per-source status, from sync_runs. */
export async function sourceStatus(db) {
  const rows = await db.query(
    `select distinct on (source) source, ok, error
       from sync_runs where finished_at is not null
      order by source, started_at desc, id desc`);
  const okRows = await db.query(
    `select distinct on (source) source, extract(epoch from finished_at)::float8 as finished_epoch, to_char(upstream_last_updated, 'YYYY-MM-DD') as upstream_last_updated, details
       from sync_runs where ok
      order by source, started_at desc, id desc`);
  const lastOk = new Map(okRows.map((r) => [r.source, r]));
  const out = {};
  for (const [feed, group] of Object.entries(GROUP_OF_FEED)) {
    const last = rows.find((r) => r.source === feed);
    const good = lastOk.get(feed);
    const fetchedAt = good && good.details && good.details.fetchedAt;
    out[group] = {
      ok: !!(last && last.ok),
      lastUpdated: (good && good.upstream_last_updated) || null,
      syncedAt: fetchedAt || (good && good.finished_epoch ? new Date(good.finished_epoch * 1000).toISOString() : null),
      ...(!last ? { note: "never synced" }
        : !last.ok ? { note: `last sync failed: ${String(last.error || "unknown").slice(0, 160)}; serving the last good data` }
        : null),
    };
  }
  return out;
}

/** The IndexRecords to publish, in the committed index's windows. */
export async function publishableRecords(db, { now = new Date(), version = CLASSIFIER_VERSION } = {}) {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const annSince = new Date(now.getTime() - ANNOUNCE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const rows = await db.query(
    `select r.id, r.feed, r.source, r.product, r.firm, r.reason, r.classification, r.severity, r.status,
            r.distribution, to_jsonb(r.states) as states, r.coverage, r.initiated::text as initiated,
            r.posted::text as posted, r.ended::text as ended, r.url, to_jsonb(r.upcs) as upcs, r.image,
            r.announcement, i.category, i.reason_key
       from recalls r
       join recall_index i on i.recall_id = r.id and i.classifier_version = $1::int
      where r.initiated is not null and (
            (r.feed <> 'announcements' and (greatest(r.posted, r.initiated) >= $2::date
                                            or (r.feed = 'fsis' and r.status = 'active')))
         or (r.feed = 'announcements' and r.initiated >= $3::date))`,
    [version, cutoff, annSince]);
  const recs = rows.map((r) => toIndexRecord(r));
  const fda = recs.filter((r) => /^FDA (Food|Drug|Device)$/.test(r.source));
  const ann = recs.filter((r) => r.source === "FDA announcement");
  const { kept, dropped } = dropAnnouncedDuplicates(ann, fda);
  const keptIds = new Set(kept.map((r) => r.id));
  return {
    records: recs.filter((r) => r.source !== "FDA announcement" || keptIds.has(r.id)),
    droppedAnnouncements: dropped.length,
  };
}

/** @returns {Promise<{manifest, chunks, written, unchanged, removed, droppedAnnouncements, skipped?}>} */
export async function publish(db, { now = new Date(), version = CLASSIFIER_VERSION } = {}) {
  const { records, droppedAnnouncements } = await publishableRecords(db, { now, version });
  const sources = await sourceStatus(db);
  const pub = buildPublication({ records, sources, classifierVersion: version, anchor: now.toISOString() });
  const at = now.toISOString();

  /* Never publish a hole. An empty set (a first sync where every source
   * failed) or one that collapsed against what is already published leaves
   * the previous publication serving — or, with none, /api/data keeps serving
   * the committed index — and the run says so. */
  const [prev] = await db.query(`select body from published where key = 'manifest'`);
  const prevTotal = prev ? (JSON.parse(prev.body).totals || {}).recalls || 0 : 0;
  const skipped = !records.length ? "nothing to publish"
    : prevTotal >= 100 && records.length < prevTotal * PUBLISH_COLLAPSE
      ? `collapsed from ${prevTotal} published recalls to ${records.length}` : null;
  if (skipped) {
    return { manifest: pub.manifest, chunks: pub.chunks, written: 0, unchanged: 0, removed: 0, droppedAnnouncements, skipped };
  }

  let written = 0;
  let unchanged = 0;
  let removed = 0;
  await db.tx(async (t) => {
    const have = new Map((await t.query(`select key, hash from published`)).map((r) => [r.key, r.hash]));
    const fresh = pub.chunks.filter((c) => have.get(`chunk:${c.key}`) !== c.hash);
    unchanged = pub.chunks.length - fresh.length;
    for (const c of fresh) {
      await t.query(
        `insert into published (key, hash, body, bytes, updated_at) values ($1, $2, $3, $4::int, $5::timestamptz)
         on conflict (key) do update set hash = excluded.hash, body = excluded.body, bytes = excluded.bytes, updated_at = excluded.updated_at`,
        [`chunk:${c.key}`, c.hash, c.body, c.bytes, at]);
      written++;
    }
    const live = new Set(pub.chunks.map((c) => `chunk:${c.key}`));
    for (const key of have.keys()) {
      if (key.startsWith("chunk:") && !live.has(key)) {
        await t.query(`delete from published where key = $1`, [key]);
        removed++;
      }
    }
    await t.query(
      `insert into published (key, hash, body, bytes, updated_at) values ('manifest', $1, $2, $3::int, $4::timestamptz)
       on conflict (key) do update set hash = excluded.hash, body = excluded.body, bytes = excluded.bytes, updated_at = excluded.updated_at`,
      [sha16(pub.manifestBody), pub.manifestBody, Buffer.byteLength(pub.manifestBody), at]);
  });
  return { manifest: pub.manifest, chunks: pub.chunks, written, unchanged, removed, droppedAnnouncements };
}
