/* Is this the same firm? Shared by the index build (an announcement is
 * dropped once openFDA has the enforcement record) and the alerts engine (a
 * followed announcement is reported as "FDA has now classified it" when that
 * record appears). One rule in one place, so the two can never disagree
 * about which record replaced which. Pure; runs in node and the browser. */

const FIRM_STOP = new Set(("inc incorporated llc l l c ltd limited co corp corporation company companies " +
  "the and of dba foods food products product brands brand group holdings usa us america american " +
  "international enterprises cooperative coop co-op association").split(" "));

/** Distinctive lower-case tokens of a firm name, for matching an
 *  announcement to its enforcement record. */
export function firmTokens(name) {
  return [...new Set(String(name || "").toLowerCase().replace(/&/g, " ").split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FIRM_STOP.has(w)))];
}

/** Same firm: at least 75% of the shorter name's tokens appear in the longer
 *  one ("Example Sweeteners Producers & Refiners" ~ "... Refiners Cooperative"),
 *  so one shared generic-ish word ("Example") is not enough — and neither is
 *  a shared place name: "Hudson Valley Greens" is not "Hudson Valley
 *  Creamery" (2 of 3). A false match here HIDES a recall (the announcement
 *  is dropped as a duplicate), so the rule errs towards keeping both. */
export function sameFirm(a, b) {
  const A = firmTokens(a);
  const B = firmTokens(b);
  if (!A.length || !B.length) return false;
  const [short, long] = A.length <= B.length ? [A, new Set(B)] : [B, new Set(A)];
  /* A name that reduces to one distinctive word ("United Foods" -> united)
   * would otherwise match every firm sharing that word at 1/1 = 100%. One
   * word only identifies a firm when it is all the other name has, too. */
  if (short.length === 1 && long.size > 1) return false;
  const shared = short.filter((w) => long.has(w)).length;
  return shared > 0 && shared / short.length >= 0.75;
}

