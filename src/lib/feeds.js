/* The government feed endpoints, and how to ask them for data.
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

/* USDA's documented Recall API. This is the right URL — it is the one on
 * fsis.usda.gov/science-data/developer-resources/recall-api, and the reason it
 * so often fails is not the path but the caller: USDA sits behind a WAF that
 * blocks datacenter egress and fingerprints the TLS handshake rather than the
 * User-Agent, so a serverless function gets a 403 where a laptop gets JSON.
 * Node's handshake never looks like Chrome, so claiming to be Chrome is both a
 * lie and a mismatch the WAF scores against us. The old ladder walked three
 * endpoints x three header sets sequentially to earn nine identical 403s.
 * (origin-www is dropped: it resolved to nothing and only ever timed out.)
 *
 * What actually helps is not a different URL, it is not being on the critical
 * path: a cron warms a Blob copy (api/refresh-feeds.js), the request path
 * falls back to it, and the browser retries directly from the user's own
 * network, where the block may not apply — see fsisFromBrowser in sources.js.
 */
export const FSIS_ENDPOINTS = [
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
];

/** Still a list so fetchFirstOk's shape is unchanged and a future variant is a
 *  one-line addition; there is only one worth sending today. */
export const FSIS_HEADER_SETS = [["plain", FEED_HEADERS]];

/** CPSC's documented Recall API, windowed to the recent past.
 *  saferproducts.gov returns the whole window as one uncompressed document,
 *  so the window is also the size control. */
export function cpscUrl(lookbackDays) {
  const start = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  return `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${start}`;
}

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

/** FSIS, retried.
 *
 *  The WAF's refusal is not deterministic — the same request from the same
 *  function succeeds sometimes and 403s the rest of the time. One attempt
 *  therefore under-reports what is reachable, which is how "USDA is down"
 *  became the app's normal state. Spacing a few attempts inside the request's
 *  own budget converts a coin flip into something much closer to a certainty,
 *  and costs nothing on the runs that succeed first time.
 *
 *  @returns the raw upstream payload (an array of notices).
 */
export async function fsisFetch({ attempts = 3, timeoutMs = 9000, budgetMs = 34000, gapMs = 1200 } = {}) {
  const deadline = Date.now() + budgetMs;
  const tried = [];
  for (let i = 0; i < attempts; i++) {
    if (Date.now() + timeoutMs > deadline) { tried.push("out of budget"); break; }
    try {
      const { data } = await fetchFirstOk(
        FSIS_ENDPOINTS, FSIS_HEADER_SETS, timeoutMs, deadline - Date.now());
      return data;
    } catch (err) {
      tried.push(String(err.message || err));
    }
    if (i < attempts - 1 && Date.now() + gapMs < deadline) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  throw new Error(`${tried.length} attempt${tried.length === 1 ? "" : "s"}: ${tried.join(" | ").slice(0, 220)}`);
}
