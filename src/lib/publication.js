/* What clients download: the manifest and its chunks (GET /api/data).
 *
 * One pure builder, two callers, one format:
 *   - scripts/sync/publish.mjs builds it from the database (recalls ⋈
 *     recall_index) and stores it in `published`;
 *   - api/data.js builds it from the committed public/feeds/index.json when
 *     no DATABASE_URL is configured.
 *
 * CONTRACT (format 1)
 *   manifest: { format, generatedAt, dataVersion, classifierVersion,
 *               sources: { fda|fsis|cpsc|fdaAnnouncements: {ok, count,
 *                 lastUpdated, newestPosted, syncedAt} },
 *               chunks: [{ key, from, to, count, hash, bytes }],  newest first
 *               totals: { recalls, active } }
 *   chunk:    { format, key, hash, records: [IndexRecord…] }
 *
 * "latest" holds every record whose news day (the later of `posted` and
 * `date`, as digest.js newsDay) is within LATEST_DAYS of the anchor day;
 * "YYYY-MM" chunks hold the older ones by news-day month. Every record is in
 * exactly one chunk. A chunk's hash is sha256 (16 hex) of its records, so it
 * changes only when that chunk's content does — clients cache chunks forever
 * by hash and re-download only what moved.
 *
 * The anchor is a parameter, never "now" read in here: two serverless
 * instances building from the same index must produce the same hashes.
 *
 * Node-only (node:crypto).
 */
import { createHash } from "node:crypto";

export const FORMAT = 1;
export const LATEST_DAYS = 30;

/* The loosest of build-index.mjs's CAP_TIERS: text fields are trimmed to this
 * on the way out (the database keeps them whole). check-db asserts the two
 * stay equal. */
export const PUBLISH_CAPS = { text: 320, firm: 120, dist: 400 };

const DAY_MS = 86400000;

export function sha16(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Same rule as cap() in scripts/build-index.mjs. */
export function capText(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** digest.js newsDay, for ISO-day strings. */
export function newsDayOf(r) {
  const a = String((r && r.date) || "").slice(0, 10);
  const b = String((r && r.posted) || "").slice(0, 10);
  return b > a ? b : a;
}

/** Which manifest source a record counts toward. */
export function sourceGroup(source) {
  if (source === "FDA announcement") return "fdaAnnouncements";
  if (/^FDA /.test(String(source))) return "fda";
  if (source === "USDA FSIS") return "fsis";
  if (source === "CPSC") return "cpsc";
  return null;
}

const day = (v) => (v == null || v === "" ? null : String(v).slice(0, 10));
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : typeof v === "string" ? JSON.parse(v) : []);

/**
 * One database row (recalls ⋈ recall_index, dates as text) -> IndexRecord,
 * exactly the shape of public/feeds/index.json's recalls[].
 */
export function toIndexRecord(row, caps = PUBLISH_CAPS) {
  const date = day(row.initiated);
  const posted = day(row.posted);
  const ended = day(row.ended);
  const rec = {
    id: row.id,
    source: row.source,
    product: capText(row.product, caps.text),
    firm: capText(row.firm, caps.firm),
    reason: capText(row.reason, caps.text),
    classification: row.classification || "",
    severity: row.severity || "med",
    date,
  };
  if (posted && posted !== date) rec.posted = posted;
  rec.status = row.status;
  if (row.status === "ended" && ended) rec.endDate = ended;
  if (row.announcement) rec.announcement = true;
  rec.distribution = capText(row.distribution, caps.dist);
  rec.states = arr(row.states);
  rec.coverage = row.coverage;
  rec.category = row.category;
  rec.reasonKey = row.reason_key;
  rec.url = row.url;
  const upcs = arr(row.upcs);
  if (upcs.length) rec.upcs = upcs;
  if (row.image) rec.image = row.image;
  return rec;
}

function addDays(isoDay, n) {
  return new Date(Date.parse(isoDay + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Newest first, then id — the order build-index.mjs writes. */
export function sortRecords(records) {
  return records.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
}

/**
 * @param {object}   p
 * @param {object[]} p.records            IndexRecords (records without a date are dropped)
 * @param {object}   p.sources            per group: { ok, lastUpdated, syncedAt, note? } — count and newestPosted are computed here
 * @param {number}   p.classifierVersion
 * @param {string}   p.anchor             ISO time the "latest" window is measured from
 * @param {string}   [p.generatedAt]      default: anchor
 * @returns {{ manifest: object, manifestBody: string, chunks: {key, hash, body, bytes, count, from, to}[] }}
 */
export function buildPublication({ records, sources = {}, classifierVersion, anchor, generatedAt }) {
  const anchorDay = String(anchor).slice(0, 10);
  const cutoff = addDays(anchorDay, -LATEST_DAYS);
  const groups = new Map();
  const kept = sortRecords(records.filter((r) => r && r.id && r.date));
  for (const r of kept) {
    const nd = newsDayOf(r);
    const key = nd >= cutoff ? "latest" : nd.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const keys = [...groups.keys()].sort((a, b) => (a === "latest" ? -1 : b === "latest" ? 1 : b.localeCompare(a)));
  const chunks = keys.map((key) => {
    const recs = groups.get(key);
    const hash = sha16(JSON.stringify(recs));
    const body = JSON.stringify({ format: FORMAT, key, hash, records: recs });
    let from, to;
    if (key === "latest") {
      const newest = recs.reduce((m, r) => (newsDayOf(r) > m ? newsDayOf(r) : m), anchorDay);
      from = cutoff;
      to = newest;
    } else {
      from = `${key}-01`;
      const end = monthEnd(key);
      to = end < cutoff ? end : addDays(cutoff, -1);
    }
    return { key, from, to, count: recs.length, hash, bytes: Buffer.byteLength(body), body };
  });

  const outSources = {};
  for (const g of ["fda", "fsis", "cpsc", "fdaAnnouncements"]) {
    const mine = kept.filter((r) => sourceGroup(r.source) === g);
    const s = sources[g] || {};
    outSources[g] = {
      ok: !!s.ok,
      count: mine.length,
      lastUpdated: s.lastUpdated || null,
      newestPosted: mine.reduce((m, r) => (newsDayOf(r) > m ? newsDayOf(r) : m), "") || null,
      syncedAt: s.syncedAt || null,
      ...(s.note ? { note: s.note } : null),
    };
  }

  const manifest = {
    format: FORMAT,
    generatedAt: generatedAt || new Date(Date.parse(anchor)).toISOString(),
    dataVersion: sha16(chunks.map((c) => `${c.key}:${c.hash}`).join("\n")),
    classifierVersion,
    sources: outSources,
    chunks: chunks.map(({ key, from, to, count, hash, bytes }) => ({ key, from, to, count, hash, bytes })),
    totals: { recalls: kept.length, active: kept.filter((r) => r.status === "active").length },
  };
  return { manifest, manifestBody: JSON.stringify(manifest), chunks };
}
