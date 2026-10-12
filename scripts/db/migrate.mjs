/* Apply the recall database's migrations, idempotently.
 *
 *   node scripts/db/migrate.mjs                 against DATABASE_URL
 *   node scripts/db/migrate.mjs --pglite <dir>  against a file-backed PGlite
 *
 * Migration 0001 is db/schema.sql; later ones are db/migrations/NNNN_*.sql,
 * applied in name order. Each runs in its own transaction under an advisory
 * lock (two runners at once queue rather than race) and is recorded in
 * schema_migrations with a checksum. An applied migration whose file has
 * since changed is reported, never re-run: add a new migration instead.
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDb } from "../../src/lib/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK = 7274_2026;

async function migrationFiles() {
  const list = [{ version: "0001_schema", path: resolve(ROOT, "db/schema.sql") }];
  const dir = resolve(ROOT, "db/migrations");
  const names = await readdir(dir).catch(() => []);
  for (const n of names.filter((x) => /^\d{4}_[\w-]+\.sql$/.test(x)).sort()) {
    if (n.startsWith("0001_")) continue;
    list.push({ version: n.replace(/\.sql$/, ""), path: resolve(dir, n) });
  }
  return list;
}

/** @returns {Promise<{applied: string[], skipped: string[], drifted: string[]}>} */
export async function migrate(db, { log = () => {} } = {}) {
  await db.exec(`create table if not exists schema_migrations (
    version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const out = { applied: [], skipped: [], drifted: [] };
  for (const m of await migrationFiles()) {
    const sql = await readFile(m.path, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    await db.tx(async (t) => {
      await t.query("select pg_advisory_xact_lock($1::bigint)", [LOCK]);
      const [row] = await t.query("select checksum from schema_migrations where version = $1", [m.version]);
      if (row) {
        (row.checksum === checksum ? out.skipped : out.drifted).push(m.version);
        return;
      }
      await t.exec(sql);
      await t.query("insert into schema_migrations (version, checksum) values ($1, $2)", [m.version, checksum]);
      out.applied.push(m.version);
    });
  }
  for (const v of out.applied) log(`migrate: applied ${v}`);
  for (const v of out.drifted) log(`migrate: WARNING ${v} was applied from a different file — add a new migration rather than editing an applied one`);
  if (!out.applied.length) log(`migrate: up to date (${out.skipped.length + out.drifted.length} applied)`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--pglite");
  const db = await openDb(i > -1 ? { pglite: process.argv[i + 1] || true } : {});
  try {
    await migrate(db, { log: console.log });
  } catch (err) {
    console.error(`migrate: FAILED — ${(err && err.message) || err}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
