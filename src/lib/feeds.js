/* Shared request headers for the government recall feeds.
 *
 * We identify the app honestly. Impersonating Chrome was tried and does not
 * work: FSIS's WAF decides on IP reputation and TLS fingerprint, and Node's
 * handshake never matches the claimed browser, so the spoof only added a
 * mismatch to score against. Volume is trivial either way — one cached call
 * per state per 15 minutes.
 */
export const FEED_HEADERS = {
  "User-Agent": "Yanked/1.0 (public recall aggregator; +https://yanked.app)",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* One endpoint, one attempt. USDA sits behind a WAF that blocks datacenter
 * egress, and it fingerprints the TLS handshake rather than the User-Agent.
 * Node's handshake never looks like Chrome, so claiming to be Chrome is both a
 * lie and a mismatch the WAF scores against us. The old ladder walked three
 * endpoints x three header sets sequentially to earn nine identical 403s.
 * (origin-www is dropped: it resolved to nothing and only ever timed out.)
 * The browser retries this from the client, where the block may not apply —
 * see fsisFromBrowser in sources.js. */
export const FSIS_ENDPOINTS = [
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
];

/** Still a list so fetchFirstOk's shape is unchanged and a future variant is a
 *  one-line addition; there is only one worth sending today. */
export const FSIS_HEADER_SETS = [["plain", FEED_HEADERS]];

/** Try each endpoint/header pair; resolve with the first JSON body.
 *  `budgetMs` caps the whole walk so a serverless function can't run past its
 *  own maxDuration when several combinations hang. */
export async function fetchFirstOk(urls, headerSets, timeoutMs = 15000, budgetMs = 30000) {
  const attempts = [];
  const deadline = Date.now() + budgetMs;
  for (const url of urls) {
    for (const entry of headerSets) {
      if (Date.now() >= deadline) {
        attempts.push("out of time before trying the rest");
        break;
      }
      const [label, headers] = Array.isArray(entry) ? entry : ["plain", entry];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal });
        const text = await res.text();
        if (res.ok) {
          try { return { data: JSON.parse(text), url, headers: label, attempts }; }
          catch (_) { attempts.push(`${url} (${label}): 200 but not JSON`); }
        } else {
          attempts.push(`${url} (${label}): HTTP ${res.status}`);
        }
      } catch (err) {
        attempts.push(`${url} (${label}): ${err.name === "AbortError" ? "timed out" : err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  const e = new Error(attempts.join("; "));
  e.attempts = attempts;
  throw e;
}
