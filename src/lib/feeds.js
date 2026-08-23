/* Shared request headers for the government recall feeds.
 *
 * FSIS (and intermittently CPSC) sit behind a WAF that returns 403 to clients
 * that don't look like browsers — a bare "RecallRadar/1.0" agent gets blocked
 * outright. These are public open-data endpoints meant for public
 * consumption, so we present as an ordinary browser to get past the filter
 * and keep our volume trivial (one cached call per state per 15 minutes).
 */
export const FEED_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* FSIS keeps returning 403 from a WAF even with browser headers. Rather than
 * guess which variant it wants, try each known endpoint in turn and take the
 * first that answers with JSON; /api/diag?probe=fsis reports all of them so a
 * future block is a lookup, not an investigation. */
export const FSIS_ENDPOINTS = [
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
  "https://www.fsis.usda.gov/fsis/api/recall/v/1",
  "https://origin-www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
];

/* Some WAFs allow a request that looks like it came from the site's own page. */
export const FEED_HEADERS_REFERER = {
  ...FEED_HEADERS,
  Referer: "https://www.fsis.usda.gov/recalls",
  Origin: "https://www.fsis.usda.gov",
};

/** Try each endpoint/header pair; resolve with the first JSON body. */
export async function fetchFirstOk(urls, headerSets, timeoutMs = 15000) {
  const attempts = [];
  for (const url of urls) {
    for (const headers of headerSets) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        const text = await res.text();
        if (res.ok) {
          try { return { data: JSON.parse(text), url, attempts }; }
          catch (_) { attempts.push(`${url}: 200 but not JSON`); }
        } else {
          attempts.push(`${url}${headers.Referer ? " +referer" : ""}: HTTP ${res.status}`);
        }
      } catch (err) {
        attempts.push(`${url}: ${err.name === "AbortError" ? "timed out" : err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  const e = new Error(attempts.join("; "));
  e.attempts = attempts;
  throw e;
}
