/* The one endpoint clients read recall data from.
 *
 *   GET /api/data?part=manifest
 *     -> the manifest (src/lib/publication.js), cached at the edge 5 minutes
 *   GET /api/data?part=chunk&key=<key>&h=<hash>
 *     -> that chunk; immutable for a year when `h` is its current hash,
 *        404 {error:"stale", current} when it is not
 *
 * Where the data comes from, reported in `X-Yanked-Data`:
 *   postgres         the `published` table, written by the sync
 *                    (scripts/sync/run.mjs), when DATABASE_URL is set and it
 *                    has been published to at least once;
 *   committed-index  otherwise: the same manifest and chunks built from
 *                    public/feeds/index.json (shipped in this function's
 *                    bundle), memoized per instance. Same format, same hashes
 *                    for the same records — the client cannot tell the
 *                    difference except by this header. A database that is
 *                    configured but unreachable falls back here too, rather
 *                    than answering with nothing.
 */
import { sharedDb } from "../src/lib/db.js";
import { readIndex } from "../src/lib/index-server.js";
import { buildPublication } from "../src/lib/publication.js";

const MANIFEST_CACHE = "public, s-maxage=300, stale-while-revalidate=86400";
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
const SHORT = "public, max-age=0, s-maxage=60";
const KEY_RE = /^(latest|\d{4}-\d{2})$/;
const HASH_RE = /^[0-9a-f]{16}$/;

/* The committed index's classifier is build-index.mjs's classifyRecord at
 * whatever text cap the build settled on; it predates versioning, so it is
 * reported as version 0. The database's rows carry CLASSIFIER_VERSION. */
const COMMITTED_CLASSIFIER_VERSION = 0;

let committed = null; // { index, pub, byKey }

async function fromCommittedIndex() {
  const index = await readIndex();
  if (!index) return null;
  if (committed && committed.index === index) return committed;
  const s = index.sources || {};
  const status = (x, lastUpdated = null) => ({
    ok: !!(x && x.ok),
    lastUpdated,
    syncedAt: (x && x.fetchedAt) || null,
    ...(x && x.note ? { note: x.note } : null),
  });
  const pub = buildPublication({
    records: index.recalls,
    sources: {
      fda: status(s.fda, s.fda && s.fda.lastUpdated),
      fsis: status(s.fsis),
      cpsc: status(s.cpsc),
      fdaAnnouncements: status(s.fdaAnnouncements),
    },
    classifierVersion: COMMITTED_CLASSIFIER_VERSION,
    // Anchored to the build, not the request: every instance must agree on
    // which records are "latest", or their hashes would disagree.
    anchor: index.builtAt || new Date(0).toISOString(),
  });
  committed = { index, pub, byKey: new Map(pub.chunks.map((c) => [c.key, c])) };
  return committed;
}

async function fromPostgres(part, key) {
  const db = await sharedDb();
  if (!db) return null;
  if (part === "manifest") {
    const [row] = await db.query(`select body from published where key = 'manifest'`);
    return row ? { manifestBody: row.body } : null; // configured, never published: fall back
  }
  const [has] = await db.query(`select 1 as ok from published where key = 'manifest'`);
  if (!has) return null;
  const [row] = await db.query(`select hash, body from published where key = $1`, [`chunk:${key}`]);
  return { chunk: row || null };
}

function send(res, status, cache, source, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Yanked-Data", source);
  return res.status(status).send(typeof body === "string" ? body : JSON.stringify(body));
}

export default async function handler(req, res) {
  const q = req.query || {};
  const part = String(q.part || "");
  const key = String(q.key || "");
  const h = String(q.h || "");
  if (part !== "manifest" && part !== "chunk") {
    return send(res, 400, "no-store", "none", { error: "part must be manifest or chunk" });
  }
  if (part === "chunk" && (!KEY_RE.test(key) || !HASH_RE.test(h))) {
    return send(res, 400, "no-store", "none", { error: "chunk needs key=latest|YYYY-MM and h=<16 hex>" });
  }

  let pg = null;
  try {
    pg = await fromPostgres(part, key);
  } catch (err) {
    console.error(`api/data: database unavailable, serving the committed index — ${(err && err.message) || err}`);
  }

  if (pg) {
    if (part === "manifest") return send(res, 200, MANIFEST_CACHE, "postgres", pg.manifestBody);
    if (!pg.chunk) return send(res, 404, SHORT, "postgres", { error: "unknown chunk" });
    if (pg.chunk.hash !== h) return send(res, 404, SHORT, "postgres", { error: "stale", current: pg.chunk.hash });
    return send(res, 200, IMMUTABLE, "postgres", pg.chunk.body);
  }

  const c = await fromCommittedIndex();
  if (!c) return send(res, 503, "no-store", "none", { error: "no recall data available" });
  if (part === "manifest") return send(res, 200, MANIFEST_CACHE, "committed-index", c.pub.manifestBody);
  const chunk = c.byKey.get(key);
  if (!chunk) return send(res, 404, SHORT, "committed-index", { error: "unknown chunk" });
  if (chunk.hash !== h) return send(res, 404, SHORT, "committed-index", { error: "stale", current: chunk.hash });
  return send(res, 200, IMMUTABLE, "committed-index", chunk.body);
}

export const config = { maxDuration: 15 };
