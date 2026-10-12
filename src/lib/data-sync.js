/* ─────────────────────────────────────────────────────────────────────────
 * DATA SYNC — one local copy of the recall database, kept current
 *
 * Every list in the app (Latest recalls, search, the full Recalls view and
 * its filters, the store matching, the Alerts inbox, a shared ?r= link) reads
 * ONE dataset: the records this module holds. They used to come from five
 * paths that disagreed — a static index file, a live per-state API, a live
 * national API, a live lookup and direct browser calls to the agencies.
 *
 * The server publishes the database as a manifest plus content-hashed chunks
 * (see the CONTRACT below). The client:
 *
 *   1. start    reads the manifest + chunks it stored last time (IndexedDB,
 *               ./local-db.js) and emits them at once — instant render, and
 *               it works offline.
 *   2. check    GET /api/data?part=manifest with `cache: "no-cache"`, so the
 *               browser and the CDN revalidate instead of serving a stale
 *               copy. Each chunk's hash is compared with the stored one.
 *   3. fetch    changed chunks only. `latest` first, emitted the moment it
 *               lands (the home list is built from it); then the other
 *               changed months in the background, newest first, a few at a
 *               time. Chunk URLs carry `&h=<hash>`, so they are immutable and
 *               cacheable forever. Chunks no longer in the manifest are
 *               dropped. A 404 `{error:"stale"}` (the hash moved on between
 *               the manifest and the chunk) refetches the manifest once.
 *   4. again    when the tab becomes visible and the last check is older
 *               than five minutes; never more often than once a minute.
 *
 * Failures never clear data: a failed check or chunk keeps what is held and
 * says so in `status` ('offline' when the network is gone, 'error' when the
 * server answered badly). One sync runs at a time; `stop()` aborts it.
 *
 * CONTRACT (format 1)
 *   GET /api/data?part=manifest →
 *     { format: 1, generatedAt, dataVersion, classifierVersion,
 *       sources: { fda|fsis|cpsc|fdaAnnouncements:
 *                  { ok, count, lastUpdated, newestPosted, syncedAt } },
 *       chunks: [ { key: "latest"|"YYYY-MM", from, to, count, hash, bytes }, … newest first ],
 *       totals: { recalls, active } }
 *   GET /api/data?part=chunk&key=K&h=H → { format: 1, key, hash, records: [IndexRecord…] }
 *     404 { error: "stale", current } when H is not the chunk's current hash.
 *   IndexRecord is the public/feeds/index.json `recalls[]` entry shape.
 * ───────────────────────────────────────────────────────────────────────── */
import { openLocalDb } from "./local-db.js";

export const RECHECK_AFTER_MS = 5 * 60 * 1000;
export const MIN_INTERVAL_MS = 60 * 1000;
const CONCURRENCY = 3;
const EMIT_COALESCE_MS = 250;
const TIMEOUT_MS = 20000;

/** Thrown for an HTTP answer we can act on (status attached). */
class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function isAbort(err) {
  return !!err && (err.name === "AbortError" || err.aborted === true);
}

/** `latest` first, then months newest first — the manifest's own order,
 *  enforced rather than trusted. */
export function chunkOrder(a, b) {
  if (a.key === b.key) return 0;
  if (a.key === "latest") return -1;
  if (b.key === "latest") return 1;
  return String(b.key).localeCompare(String(a.key));
}

function validManifest(m) {
  return !!m && m.format === 1 && Array.isArray(m.chunks) &&
    m.chunks.every((c) => c && typeof c.key === "string" && typeof c.hash === "string");
}

/**
 * Create a sync engine. Pure JS: no React, no DOM required (it attaches a
 * visibility listener only when `document` exists), so it runs under Node.
 *
 * @param {object}   [o]
 * @param {string}   [o.base]        endpoint ("/api/data")
 * @param {Function} [o.fetch]       fetch implementation
 * @param {object|Promise} [o.storage] a local-db store; default openLocalDb()
 * @param {Function} [o.now]         clock (tests)
 * @param {number}   [o.concurrency] background chunk fetches at once
 * @param {Function} [o.onEvent]     (name, props) => void — analytics hook
 * @param {boolean}  [o.listen]      attach visibility/online listeners (default true)
 */
export function createDataSync({
  base = "/api/data",
  fetch: fetchArg,
  storage,
  now = () => Date.now(),
  concurrency = CONCURRENCY,
  onEvent,
  listen = true,
} = {}) {
  const fetchImpl = fetchArg || ((...a) => globalThis.fetch(...a));
  let storePromise = null;
  const store = () => (storePromise ||= Promise.resolve(storage || openLocalDb()).catch(() => null));

  /* What is held: chunk key → { key, hash, records, fetchedAt }. `held` is
   * the applied set; during a sync, chunks being replaced keep their old copy
   * here until the new one lands, so nothing blinks out mid-update. */
  const held = new Map();
  let manifest = null;

  let state = {
    status: "empty",
    records: [],
    byId: new Map(),
    manifest: null,
    sources: null,
    lastChecked: null,
    lastSynced: null,
    error: null,
    pending: 0,       // background chunks still to fetch in this sync
    partial: false,   // only the stored `latest` has been read back so far
    dataset: null,    // { recalls, sources, generatedAt } — the search engine keys on this object
    storage: null,    // 'indexeddb' | 'memory', once known
  };
  const listeners = new Set();

  function emit(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners) {
      try { fn(state); } catch (_) { /* a listener must not break the sync */ }
    }
  }

  /** Union of held chunks, de-duplicated by id. Chunks in the current
   *  manifest come first in manifest order (latest, then newest month), so a
   *  record that moved between chunks takes its newest copy. */
  function rebuild() {
    const order = manifest ? manifest.chunks.map((c) => c.key) : [];
    const keys = [...order.filter((k) => held.has(k)), ...[...held.keys()].filter((k) => !order.includes(k)).sort().reverse()];
    const byId = new Map();
    const records = [];
    for (const k of keys) {
      const rows = (held.get(k) && held.get(k).records) || [];
      for (const r of rows) {
        if (!r || !r.id || byId.has(r.id)) continue;
        byId.set(r.id, r);
        records.push(r);
      }
    }
    const sources = (manifest && manifest.sources) || null;
    return {
      records,
      byId,
      manifest,
      sources,
      dataset: records.length ? { recalls: records, sources: sources || {}, generatedAt: manifest && manifest.generatedAt } : null,
    };
  }

  // ── start: the stored copy first ───────────────────────────────────────
  let started = null;
  async function loadLocal() {
    const db = await store();
    emit({ storage: db ? db.kind : "none" });
    if (!db) return;
    try {
      /* `latest` alone first: it is all the home list needs, and it is a
       * fraction of the bytes, so a return visit paints before the months
       * have been read back. */
      const [m, first, checked, synced] = await Promise.all([
        db.getMeta("manifest"), db.getChunk ? db.getChunk("latest") : null, db.getMeta("lastChecked"), db.getMeta("lastSynced"),
      ]);
      if (validManifest(m)) manifest = m;
      const times = {
        lastChecked: Number.isFinite(checked) ? checked : null,
        lastSynced: Number.isFinite(synced) ? synced : null,
      };
      if (first && Array.isArray(first.records)) {
        held.set("latest", first);
        emit({ ...rebuild(), status: "cached", partial: true, ...times });
      }
      const rows = await db.getAllChunks();
      for (const row of rows || []) {
        if (row && row.key && Array.isArray(row.records)) held.set(row.key, row);
      }
      const built = rebuild();
      emit({ ...built, status: built.records.length ? "cached" : "empty", partial: false, ...times });
    } catch (_) { /* a corrupt store is an empty one */ }
  }

  // ── network ────────────────────────────────────────────────────────────
  async function getJson(url, signal, opts = {}) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { ...opts, signal: ctrl.signal, headers: { Accept: "application/json" } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
      if (!res.ok) throw new HttpError(res.status, body);
      if (!body) throw new HttpError(res.status, null);
      return { body, bytes: text.length };
    } catch (err) {
      if (signal && signal.aborted) { const e = new Error("aborted"); e.aborted = true; throw e; }
      if (isAbort(err)) throw new Error("timed out");
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  const manifestUrl = () => `${base}?part=manifest`;
  const chunkUrl = (c) => `${base}?part=chunk&key=${encodeURIComponent(c.key)}&h=${encodeURIComponent(c.hash)}`;

  // ── one sync ───────────────────────────────────────────────────────────
  let inflight = null;
  let controller = null;
  let lastAttempt = 0;

  async function runSync(signal) {
    const t0 = now();
    const fromCache = state.records.length > 0;
    const stats = { chunks: 0, bytes: 0, keys: [] };
    const db = await store();
    let stalesLeft = 1;
    emit({ status: "syncing", error: null });

    const fetchManifest = async () => {
      const { body, bytes } = await getJson(manifestUrl(), signal, { cache: "no-cache" });
      stats.bytes += bytes;
      if (!validManifest(body)) throw new Error("bad manifest");
      return body;
    };

    let next;
    try {
      next = await fetchManifest();
    } catch (err) {
      if (err && err.aborted) throw err;
      const offline = !(err instanceof HttpError) || (typeof navigator !== "undefined" && navigator.onLine === false);
      const checkedAt = now();
      emit({ status: offline ? "offline" : "error", error: String((err && err.message) || err), lastChecked: checkedAt });
      onEvent && onEvent("data_sync", { status: offline ? "offline" : "error", chunks_fetched: 0, bytes: stats.bytes, ms: now() - t0, from_cache: fromCache });
      return state;
    }

    const checkedAt = now();
    manifest = next;
    if (db) { db.setMeta("lastChecked", checkedAt).catch(() => {}); }

    // What changed, and the order to fetch it in.
    const plan = () => manifest.chunks
      .filter((c) => !held.has(c.key) || held.get(c.key).hash !== c.hash)
      .sort(chunkOrder);

    let todo = plan();
    emit({ ...rebuild(), lastChecked: checkedAt, pending: todo.length });

    const failures = [];

    /** Fetch one chunk; on a stale 404, refetch the manifest once and
     *  retry with the hash it now names. Returns false when it gave up. */
    async function fetchChunk(c) {
      let target = c;
      for (;;) {
        try {
          const { body, bytes } = await getJson(chunkUrl(target), signal);
          if (!body || body.key !== target.key || !Array.isArray(body.records)) throw new Error("bad chunk");
          stats.chunks += 1;
          stats.bytes += bytes;
          stats.keys.push(target.key);
          const row = { key: target.key, hash: body.hash || target.hash, records: body.records, fetchedAt: now() };
          held.set(row.key, row);
          if (db) await db.putChunk(row).catch(() => {});
          return true;
        } catch (err) {
          if (err && err.aborted) throw err;
          if (err instanceof HttpError && err.status === 404 && stalesLeft > 0) {
            stalesLeft -= 1;
            try {
              manifest = await fetchManifest();
            } catch (e2) {
              if (e2 && e2.aborted) throw e2;
              failures.push(target.key);
              return false;
            }
            const fresh = manifest.chunks.find((x) => x.key === target.key);
            if (!fresh) return true; // the chunk is gone from the manifest: nothing to fetch
            if (held.has(fresh.key) && held.get(fresh.key).hash === fresh.hash) return true;
            target = fresh;
            continue;
          }
          failures.push(target.key);
          return false;
        }
      }
    }

    // `latest` alone, first, and shown the moment it lands.
    const latest = todo.find((c) => c.key === "latest");
    if (latest) {
      await fetchChunk(latest);
      todo = plan().filter((c) => c.key !== "latest" && !failures.includes(c.key));
      emit({ ...rebuild(), pending: todo.length, status: "syncing" });
    }

    // The rest in the background, newest first, a few at a time. Emits are
    // coalesced: every emit rebuilds the union and re-renders the app.
    let emitTimer = null;
    const scheduleEmit = () => {
      if (emitTimer) return;
      emitTimer = setTimeout(() => {
        emitTimer = null;
        if (!signal.aborted) emit({ ...rebuild(), pending: Math.max(0, queue.length + active) });
      }, EMIT_COALESCE_MS);
    };
    const queue = todo.filter((c) => c.key !== "latest");
    let active = 0;
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        // The manifest may have moved on (a stale 404 elsewhere): fetch what it names now.
        const cur = manifest.chunks.find((x) => x.key === c.key);
        if (!cur || (held.has(cur.key) && held.get(cur.key).hash === cur.hash)) continue;
        active += 1;
        try { await fetchChunk(cur); } finally { active -= 1; }
        scheduleEmit();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    } finally {
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    }

    // Drop chunks the manifest no longer lists.
    const keep = new Set(manifest.chunks.map((c) => c.key));
    for (const k of [...held.keys()]) {
      if (keep.has(k)) continue;
      held.delete(k);
      if (db) await db.deleteChunk(k).catch(() => {});
    }

    const ok = failures.length === 0;
    const syncedAt = now();
    if (db) {
      await db.setMeta("manifest", manifest).catch(() => {});
      if (ok) await db.setMeta("lastSynced", syncedAt).catch(() => {});
    }
    const status = ok ? "ready" : "error";
    emit({
      ...rebuild(),
      status,
      pending: 0,
      error: ok ? null : `couldn't fetch ${failures.join(", ")}`,
      ...(ok ? { lastSynced: syncedAt } : null),
    });
    onEvent && onEvent("data_sync", {
      status, chunks_fetched: stats.chunks, bytes: stats.bytes, ms: now() - t0, from_cache: fromCache,
    });
    lastResult = { ...stats, failures };
    return state;
  }

  let lastResult = null;

  /**
   * Check for new data. Returns the in-flight sync if one is running. Without
   * `force`, does nothing when the last attempt was under a minute ago.
   */
  function sync({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && lastAttempt && now() - lastAttempt < MIN_INTERVAL_MS) return Promise.resolve(state);
    lastAttempt = now();
    controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const signal = controller ? controller.signal : { aborted: false, addEventListener() {}, removeEventListener() {} };
    inflight = (async () => {
      await (started || Promise.resolve());
      return runSync(signal);
    })()
      .catch((err) => {
        // Unexpected failure: keep every record held, just say so.
        if (!(err && err.aborted)) emit({ status: "error", error: String((err && err.message) || err) });
        return state;
      })
      .finally(() => { inflight = null; controller = null; });
    return inflight;
  }

  // ── when to check again ────────────────────────────────────────────────
  const onVisible = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    const last = state.lastChecked || 0;
    if (now() - last >= RECHECK_AFTER_MS) sync();
  };
  const onOnline = () => { if (state.status === "offline") sync(); };

  function start() {
    if (!started) {
      started = loadLocal();
      if (listen && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
      if (listen && typeof window !== "undefined") window.addEventListener("online", onOnline);
      started.then(() => sync({ force: true }));
    }
    return started;
  }

  function stop() {
    if (controller) controller.abort();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  }

  return {
    start,
    sync,
    stop,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Stats of the last completed sync (tests). */
    lastResult: () => lastResult,
    /** Settles when the stored copy has been read (tests). */
    ready: () => started || Promise.resolve(),
  };
}

// ── the app's one instance ───────────────────────────────────────────────
let shared = null;
let sharedOnEvent = null;

/** The page-wide sync engine, created and started on first use. Passing
 *  `onEvent` (App passes analytics' `track`) sets where its events go. */
export function recallData({ onEvent } = {}) {
  if (onEvent) sharedOnEvent = onEvent;
  if (!shared) {
    shared = createDataSync({ onEvent: (...a) => sharedOnEvent && sharedOnEvent(...a) });
    shared.start();
  }
  return shared;
}
