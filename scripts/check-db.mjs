/* The recall database, checked offline against REAL data only.
 *
 *   node scripts/check-db.mjs
 *
 * Runs the migrations and the whole sync (ingest -> raw -> canonical -> index
 * -> publish) into in-memory PGlite — real Postgres, in WASM — from:
 *   - the committed snapshots in public/feeds/ (real agency records fetched by
 *     the refresh workflow; the FDA records are the ones inside index.json),
 *   - an OLDER committed fsis.json from git history (real USDA data as it was
 *     on an earlier day) to exercise change tracking,
 *   - scripts/fixtures/openfda-food-2026-09-23.json (real openFDA records,
 *     verbatim) to exercise the live openFDA format end to end.
 * No record here is invented. The only synthetic values are a few labelled
 * URL strings for the image validator, which tests a pure function.
 *
 * What it cannot check: whether the agencies answer, and whether a real
 * Postgres (Neon/Supabase) behaves like PGlite. The first is the GitHub
 * Action's pull_request dry run; the second is the first sync against the
 * owner's DATABASE_URL.
 *
 * Exits 1 on the first failed assertion.
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { openDb, setDbForTests } from "../src/lib/db.js";
import { migrate } from "./db/migrate.mjs";
import { runSync } from "./sync/pipeline.mjs";
import { CLASSIFIER_VERSION } from "./sync/derive.mjs";
import { fdaToIndex, CAP_TIERS } from "./build-index.mjs";
import { PUBLISH_CAPS, sha16, newsDayOf, FORMAT } from "../src/lib/publication.js";
import { officialImage } from "../src/lib/official-image.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (p) => JSON.parse(await readFile(resolve(ROOT, p), "utf8"));

let n = 0;
async function check(label, fn) {
  await fn();
  n++;
  console.log(`  ok  ${label}`);
}
const show = (label, v) => console.log(`      ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const quiet = () => {};

const NOW = new Date();
const index = await readJson("public/feeds/index.json");
const fsisSnap = await readJson("public/feeds/fsis.json");
const cpscSnap = await readJson("public/feeds/cpsc.json");
const fdaFixture = await readJson("scripts/fixtures/openfda-food-2026-09-23.json");
const isFda = (r) => /^FDA (Food|Drug|Device)$/.test(r.source);
const SNAP_COUNTS = {
  fda: index.recalls.filter(isFda).length,
  fsis: fsisSnap.notices.length,
  cpsc: cpscSnap.notices.length,
  announcements: index.recalls.filter((r) => r.source === "FDA announcement").length,
};

const counts = async (db, table, col = "source") =>
  Object.fromEntries((await db.query(`select ${col} as k, count(*)::int as n from ${table} group by 1`)).map((r) => [r.k, r.n]));
const chunkHashes = (pub) => Object.fromEntries(pub.manifest.chunks.map((c) => [c.key, c.hash]));
const allRecords = (pub) => pub.chunks.flatMap((c) => JSON.parse(c.body).records.map((r) => ({ ...r, _chunk: c.key })));

// ─────────────────────────────────────────── 1. schema
console.log("\n1. migrations into a fresh PGlite (Postgres 18, WASM)");
const db = await openDb({ pglite: true });
await check("schema applied once; a second run applies nothing", async () => {
  const first = await migrate(db);
  const again = await migrate(db);
  assert.deepEqual(first.applied, ["0001_schema"]);
  assert.deepEqual(again.applied, []);
  const tables = (await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' order by 1`)).map((r) => r.table_name);
  show("tables", tables);
  for (const t of ["schema_migrations", "raw_records", "recalls", "recall_changes", "recall_index", "sync_runs", "published"]) {
    assert.ok(tables.includes(t), t);
  }
});

// ─────────────────────────────────────────── 2. from the committed snapshots
console.log("\n2. --from-snapshots: the committed real snapshots");
show("snapshot counts", SNAP_COUNTS);
const run1 = await runSync({ db, fromSnapshots: true, dryRun: true, now: NOW, log: quiet });
show("run 1", run1.results.map((r) => `${r.source}: ${r.mode} fetched ${r.fetched}, raw new ${r.raw_new}, inserted ${r.inserted}`));
await check("every source ok; raw rows and canonical recalls per source equal the snapshot counts", async () => {
  assert.ok(run1.results.every((r) => r.ok), JSON.stringify(run1.results.map((r) => r.error)));
  assert.deepEqual(await counts(db, "raw_records"), SNAP_COUNTS);
  assert.deepEqual(await counts(db, "recalls", "feed"), SNAP_COUNTS);
  const [{ n: idx }] = await db.query(`select count(*)::int as n from recall_index where classifier_version = $1::int`, [CLASSIFIER_VERSION]);
  assert.equal(idx, Object.values(SNAP_COUNTS).reduce((a, b) => a + b, 0));
});
await check("raw payloads are stored as received (a USDA and a CPSC notice, byte-equal after sorting keys)", async () => {
  const f = fsisSnap.notices[0];
  const [row] = await db.query(`select payload from raw_records where source = 'fsis' and source_key = $1`, [`fsis-${f.field_recall_number}`]);
  assert.deepEqual(row.payload, f);
  const c = cpscSnap.notices[0];
  const [row2] = await db.query(`select payload from raw_records where source = 'cpsc' and source_key = $1`, [`cpsc-${c.RecallID}`]);
  assert.deepEqual(row2.payload, c);
});
await check("the real United Sugar recalls (H-1391/H-1392-2026) are in recalls and published", async () => {
  const recs = allRecords(run1.published);
  for (const id of ["fda-food-H-1391-2026", "fda-food-H-1392-2026"]) {
    const r = recs.find((x) => x.id === id);
    assert.ok(r, id);
    assert.match(r.firm, /United Sugar/);
  }
});
await check("published FDA records are identical to the committed index's (same records, same shape, same classification)", async () => {
  const byId = new Map(index.recalls.map((r) => [r.id, r]));
  const fda = allRecords(run1.published).filter(isFda);
  assert.ok(fda.length > 0.95 * SNAP_COUNTS.fda); // the rest fell out of the 365-day window since the index was built
  for (const { _chunk, ...r } of fda) assert.deepEqual(r, byId.get(r.id), r.id);
});

// ─────────────────────────────────────────── 3. contract
console.log("\n3. manifest and chunks against the contract");
const ALLOWED = new Set(["id", "source", "product", "firm", "reason", "classification", "severity", "date", "posted", "status",
  "endDate", "distribution", "states", "coverage", "category", "reasonKey", "url", "upcs", "announcement", "image"]);
const REQUIRED = ["id", "source", "product", "firm", "reason", "classification", "severity", "date", "status",
  "distribution", "states", "coverage", "category", "reasonKey", "url"];
function validate(pub, label) {
  const m = pub.manifest;
  assert.equal(m.format, FORMAT);
  assert.ok(!Number.isNaN(Date.parse(m.generatedAt)));
  assert.equal(typeof m.classifierVersion, "number");
  for (const k of ["fda", "fsis", "cpsc", "fdaAnnouncements"]) {
    for (const f of ["ok", "count", "lastUpdated", "newestPosted", "syncedAt"]) assert.ok(f in m.sources[k], `${label} sources.${k}.${f}`);
  }
  assert.equal(m.chunks[0].key, "latest");
  const months = m.chunks.slice(1).map((c) => c.key);
  assert.deepEqual(months, [...months].sort().reverse());
  assert.ok(months.every((k) => /^\d{4}-\d{2}$/.test(k)));
  assert.equal(m.dataVersion, sha16(m.chunks.map((c) => `${c.key}:${c.hash}`).join("\n")));
  const seen = new Set();
  let active = 0;
  for (const c of pub.chunks) {
    const body = JSON.parse(c.body);
    const entry = m.chunks.find((x) => x.key === c.key);
    assert.deepEqual(Object.keys(body), ["format", "key", "hash", "records"]);
    assert.equal(body.format, FORMAT);
    assert.equal(body.key, c.key);
    assert.equal(body.hash, entry.hash);
    assert.equal(entry.hash, sha16(JSON.stringify(body.records)));
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
    assert.equal(entry.bytes, Buffer.byteLength(c.body));
    assert.equal(entry.count, body.records.length);
    for (const r of body.records) {
      assert.ok(!seen.has(r.id), `${r.id} in two chunks`);
      seen.add(r.id);
      for (const k of Object.keys(r)) assert.ok(ALLOWED.has(k), `${label}: unexpected field ${k}`);
      for (const k of REQUIRED) assert.ok(k in r, `${label}: ${r.id} lacks ${k}`);
      const nd = newsDayOf(r);
      assert.ok(nd >= entry.from && nd <= entry.to, `${r.id} news day ${nd} outside ${entry.key} ${entry.from}..${entry.to}`);
      if (r.image) assert.equal(officialImage(r.image, r.source), r.image);
      if (r.status === "active") active++;
    }
  }
  assert.equal(seen.size, m.totals.recalls);
  assert.equal(active, m.totals.active);
}
await check("database publication: format, ordering, one chunk per record, windows, hashes, bytes, record shape", () =>
  validate(run1.published, "postgres"));
show("chunks", run1.published.manifest.chunks.map((c) => `${c.key}:${c.count}:${(c.bytes / 1024).toFixed(0)}KB`).join(" "));
await check("PUBLISH_CAPS is build-index's loosest cap tier", () => assert.deepEqual(PUBLISH_CAPS, CAP_TIERS[0]));
await check("CPSC images: every published one is https on cpsc.gov; the validator drops anything else (synthetic URL strings)", () => {
  const cpsc = allRecords(run1.published).filter((r) => r.source === "CPSC");
  show("CPSC records with an agency image", `${cpsc.filter((r) => r.image).length} of ${cpsc.length}`);
  assert.ok(cpsc.filter((r) => r.image).length > 0);
  assert.ok(allRecords(run1.published).every((r) => !r.image || r.source === "CPSC"));
  assert.equal(officialImage("http://www.cpsc.gov/x.png", "CPSC"), null);
  assert.equal(officialImage("https://cpsc.gov.example.com/x.png", "CPSC"), null);
  assert.equal(officialImage("https://example.com/x.png", "CPSC"), null);
  assert.equal(officialImage("https://www.cpsc.gov/x.png", "USDA FSIS"), null);
  assert.equal(officialImage("https://www.cpsc.gov/s3fs-public/x.png", "CPSC"), "https://www.cpsc.gov/s3fs-public/x.png");
});

// ─────────────────────────────────────────── 4. idempotent
console.log("\n4. the same snapshots again");
const run2 = await runSync({ db, fromSnapshots: true, dryRun: true, now: NOW, log: quiet });
await check("0 raw_new, 0 inserted, 0 updated, 0 changes; every chunk unchanged with the same hash", async () => {
  for (const r of run2.results) {
    assert.equal(r.raw_new, 0, r.source);
    assert.equal(r.inserted, 0, r.source);
    assert.equal(r.updated, 0, r.source);
    assert.equal(r.changes, 0, r.source);
    assert.equal(r.unchanged, SNAP_COUNTS[r.source], r.source);
  }
  assert.equal(run2.derived.derived, 0);
  assert.equal(run2.published.written, 0);
  assert.deepEqual(chunkHashes(run2.published), chunkHashes(run1.published));
  assert.equal(run2.published.manifest.dataVersion, run1.published.manifest.dataVersion);
  assert.deepEqual(await counts(db, "raw_records"), SNAP_COUNTS);
});

// ─────────────────────────────────────────── 5. history: a real older USDA snapshot
console.log("\n5. recall_changes from a real older fsis.json in git history");
let older = null;
try {
  const revs = execFileSync("git", ["log", "--format=%h", "--", "public/feeds/fsis.json"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const cur = new Map(fsisSnap.notices.map((x) => [x.field_recall_number, JSON.stringify(x.field_states)]));
  for (const rev of revs) {
    const snap = JSON.parse(execFileSync("git", ["show", `${rev}:public/feeds/fsis.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }));
    const moved = (snap.notices || []).filter((x) => cur.has(x.field_recall_number) && cur.get(x.field_recall_number) !== JSON.stringify(x.field_states));
    if (moved.length) { older = { rev, snap, moved }; break; }
  }
} catch (err) {
  console.log(`      (git history unavailable: ${err.message})`);
}
if (!older) {
  console.log("  SKIPPED  no older committed fsis.json with a changed record was found in git history");
} else {
  const dir = await mkdtemp(join(tmpdir(), "yanked-check-db-"));
  const oldPath = join(dir, "fsis.json");
  await writeFile(oldPath, JSON.stringify(older.snap));
  show("older snapshot", `${older.rev}, fetched ${older.snap.fetchedAt}; states differ for ${older.moved.map((x) => x.field_recall_number).join(", ")}`);
  const before = allRecords(run2.published);
  const run3 = await runSync({ db, sources: ["fsis"], fromSnapshots: true, snapshotPaths: { fsis: oldPath }, dryRun: true, now: NOW, log: quiet });
  const changes = await db.query(`select recall_id, field, old, new from recall_changes order by id`);
  show("run 3 (older)", `raw new ${run3.results[0].raw_new}, inserted ${run3.results[0].inserted}, updated ${run3.results[0].updated}, changes ${changes.length}`);
  show("changes", changes.slice(0, 6).map((c) => `${c.recall_id} ${c.field}: ${JSON.stringify(c.old)} -> ${JSON.stringify(c.new)}`));
  await check("the older real payloads become new raw versions; the record's states change is recorded", async () => {
    assert.ok(run3.results[0].ok);
    assert.ok(run3.results[0].raw_new > 0);
    for (const m of older.moved) {
      const id = `fsis-${m.field_recall_number}`;
      const [{ n: versions }] = await db.query(`select count(*)::int as n from raw_records where source_key = $1`, [id]);
      assert.equal(versions, 2, id);
      assert.ok(changes.some((c) => c.recall_id === id && c.field === "states"), `${id} states change`);
    }
  });
  await check("only the chunks holding a record that changed get a new hash", () => {
    const after = allRecords(run3.published);
    const sig = (recs) => new Map(recs.map(({ _chunk, ...r }) => [r.id, { chunk: _chunk, json: JSON.stringify(r) }]));
    const b = sig(before);
    const a = sig(after);
    const affected = new Set();
    for (const id of new Set([...b.keys(), ...a.keys()])) {
      const x = b.get(id);
      const y = a.get(id);
      if (!x || !y || x.json !== y.json || x.chunk !== y.chunk) {
        if (x) affected.add(x.chunk);
        if (y) affected.add(y.chunk);
      }
    }
    const h1 = chunkHashes(run2.published);
    const h2 = chunkHashes(run3.published);
    const moved = new Set(Object.keys({ ...h1, ...h2 }).filter((k) => h1[k] !== h2[k]));
    show("chunks with changed records", [...affected]);
    show("chunks with new hashes", [...moved]);
    assert.ok(affected.size > 0);
    assert.deepEqual([...moved].sort(), [...affected].sort());
    assert.equal(run3.published.written, moved.size - [...moved].filter((k) => !h2[k]).length);
  });
  const run4 = await runSync({ db, sources: ["fsis"], fromSnapshots: true, dryRun: true, now: NOW, log: quiet });
  await check("re-ingesting the current snapshot records the change back and restores every chunk hash", async () => {
    assert.equal(run4.results[0].raw_new, 0); // both versions are already stored
    assert.ok(run4.results[0].updated > 0);
    const [{ n }] = await db.query(`select count(*)::int as n from recall_changes where sync_run_id = $1::bigint`, [run4.results[0].runId]);
    assert.ok(n > 0);
    assert.deepEqual(chunkHashes(run4.published), chunkHashes(run1.published));
  });
  await rm(dir, { recursive: true, force: true });
}

// ─────────────────────────────────────────── 6. classifier version
console.log("\n6. bumping the classifier version re-derives the index and nothing else");
const fingerprint = async () => ({
  raw: (await db.query(`select md5(string_agg(id::text || payload_hash || last_seen::text, ',' order by id)) as h from raw_records`))[0].h,
  recalls: (await db.query(`select md5(string_agg(id || content_hash || raw_hash || updated_at::text, ',' order by id)) as h from recalls`))[0].h,
});
const fp1 = await fingerprint();
const [{ n: recallCount }] = await db.query(`select count(*)::int as n from recalls`);
const bumped = await runSync({ db, reindexOnly: true, classifierVersion: CLASSIFIER_VERSION + 1, now: NOW, log: quiet });
await check("every recall re-derived at v+1, old rows removed, raw_records and recalls untouched, nothing fetched", async () => {
  assert.equal(bumped.results.length, 0);
  assert.equal(bumped.derived.derived, recallCount);
  assert.equal(bumped.derived.removed, recallCount);
  const versions = await db.query(`select classifier_version as v, count(*)::int as n from recall_index group by 1`);
  assert.deepEqual(versions, [{ v: CLASSIFIER_VERSION + 1, n: recallCount }]);
  assert.deepEqual(await fingerprint(), fp1);
  assert.equal(bumped.published.manifest.classifierVersion, CLASSIFIER_VERSION + 1);
  // Same classifier code, so the same records: no chunk changes.
  assert.deepEqual(chunkHashes(bumped.published), chunkHashes(run1.published));
});
await runSync({ db, reindexOnly: true, now: NOW, log: quiet }); // back to the real version

// ─────────────────────────────────────────── 7. /api/data, both modes
console.log("\n7. /api/data");
const { default: data } = await import("../api/data.js");
const { resolveRecall } = await import("../api/_lib/resolve-recall.js");
function call(query) {
  return new Promise((done) => {
    const headers = {};
    const res = {
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      send(b) { done({ code: this.code, headers, body: JSON.parse(b), raw: b }); },
    };
    data({ query }, res);
  });
}
delete process.env.DATABASE_URL;
const published = (await db.query(`select key, hash, body from published`));
const pgManifest = JSON.parse(published.find((r) => r.key === "manifest").body);
setDbForTests(db);
await check("postgres mode (PGlite injected): manifest + chunks served verbatim from `published` with the contract's headers", async () => {
  const m = await call({ part: "manifest" });
  assert.equal(m.code, 200);
  assert.equal(m.headers["x-yanked-data"], "postgres");
  assert.equal(m.headers["cache-control"], "public, s-maxage=300, stale-while-revalidate=86400");
  assert.deepEqual(m.body, pgManifest);
  const latest = m.body.chunks[0];
  const c = await call({ part: "chunk", key: latest.key, h: latest.hash });
  assert.equal(c.code, 200);
  assert.equal(c.headers["cache-control"], "public, max-age=31536000, s-maxage=31536000, immutable");
  assert.equal(c.raw, published.find((r) => r.key === "chunk:latest").body);
  const stale = await call({ part: "chunk", key: latest.key, h: "0000000000000000" });
  assert.equal(stale.code, 404);
  assert.deepEqual(stale.body, { error: "stale", current: latest.hash });
  assert.match(stale.headers["cache-control"], /s-maxage=60/);
  assert.equal((await call({ part: "chunk", key: "1999-01", h: latest.hash })).code, 404);
  assert.equal((await call({ part: "chunk", key: "../x", h: latest.hash })).code, 400);
  assert.equal((await call({ part: "nope" })).code, 400);
});
await check("share links resolve from the database first", async () => {
  const got = await resolveRecall("fda-food-H-1391-2026");
  assert.equal(got.from, "database");
  assert.match(got.record.firm, /United Sugar/);
  assert.deepEqual(got.record, allRecords(run1.published).map(({ _chunk, ...r }) => r).find((r) => r.id === "fda-food-H-1391-2026"));
});
const empty = await openDb({ pglite: true });
const nothing = await runSync({ db: empty, reindexOnly: true, now: NOW, log: quiet });
setDbForTests(empty);
await check("an empty sync publishes nothing (never a hole); that database's /api/data falls back to the committed index", async () => {
  assert.equal(nothing.published.skipped, "nothing to publish");
  assert.equal((await empty.query(`select count(*)::int as n from published`))[0].n, 0);
  const m = await call({ part: "manifest" });
  assert.equal(m.code, 200);
  assert.equal(m.headers["x-yanked-data"], "committed-index");
});
await empty.close();
setDbForTests(null);
await check("committed-index mode (no DATABASE_URL): same format from public/feeds/index.json, every record served once", async () => {
  const m = await call({ part: "manifest" });
  assert.equal(m.code, 200);
  assert.equal(m.headers["x-yanked-data"], "committed-index");
  const chunks = [];
  for (const e of m.body.chunks) {
    const c = await call({ part: "chunk", key: e.key, h: e.hash });
    assert.equal(c.code, 200, e.key);
    assert.equal(c.headers["x-yanked-data"], "committed-index");
    assert.equal(c.headers["cache-control"], "public, max-age=31536000, s-maxage=31536000, immutable");
    chunks.push({ key: e.key, body: c.raw });
  }
  validate({ manifest: m.body, chunks }, "committed-index");
  const ids = chunks.flatMap((c) => JSON.parse(c.body).records.map((r) => r.id)).sort();
  assert.deepEqual(ids, index.recalls.map((r) => r.id).sort());
  assert.equal(m.body.sources.fda.lastUpdated, index.sources.fda.lastUpdated);
  const again = await call({ part: "manifest" });
  assert.equal(again.raw, m.raw); // memoized and deterministic: every instance agrees on hashes
  const stale = await call({ part: "chunk", key: "latest", h: "0000000000000000" });
  assert.equal(stale.code, 404);
  assert.equal(stale.body.error, "stale");
  show("committed-index manifest", { chunks: m.body.chunks.length, totals: m.body.totals, generatedAt: m.body.generatedAt });
});
await db.close();

// ─────────────────────────────────────────── 8. the live openFDA format, with real recorded records
console.log("\n8. openFDA's own format end to end (real records: scripts/fixtures/openfda-food-2026-09-23.json)");
const fdb = await openDb({ pglite: true });
const fx = await runSync({ db: fdb, sources: ["fda"], fdaRaw: { food: fdaFixture }, dryRun: true, now: NOW, log: quiet });
await check("raw stored verbatim; published records equal fdaToIndex at the loosest tier; meta.last_updated carried", async () => {
  assert.ok(fx.results[0].ok, fx.results[0].error);
  assert.equal(fx.results[0].upstreamLastUpdated, "2026-09-23");
  assert.equal(fx.published.manifest.sources.fda.lastUpdated, "2026-09-23");
  const recs = allRecords(fx.published);
  assert.equal(recs.length, fdaFixture.results.length);
  for (const raw of fdaFixture.results) {
    const expect = fdaToIndex("food", raw, CAP_TIERS[0]);
    const { _chunk, ...got } = recs.find((r) => r.id === expect.id);
    assert.deepEqual(got, expect, expect.id);
    const [row] = await fdb.query(`select payload from raw_records where source_key = $1`, [expect.id]);
    assert.deepEqual(row.payload, raw);
  }
  validate(fx.published, "fixture");
});
await fdb.close();

console.log(`\n${n} database checks passed (real data: committed snapshots, git-history snapshot, recorded openFDA records; PGlite).`);
