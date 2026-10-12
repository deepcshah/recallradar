/* The national recall index, read from the server.
 *
 * `public/feeds/index.json` is built by scripts/build-index.mjs on the GitHub
 * runner and committed, so it ships inside the deployment exactly like the
 * FSIS and CPSC snapshots — and it is read the same way src/lib/snapshot.js
 * reads those: off disk first (vercel.json's `includeFiles: public/feeds/**`
 * puts it in every function bundle), then off this deployment's own CDN if
 * the bundler ever stops shipping it. The functions that need it — share
 * cards, the push digest — want one recall by id or a list by state, and
 * neither is worth a request to three agencies when the answer is already
 * sitting in the bundle.
 *
 * Node-only — it touches `node:fs`. Import it from `api/`, never from
 * anything the Vite client build can reach; the browser has
 * src/lib/search-index.js.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/feeds/index.json");

/* A warm function instance serves many requests from one deployment, and the
 * file cannot change underneath it — a new index means a new deployment. So
 * the parse is kept for the life of the instance, with a TTL only so a
 * CDN-fallback read (the one path that could in principle be stale) is
 * retried rather than trusted forever. */
const MEMO_MS = 10 * 60 * 1000;
let memo = null; // { at, index }
const byId = new WeakMap(); // index -> Map(id -> record)

async function fromDisk() {
  return JSON.parse(await readFile(INDEX_PATH, "utf8"));
}

async function fromOwnCdn() {
  const host = process.env.VERCEL_URL;
  if (!host) throw new Error("not on Vercel (no VERCEL_URL)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://${host}/feeds/index.json`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw err && err.name === "AbortError" ? new Error("timed out") : err;
  } finally {
    clearTimeout(timer);
  }
}

/** The committed national index, or null when no readable copy exists (the
 *  normal state before the workflow has run once). Never throws.
 *  @returns {Promise<{builtAt:string, sources:object, lookbackDays:number, recalls:object[]}|null>}
 */
export async function readIndex() {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.index;
  for (const load of [fromDisk, fromOwnCdn]) {
    try {
      const index = await load();
      if (index && Array.isArray(index.recalls)) {
        memo = { at: Date.now(), index };
        return index;
      }
    } catch (_) { /* try the next way in */ }
  }
  return null;
}

/** One record by id, or null. The lookup table is built once per index. */
export function findRecall(index, id) {
  if (!index || !Array.isArray(index.recalls) || !id) return null;
  let map = byId.get(index);
  if (!map) {
    map = new Map(index.recalls.map((r) => [r.id, r]));
    byId.set(index, map);
  }
  return map.get(String(id)) || null;
}

/** Test hook: serve `index` from readIndex() until called again with null.
 *  scripts/check-alerts.mjs uses it to run the alert crons against a
 *  SYNTHETIC index (obviously fake "Example … Co." records), so a logic test
 *  can never be mistaken for a claim about what is in the real data. */
export function setIndexForTests(index) {
  memo = index ? { at: Number.MAX_SAFE_INTEGER / 2, index } : null;
}
