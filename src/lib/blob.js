/* Where the Vercel Blob token comes from.
 *
 * `@vercel/blob` reads exactly one environment variable on its own:
 * `BLOB_READ_WRITE_TOKEN`. A Blob store attached with a custom environment
 * prefix — this project uses `RR_BLOB_` — exports
 * `RR_BLOB_READ_WRITE_TOKEN` instead, and the SDK does not look for it.
 *
 * That failure is invisible, which is what makes it worth a module. Every
 * `head`/`put`/`list` call in this app is already wrapped in a catch that
 * treats an error as "not cached yet", because a cold cache is a normal state
 * and must never break a response. So a token the SDK cannot find does not
 * throw anything a user sees: it silently turns every cache into a permanent
 * miss, and the app looks like it simply has no cache. Reading the prefixed
 * name here — and passing it explicitly to every call — is the whole fix.
 *
 * The unprefixed name is still honoured as a fallback so a store attached
 * with Vercel's default naming keeps working with no code change.
 */

/** The read/write token, or undefined when no Blob store is attached. */
export function blobToken() {
  return process.env.RR_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || undefined;
}

export function blobConfigured() {
  return Boolean(blobToken());
}

/** The env var actually in use, for diagnostics that have to name it. */
export function blobTokenVar() {
  if (process.env.RR_BLOB_READ_WRITE_TOKEN) return "RR_BLOB_READ_WRITE_TOKEN";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "BLOB_READ_WRITE_TOKEN";
  return null;
}

/** Spread into any `@vercel/blob` call so it uses the prefixed token.
 *  Empty when nothing is configured, which leaves the SDK's own behaviour
 *  (and its own error message) untouched. */
export function blobAuth() {
  const token = blobToken();
  return token ? { token } : {};
}

/** The options every write in this app shares, plus auth. */
export function blobPutOptions(extra) {
  return {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 3600,
    ...blobAuth(),
    ...extra,
  };
}
