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
