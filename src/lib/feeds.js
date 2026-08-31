/* The government feed endpoints, and how to ask them for data.
 *
 * The request path identifies the app honestly. That is a deliberate default
 * and not a finding: see DIAG_HEADER_SETS below for what is actually known
 * about USDA's 403, which is less than earlier versions of this file claimed.
 * Volume is trivial either way — one cached call per state per 15 minutes.
 */
/* Shared Accept headers. The identification lives in FSIS_HEADER_SETS below,
 * because what we may claim to be turns out to be load-bearing. */
const ACCEPT = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* What openFDA and CPSC get: honest identification, which neither objects to. */
export const FEED_HEADERS = {
  "User-Agent": "Yanked/1.0 (public recall aggregator; +https://yanked.app)",
  ...ACCEPT,
};

/* USDA's documented Recall API.
 *
 * The URL is right — it is the one published at
 * fsis.usda.gov/science-data/developer-resources/recall-api, and it takes no
 * API key: it is served off the agency's own web host, not from behind
 * api.data.gov, so there is no credential a 403 could be asking for.
 * (origin-www is dropped: it resolved to nothing and only ever timed out.)
 */
export const FSIS_ENDPOINTS = [
  "https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json",
];

/* ─────────────────────────────────────────────────────────────────────────
 * WHAT WE MAY CLAIM TO BE
 *
 * Measured, finally, rather than assumed. From one laptop, one IP, one
 * sitting:
 *
 *   curl, no headers .......................... 403
 *   curl + Chrome User-Agent .................. 403
 *   curl + full Chrome headers + HTTP/2 ....... 403
 *   browser (and incognito, so not a cookie) .. 200
 *   Node fetch + Chrome User-Agent ............ 200
 *   Node fetch, no headers at all ............. 200
 *   Node fetch + "Yanked/1.0 (+https://...)" .. 403   ← what this app sent
 *
 * Two things fall out. curl is refused whatever it claims, so part of the
 * decision is the TLS/client fingerprint — which Node passes and curl does
 * not. And with the client held fixed at Node, the only difference between
 * 200 and 403 is our own User-Agent string.
 *
 * It is the shape of it. `Name/version (+url)` is the crawler idiom from the
 * robots.txt era, and it is exactly what bot-management products match to
 * classify a self-identified bot — which many deployments then block. The app
 * was refused for identifying honestly, in the format reserved for the kind of
 * client it is not: this is one cached request per state per fifteen minutes
 * against a documented JSON API published for software to consume, not a
 * crawler walking a site.
 *
 * So the answer is to identify, without wearing a crawler's uniform. This
 * ladder is walked in order and stops at the first success. Every rung is
 * true: a bare product token, then no claim at all. There is deliberately no
 * browser rung — impersonating Chrome to a government API would be a lie, and
 * the curl rows above show it does not even work.
 * ───────────────────────────────────────────────────────────────────────── */
export const FSIS_HEADER_SETS = [
  // RFC 9110 §10.1.5's product token, and nothing else. Identifies the
  // software without the parenthetical that reads as "I am a crawler".
  ["product", { "User-Agent": "Yanked/1.0", ...ACCEPT }],
  // No claim of our own; the HTTP client's default applies. Not a disguise —
  // it really is Node — just less informative than we would prefer to be.
  ["default", { ...ACCEPT }],
  // Exactly the request measured at 200 above, with nothing added. The last
  // rung exists so the known-good configuration is always reachable.
  ["bare", {}],
];

/* ─────────────────────────────────────────────────────────────────────────
 * THE VARIANTS, FOR DIAGNOSIS ONLY
 *
 * /api/diag fires all of these in parallel so the same experiment can be run
 * from inside production, where the remaining unknown lives: the laptop above
 * is a residential IP, and whether Vercel's egress carries a second,
 * independent block on top of the User-Agent one has never been measured.
 *
 * Read the result by comparing rows. If "crawler-ua" fails where "product"
 * and "bare" succeed, production matches the laptop and the ladder above is
 * the whole fix. If every row fails including "bare", the User-Agent was only
 * half the story and Vercel's address is refused whatever it sends — in which
 * case no header changes anything, and the committed snapshot is the answer.
 *
 * The browser rows are measurements, not candidates. Nothing here is ever
 * promoted to the request path automatically.
 * ───────────────────────────────────────────────────────────────────────── */
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const DIAG_HEADER_SETS = [
  ...FSIS_HEADER_SETS,
  // The string that was being refused, kept so the finding stays reproducible
  // and a future change of USDA's mind is visible.
  ["crawler-ua", { "User-Agent": "Yanked/1.0 (public recall aggregator; +https://yanked.app)", ...ACCEPT }],
  // Measurement only. If this is the only row that passes, that is a fact
  // worth knowing and still not a thing to ship.
  ["browser-ua", { "User-Agent": CHROME_UA, ...ACCEPT }],
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

/** FSIS, walking the identity ladder and then retrying it.
 *
 *  fetchFirstOk walks FSIS_HEADER_SETS and stops at the first success, so the
 *  usual cost is one request: the honest product token is tried first and
 *  either works or fails fast. The outer loop is for the residue — a timeout,
 *  or a refusal that really is transient — and spaces its attempts rather than
 *  hammering. Two attempts, not three, because each one now walks up to three
 *  rungs and the whole thing has to finish inside the caller's budget.
 *
 *  @returns the raw upstream payload (an array of notices).
 */
export async function fsisFetch({ attempts = 2, timeoutMs = 9000, budgetMs = 34000, gapMs = 1200 } = {}) {
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
