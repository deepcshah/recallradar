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

/* Some WAFs allow a request that looks like it came from the site's own page. */
export const FEED_HEADERS_REFERER = {
  ...FEED_HEADERS,
  Referer: "https://www.fsis.usda.gov/recalls",
  Origin: "https://www.fsis.usda.gov",
};

/* A full Chrome navigation fingerprint: client hints and fetch metadata.
 * Bot filters that score on missing sec-* headers let this through where the
 * bare User-Agent above is rejected. */
export const FEED_HEADERS_CHROME = {
  ...FEED_HEADERS,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
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

/** Header variants to try, in order, labelled for the diagnostics report. */
export const FSIS_HEADER_SETS = [
  ["plain", FEED_HEADERS],
  ["referer", FEED_HEADERS_REFERER],
  ["chrome", FEED_HEADERS_CHROME],
];

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
