/* ─────────────────────────────────────────────────────────────────────────
 * THE ON-DEVICE COPY — a minimal IndexedDB wrapper, no dependencies
 *
 * Two object stores:
 *
 *   meta    small values by key: the last manifest the client applied, when
 *           it last checked, when it last finished a sync
 *   chunks  one row per chunk of the recall database:
 *           { key: "latest" | "YYYY-MM", hash, records, fetchedAt }
 *
 * Every call is wrapped. IndexedDB is missing or refuses to open in private
 * windows, in some embedded webviews and when site data is blocked, and a
 * quota error can arrive on any write. None of that may break the app: the
 * first failure switches this session to an in-memory store, which behaves
 * the same and simply forgets on reload. The sync engine (./data-sync.js)
 * never needs to know which one it got, beyond `kind` for analytics.
 *
 * The interface is the whole contract — `createMemoryStore()` implements it
 * too, and is what scripts/check-client-sync.mjs injects under Node.
 *   getMeta(key) → value | undefined          setMeta(key, value)
 *   getChunk(key) → { key, hash, records, fetchedAt } | undefined
 *   getAllChunks() → [{ key, hash, records, fetchedAt }]
 *   putChunk({ key, hash, records, fetchedAt })   deleteChunk(key)
 *   clear()
 * ───────────────────────────────────────────────────────────────────────── */

const DB_NAME = "yanked-recalls";
const DB_VERSION = 1;
const META = "meta";
const CHUNKS = "chunks";

/** A store that lives for this page only. Same interface as the IndexedDB
 *  one; values are kept by reference, which is fine because the sync engine
 *  never mutates a chunk after handing it over. */
export function createMemoryStore() {
  const meta = new Map();
  const chunks = new Map();
  return {
    kind: "memory",
    async getMeta(key) { return meta.get(key); },
    async setMeta(key, value) { meta.set(key, value); },
    async getChunk(key) { return chunks.get(key); },
    async getAllChunks() { return [...chunks.values()]; },
    async putChunk(row) { chunks.set(row.key, row); },
    async deleteChunk(key) { chunks.delete(key); },
    async clear() { meta.clear(); chunks.clear(); },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("IndexedDB request failed"));
  });
}

function openIdb(idb, name) {
  return new Promise((resolve, reject) => {
    let open;
    try {
      open = idb.open(name, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error("IndexedDB open failed"));
    // Another tab holding an older version open: give up rather than hang.
    open.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/**
 * Open the on-device store. Never rejects: resolves to an IndexedDB-backed
 * store when it can, otherwise to an in-memory one. A store that opened fine
 * but fails later (quota, eviction mid-session) falls over to memory on the
 * first failed call and stays there for the session.
 *
 * @param {object} [o]
 * @param {string} [o.name]       database name (tests)
 * @param {object} [o.indexedDB]  an IDBFactory to use instead of the global
 * @param {number} [o.timeoutMs]  how long opening may take before giving up
 */
export async function openLocalDb({ name = DB_NAME, indexedDB: idbArg, timeoutMs = 3000 } = {}) {
  let idb = idbArg;
  try {
    if (!idb && typeof indexedDB !== "undefined") idb = indexedDB; // eslint-disable-line no-undef
  } catch (_) { idb = null; /* accessing it can throw in sandboxed frames */ }
  if (!idb) return createMemoryStore();

  let db;
  try {
    db = await Promise.race([
      openIdb(idb, name),
      new Promise((_, reject) => setTimeout(() => reject(new Error("IndexedDB open timed out")), timeoutMs)),
    ]);
  } catch (_) {
    return createMemoryStore();
  }

  const memory = createMemoryStore();
  let broken = false;
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const done = (t) => new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = t.onerror = () => reject(t.error || new Error("IndexedDB transaction failed"));
  });

  /* Run against IndexedDB; on any failure, switch to memory for good and run
   * the same call there. Reads after a switch see only what was written
   * since, which the sync engine tolerates (it holds its own copy). */
  async function guard(fn, fallback) {
    if (broken) return fallback();
    try {
      return await fn();
    } catch (_) {
      broken = true;
      try { db.close(); } catch (__) { /* already gone */ }
      api.kind = "memory";
      return fallback();
    }
  }

  const api = {
    kind: "indexeddb",
    getMeta: (key) => guard(() => req(tx(META, "readonly").get(key)), () => memory.getMeta(key)),
    setMeta: (key, value) => guard(async () => {
      const t = db.transaction(META, "readwrite");
      t.objectStore(META).put(value, key);
      await done(t);
    }, () => memory.setMeta(key, value)),
    getChunk: (key) => guard(() => req(tx(CHUNKS, "readonly").get(key)), () => memory.getChunk(key)),
    getAllChunks: () => guard(() => req(tx(CHUNKS, "readonly").getAll()), () => memory.getAllChunks()),
    putChunk: (row) => guard(async () => {
      const t = db.transaction(CHUNKS, "readwrite");
      t.objectStore(CHUNKS).put(row);
      await done(t);
    }, () => memory.putChunk(row)),
    deleteChunk: (key) => guard(async () => {
      const t = db.transaction(CHUNKS, "readwrite");
      t.objectStore(CHUNKS).delete(key);
      await done(t);
    }, () => memory.deleteChunk(key)),
    clear: () => guard(async () => {
      const t = db.transaction([META, CHUNKS], "readwrite");
      t.objectStore(META).clear();
      t.objectStore(CHUNKS).clear();
      await done(t);
    }, () => memory.clear()),
  };
  return api;
}
