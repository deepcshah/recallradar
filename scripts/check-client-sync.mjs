/* Client sync checks, offline.
 *
 *   node scripts/check-client-sync.mjs
 *
 * Runs the browser's sync engine (src/lib/data-sync.js) against a local HTTP
 * server that speaks the /api/data CONTRACT (see the top of data-sync.js).
 *
 * WHAT IT SERVES. Every record is REAL: the committed national index,
 * public/feeds/index.json, regrouped into the contract's chunks by
 * `buildContract` below — "latest" is the last 30 days by newsDay
 * (the later of posted and date), each older record goes to its YYYY-MM month, every
 * record in exactly one chunk. The manifest's `sources` are the index's own.
 * When a check needs a chunk to change, the same real records are re-chunked
 * (one record moved to a neighbouring month, or one month's records put in a
 * different order); nothing is invented. These are contract-shaped responses
 * built from the real committed index — NOT the real /api/data endpoint,
 * whose cache headers and database can only be checked once it is deployed.
 *
 * Storage is the in-memory store from src/lib/local-db.js (Node has no
 * IndexedDB, and fake-indexeddb is not a dependency), injected so that two
 * engines sharing one store stand in for a page and its reload.
 *
 * Exits 1 on the first failed assertion. Writes nothing.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { createDataSync } from "../src/lib/data-sync.js";
import { createMemoryStore } from "../src/lib/local-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;

// ───────────────────────────────────────────── the contract, from real data
/* digest.js newsDay: the later of `posted` and `date` (src/lib/publication.js, the server's builder, uses the same rule). */
const newsDayOf = (r) => {
  const a = String(r.date || "").slice(0, 10);
  const b = String(r.posted || "").slice(0, 10);
  return b > a ? b : a;
};
const hashOf = (records) => createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16);

/** Group real index records into the contract's chunks.
 *  @param {object} index      public/feeds/index.json
 *  @param {object} [o]
 *  @param {number} [o.now]    the "today" latest is measured from (default: index.builtAt)
 *  @param {Function} [o.chunkOf] override which chunk a record goes in (re-chunking checks)
 *  @param {Function} [o.order]   (key, records) => records, reorder a chunk (re-chunking checks) */
export function buildContract(index, { now = Date.parse(index.builtAt), chunkOf, order } = {}) {
  const cutoff = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
  const defaultChunk = (r) => (newsDayOf(r) >= cutoff ? "latest" : newsDayOf(r).slice(0, 7) || "undated");
  const groups = new Map();
  for (const r of index.recalls) {
    const k = (chunkOf && chunkOf(r)) || defaultChunk(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "latest" ? -1 : b === "latest" ? 1 : b.localeCompare(a)));
  const chunks = {};
  const meta = [];
  for (const key of keys) {
    let records = groups.get(key).slice().sort((a, b) => newsDayOf(b).localeCompare(newsDayOf(a)) || String(a.id).localeCompare(String(b.id)));
    if (order) records = order(key, records);
    const hash = hashOf(records);
    const body = JSON.stringify({ format: 1, key, hash, records });
    const days = records.map(newsDayOf).filter(Boolean).sort();
    chunks[key] = { hash, body };
    meta.push({ key, from: days[0] || null, to: days[days.length - 1] || null, count: records.length, hash, bytes: body.length });
  }
  const s = index.sources || {};
  const src = (x) => (x ? { ok: !!x.ok, count: x.count ?? null, lastUpdated: x.lastUpdated || null, newestPosted: x.newest || null, syncedAt: x.fetchedAt || null } : null);
  const manifest = {
    format: 1,
    generatedAt: index.builtAt,
    dataVersion: hashOf(meta.map((c) => c.hash)),
    classifierVersion: "index-json",
    sources: { fda: src(s.fda), fsis: src(s.fsis), cpsc: src(s.cpsc), fdaAnnouncements: src(s.fdaAnnouncements) },
    chunks: meta,
    totals: { recalls: index.recalls.length, active: index.recalls.filter((r) => r.status !== "ended").length },
  };
  return { manifest, chunks, manifestBody: JSON.stringify(manifest) };
}

/** A node:http server for one contract. `set(contract)` swaps what it serves;
 *  `staleOnce(contract)` makes the NEXT manifest request answer with an older
 *  manifest while chunks answer from the current one. */
export function contractServer(initial) {
  let current = initial;
  let staleManifest = null;
  const log = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const part = u.searchParams.get("part");
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body);
    };
    if (u.pathname !== "/api/data") return send(404, JSON.stringify({ error: "not found" }));
    if (part === "manifest") {
      log.push({ part: "manifest" });
      const body = staleManifest ? staleManifest.manifestBody : current.manifestBody;
      staleManifest = null;
      return send(200, body, { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" });
    }
    if (part === "chunk") {
      const key = u.searchParams.get("key");
      const h = u.searchParams.get("h");
      log.push({ part: "chunk", key, h });
      const c = current.chunks[key];
      if (!c) return send(404, JSON.stringify({ error: "stale", current: null }));
      if (c.hash !== h) return send(404, JSON.stringify({ error: "stale", current: c.hash }));
      return send(200, c.body, { "Cache-Control": "public, max-age=31536000, immutable" });
    }
    return send(400, JSON.stringify({ error: "bad part" }));
  });
  return {
    server,
    log,
    set(c) { current = c; },
    staleOnce(c) { staleManifest = c; },
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ───────────────────────────────────────────────────────────── the checks
async function main() {
  const index = JSON.parse(await readFile(resolve(HERE, "../public/feeds/index.json"), "utf8"));
  let n = 0;
  const check = async (label, fn) => { await fn(); n++; console.log(`  ok  ${label}`); };

  const v1 = buildContract(index);
  const srv = contractServer(v1);
  const port = await srv.listen();
  const base = `http://127.0.0.1:${port}/api/data`;
  const storage = createMemoryStore();

  /* Every request the engine makes, in the order it makes them — the server
   * log would order concurrent requests by arrival instead. */
  let requests = [];
  let failNetwork = false;
  const fetchSpy = (url, opts) => {
    const u = new URL(url);
    requests.push({ part: u.searchParams.get("part"), key: u.searchParams.get("key"), cache: opts && opts.cache });
    if (failNetwork) return Promise.reject(new TypeError("fetch failed"));
    return fetch(url, opts);
  };
  let clock = Date.parse("2026-10-12T12:00:00Z");
  const engine = (events) => createDataSync({
    base, fetch: fetchSpy, storage, now: () => clock, listen: false,
    onEvent: (name, props) => events && events.push({ name, ...props }),
  });
  const chunkReqs = () => requests.filter((r) => r.part === "chunk").map((r) => r.key);

  console.log("\n0. the contract built from public/feeds/index.json");
  await check(`every one of ${index.recalls.length} real records is in exactly one chunk`, () => {
    const ids = Object.values(v1.chunks).flatMap((c) => JSON.parse(c.body).records.map((r) => r.id));
    assert.equal(ids.length, index.recalls.length);
    assert.equal(new Set(ids).size, index.recalls.length);
    assert.equal(v1.manifest.chunks[0].key, "latest");
    console.log(`      chunks: ${v1.manifest.chunks.map((c) => `${c.key}(${c.count})`).join(" ")}`);
  });

  console.log("\n1. first sync: empty device");
  const ev1 = [];
  const e1 = engine(ev1);
  const seen = [];
  e1.subscribe((s) => seen.push({ status: s.status, n: s.records.length }));
  await e1.start();
  assert.equal(e1.getState().status, "empty");
  await e1.sync();
  await check("manifest fetched with cache: no-cache (so the CDN/browser revalidate)", () => {
    assert.equal(requests[0].part, "manifest");
    assert.equal(requests[0].cache, "no-cache");
  });
  await check("every chunk fetched, latest first, then months newest first", () => {
    const keys = chunkReqs();
    assert.equal(keys.length, v1.manifest.chunks.length);
    assert.equal(keys[0], "latest");
    const months = keys.slice(1);
    assert.deepEqual(months, [...months].sort().reverse());
  });
  await check("latest was emitted on its own before the background months landed", () => {
    const latestCount = v1.manifest.chunks[0].count;
    assert.ok(seen.some((s) => s.status === "syncing" && s.n === latestCount), JSON.stringify(seen.slice(0, 6)));
  });
  await check("ready, with the union of all chunks de-duplicated by id", () => {
    const s = e1.getState();
    assert.equal(s.status, "ready");
    assert.equal(s.records.length, index.recalls.length);
    assert.equal(s.byId.size, index.recalls.length);
    assert.ok(s.byId.get("fda-food-H-1391-2026"), "the real United Sugar record is there");
    assert.equal(s.sources.fda.lastUpdated, index.sources.fda.lastUpdated);
  });
  await check("data_sync event: status, chunks, bytes, ms, from_cache — no PII", () => {
    const e = ev1.find((x) => x.name === "data_sync");
    assert.deepEqual(Object.keys(e).sort(), ["bytes", "chunks_fetched", "from_cache", "ms", "name", "status"]);
    assert.equal(e.chunks_fetched, v1.manifest.chunks.length);
    assert.equal(e.from_cache, false);
    assert.ok(e.bytes > 1_000_000);
    console.log(`      ${JSON.stringify(e)}`);
  });

  console.log("\n2. a reload: the stored copy first, then an unchanged manifest");
  requests = [];
  failNetwork = true; // nothing may reach the network before the stored copy shows
  const ev2 = [];
  const e2 = engine(ev2);
  await e2.ready();
  await e2.start();
  await check("records come from storage before any network answer", () => {
    const s = e2.getState();
    assert.equal(s.status, "cached");
    assert.equal(s.records.length, index.recalls.length);
  });
  await e2.sync(); // the start() sync, which fails: network is down
  failNetwork = false;
  requests = [];
  clock += 61_000;
  await e2.sync();
  await check("unchanged manifest → 0 chunks fetched", () => {
    assert.deepEqual(chunkReqs(), []);
    assert.equal(requests.filter((r) => r.part === "manifest").length, 1);
    assert.equal(e2.getState().status, "ready");
    assert.equal(e2.lastResult().chunks, 0);
    assert.equal(ev2.at(-1).from_cache, true);
  });
  await check("a second sync within a minute is not sent at all", async () => {
    requests = [];
    clock += 10_000;
    await e2.sync();
    assert.equal(requests.length, 0);
  });

  console.log("\n3. one chunk changes (same real records, re-chunked)");
  const months = v1.manifest.chunks.filter((c) => c.key !== "latest").map((c) => c.key);
  const target = months[2];
  const v2 = buildContract(index, { order: (key, recs) => (key === target ? recs.slice().reverse() : recs) });
  srv.set(v2);
  requests = [];
  clock += 61_000;
  await e2.sync();
  await check(`only ${target} is fetched when only its content changed`, () => {
    assert.deepEqual(chunkReqs(), [target]);
    assert.equal(e2.getState().records.length, index.recalls.length);
  });

  const mover = JSON.parse(v2.chunks[months[0]].body).records[0];
  const into = months[1];
  const v3 = buildContract(index, {
    order: (key, recs) => (key === target ? recs.slice().reverse() : recs),
    chunkOf: (r) => (r.id === mover.id ? into : null),
  });
  srv.set(v3);
  requests = [];
  clock += 61_000;
  await e2.sync();
  await check(`one real record (${mover.id}) moved ${months[0]} → ${into}: exactly those two chunks fetched, record kept once`, () => {
    assert.deepEqual(chunkReqs().sort(), [months[0], into].sort());
    const s = e2.getState();
    assert.equal(s.records.length, index.recalls.length);
    assert.equal(s.records.filter((r) => r.id === mover.id).length, 1);
  });

  console.log("\n4. a stale chunk hash (the database moved on between manifest and chunk)");
  /* Built on v3's chunking, so "latest" is the only chunk that differs. */
  const v3opts = {
    chunkOf: (r) => (r.id === mover.id ? into : null),
    order: (key, recs) => (key === target ? recs.slice().reverse() : recs),
  };
  const withLatest = (fn) => ({ ...v3opts, order: (key, recs) => (key === "latest" ? fn(recs) : v3opts.order(key, recs)) });
  const v4 = buildContract(index, withLatest((recs) => recs.slice().reverse()));
  srv.set(v4);
  // The engine is told about a newer "latest" (v4) …
  const v5 = buildContract(index, withLatest((recs) => recs.slice(1).concat(recs.slice(0, 1))));
  srv.staleOnce(v4); // … but by the time it asks for the chunk, v5 is current.
  srv.set(v5);
  requests = [];
  clock += 61_000;
  await e2.sync();
  await check("404 stale → manifest refetched once → the current chunk fetched", () => {
    assert.equal(requests.filter((r) => r.part === "manifest").length, 2);
    assert.deepEqual(chunkReqs(), ["latest", "latest"]);
    const s = e2.getState();
    assert.equal(s.status, "ready");
    assert.equal(s.manifest.chunks[0].hash, v5.manifest.chunks[0].hash);
    assert.equal(s.records.length, index.recalls.length);
  });

  console.log("\n5. network failure");
  failNetwork = true;
  requests = [];
  clock += 61_000;
  await e2.sync();
  await check("status 'offline', every cached record kept", () => {
    const s = e2.getState();
    assert.equal(s.status, "offline");
    assert.equal(s.records.length, index.recalls.length);
  });
  failNetwork = false;

  await check("a chunk that fails mid-sync keeps the old copy and reports 'error'", async () => {
    const v6 = buildContract(index, { ...v3opts, order: (key, recs) => (key === months[3] ? recs.slice().reverse() : v3opts.order(key, recs)) });
    srv.set(v6);
    const brokenFetch = (url, opts) => (String(url).includes(`key=${months[3]}`) ? Promise.reject(new TypeError("fetch failed")) : fetchSpy(url, opts));
    const e3 = createDataSync({ base, fetch: brokenFetch, storage, now: () => clock, listen: false });
    await e3.start();
    await e3.sync();
    const s = e3.getState();
    assert.equal(s.status, "error");
    assert.equal(s.records.length, index.recalls.length);
  });

  await check("a server that drops a chunk from the manifest: the client drops it too", async () => {
    const without = { ...index, recalls: index.recalls.filter((r) => newsDayOf(r).slice(0, 7) !== months.at(-1)) };
    const v7 = buildContract(without);
    srv.set(v7);
    clock += 61_000;
    await e2.sync({ force: true });
    const s = e2.getState();
    assert.equal(s.records.length, without.recalls.length);
    assert.ok(!(await storage.getAllChunks()).some((c) => c.key === months.at(-1)));
  });

  await srv.close();
  console.log(`\n${n} client sync checks passed (real records from public/feeds/index.json, contract-shaped; not the deployed /api/data).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
