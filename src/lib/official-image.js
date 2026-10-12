/* The agency's own product photo, or nothing.
 *
 * Only CPSC publishes one today (its Recall API's Images[].URL; slimCpsc keeps
 * the first as `Image`). An image is carried into the index and the recall
 * database only when it is https and served from that agency's own domain —
 * anything else is dropped, never replaced. No stock photos, no category art,
 * no guessing: a recall card with no image says less, and a card with the
 * wrong product's picture says something false.
 *
 * Pure and dependency-free, so the browser can run the same check.
 */
const AGENCY_IMAGE_HOSTS = {
  CPSC: ["cpsc.gov"],
};

/** `url` if it is an https URL on `source`'s own domain (or a subdomain of
 *  it), re-serialized by the URL parser; otherwise null. */
export function officialImage(url, source) {
  const hosts = AGENCY_IMAGE_HOSTS[source];
  if (!hosts || !url) return null;
  let u;
  try {
    u = new URL(String(url).trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith("." + h)) ? u.href : null;
}
