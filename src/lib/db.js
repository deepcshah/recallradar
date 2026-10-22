/* The recall database, behind one tiny interface:
 *
 *   { kind, query(sql, params) -> rows[], exec(sql), tx(fn), close() }
 *
 * Two implementations, one SQL dialect:
 *   - `postgres` (porsager) when DATABASE_URL is set — Neon or Supabase in
 *     production, the GitHub Action's sync;
 *   - PGlite (real Postgres in WASM, in-process, optionally file-backed) for
 *     tests and dry runs. It is a devDependency and is imported by a name the
 *     bundler cannot trace, so it never ships inside a Vercel function.
 *
 * Portability rules every caller follows: parameters are $1..$n with an
 * explicit cast where the type matters (`$1::jsonb`, `$2::timestamptz`);
 * bulk writes pass ONE jsonb array and unpack it with jsonb_to_recordset;
 * dates and counts are cast in the SELECT (`::text`, `::int`) because the two
 * drivers parse them differently.
 *
 * Node-only. Import from api/ and scripts/, never from client code.
 */

function rowsOf(r) {
  return Array.isArray(r) ? [...r] : (r && r.rows) || [];
}

async function openPglite(path) {
  const name = "@electric-sql/pglite"; // not a literal import: keep it out of function bundles
  const { PGlite } = await import(/* @vite-ignore */ name);
  const pg = path ? new PGlite(path) : new PGlite();
  await pg.waitReady;
  const wrap = (c) => ({
    query: async (sql, params = []) => rowsOf(await c.query(sql, params)),
    exec: async (sql) => { await c.exec(sql); },
  });
  return {
    kind: "pglite",
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

async function openPostgres(url) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    // One connection per serverless instance; the sync script asks for more.
    max: Number(process.env.PG_POOL_MAX) || 1,
    // Supabase's transaction pooler (and pgbouncer generally) cannot hold
    // named prepared statements across transactions.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    // The portability rule above passes JSON already stringified
    // (`JSON.stringify(rows)` into `$1::jsonb`). postgres.js's built-in json
    // serializer stringifies again, so Postgres received one quoted string
    // and jsonb_to_recordset failed with "on a non-array" — PGlite, used by
    // the dry runs, doesn't, which is how it passed there. Strings go
    // through as they are; anything else is stringified once.
    types: {
      json: {
        to: 114,
        from: [114, 3802],
        serialize: (x) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x) => JSON.parse(x),
      },
    },
  });
  const wrap = (c) => ({
    query: async (s, params = []) => rowsOf(await c.unsafe(s, params)),
    exec: async (s) => { await c.unsafe(s); },
  });
  return {
    kind: "postgres",
    ...wrap(sql),
    tx: (fn) => sql.begin((t) => fn(wrap(t))),
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.url]      Postgres connection string (default DATABASE_URL)
 * @param {string|true} [opts.pglite]  PGlite: a directory path, or true for in-memory
 */
export async function openDb({ url = process.env.DATABASE_URL, pglite } = {}) {
  if (pglite) return openPglite(pglite === true ? null : pglite);
  if (url) return openPostgres(url);
  throw new Error("no database: DATABASE_URL is not set and no PGlite path was given");
}

/* One connection for the life of a warm serverless instance. */
let shared = null;
let injected = null;

/** The database the API functions read, or null when none is configured
 *  (DATABASE_URL unset) — callers then serve the committed index. */
export async function sharedDb() {
  if (injected) return injected;
  if (!process.env.DATABASE_URL) return null;
  if (!shared) shared = openDb().catch((err) => { shared = null; throw err; });
  return shared;
}

/** Test hook: make sharedDb() return `db` (a PGlite adapter) until called
 *  again with null — how scripts/check-db.mjs exercises the Postgres path of
 *  api/data.js without a DATABASE_URL. */
export function setDbForTests(db) {
  injected = db || null;
}
