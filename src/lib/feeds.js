/* The government feed endpoints, and how to ask them for data.
 *
 * The request path identifies the app honestly. That is a deliberate default
 * and not a finding: see DIAG_HEADER_SETS below for what is actually known
 * about USDA's 403, which is less than earlier versions of this file claimed.
 * Volume is trivial either way — one cached call per state per 15 minutes.
 */
export const FEED_HEADERS = {
  "User-Agent": "Yanked/1.0 (public recall aggregator; +https://yanked.app)",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* USDA's documented Recall API.
 *
 * The URL is right — it is the one published at
 * fsis.usda.gov/science-data/developer-resources/recall-api, and it takes no
 * API key: it is served off the agency's own web host, not from behind
 * api.data.gov, so there is no credential a 403 could be asking for.
 * (origin-www is dropped: it resolved to nothing and only ever timed out.)
 *
 * WHY it 403s is genuinely not established — see DIAG_HEADER_SETS. What is
 * established is that the app should not depend on the answer: the data is
 * fetched from three places that fail independently. A cron warms a Blob copy
 * off the request path (api/refresh-feeds.js); the request path falls back to
 * it; the browser retries from the user's own network, where the block may not
 * apply (fsisFromBrowser in sources.js); and underneath all of it sits a
 * snapshot committed by a GitHub Action from a completely different network,
 * which is the only tier that cannot be blocked by anything USDA decides about
 * this deployment.
 */
export const FSIS_ENDPOINTS = [
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
];

/** What the request path actually sends. One honest identification, and
 *  nothing else — see DIAG_HEADER_SETS below for why this is still a list. */
export const FSIS_HEADER_SETS = [["honest", FEED_HEADERS]];

/* ─────────────────────────────────────────────────────────────────────────
 * THE VARIANTS, FOR DIAGNOSIS ONLY
 *
 * This repository has believed two contradictory things about the 403, and
 * changed the code for each:
 *
 *   852c7d0  "FSIS sits behind a WAF that rejects clients without a browser
 *             user agent" — added browser-like headers, and the commit title
 *             says it fixed the 403.
 *   4c0676c  "That is an IP and TLS fingerprint decision, not a header one" —
 *             removed those headers and deleted the header matrix as useless.
 *
 * Neither commit recorded a measurement, and no public bug report anywhere
 * corroborates either story. So the second theory currently governs the code,
 * having overturned a change that claimed to fix the exact same symptom — and
 * if the first theory was right, the second one re-broke it.
 *
 * Deleting the matrix removed the only thing that could settle it. It was the
 * right call for the request path, where walking nine combinations in sequence
 * spent most of the function's budget to collect nine identical failures. It
 * was the wrong call for the diagnostic, where the combinations run in
 * parallel, latency is the point, and one request answers the question.
 *
 * So it lives here, reachable only from /api/diag, and the request path still
 * sends exactly one honest header set. Nothing here is adopted automatically:
 * if the browser variant turns out to be the one that works, whether to
 * present a Chrome handshake to a government API is a decision for a person,
 * not a fallback for a retry loop to take on its own.
 * ───────────────────────────────────────────────────────────────────────── */
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const DIAG_HEADER_SETS = [
  // What we send today.
  ["honest", FEED_HEADERS],
  // 852c7d0's claim: a browser User-Agent is what the WAF is checking.
  ["browser-ua", { ...FEED_HEADERS, "User-Agent": CHROME_UA }],
  // The same claim, taken further: everything a browser sends, not just the UA.
  ["browser-full", {
    "User-Agent": CHROME_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  }],
  // The control. If a bare request with no identification at all is treated
  // the same as the other three, the header theory is dead and the decision is
  // being made about the caller, not the call.
  ["no-ua", { Accept: "*/*" }],
];

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
