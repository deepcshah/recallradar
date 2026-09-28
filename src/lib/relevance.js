/* Relevance for free-text recall search — /api/lookup's openFDA path and the
 * national index search in RecallSearch alike.
 *
 * openFDA answers a text query with every notice whose analysed text contains
 * the word, sorted by whatever we ask for (report date here — its documented
 * query syntax has no field boosts, and a date sort would override them
 * anyway). A generic word like "sugar" therefore matches every cookie, sauce
 * and cereal whose ingredient list mentions sugar, and the newest of those
 * crowd out the sugar recall someone read about. So the ranking is done here,
 * on what openFDA returned, in three tiers:
 *
 *   3  the phrase is in the firm name, or in the first 80 characters of the
 *      product description (where the product is named)
 *   2  every query word starts a word in the firm, the product (before any
 *      "Ingredients:" list) or the reason
 *   1  anything else — in practice, a mention inside an ingredient list
 *
 * Tier 1 is dropped whenever anything ranks higher: a notice that merely
 * lists sugar as an ingredient is not an answer to "sugar" when a notice
 * about sugar exists. When nothing ranks higher it is kept — a weak answer
 * beats silence. Ties go to the newest report.
 *
 * Pure, and free of node APIs: the browser bundle and scripts/check-data.mjs
 * both import it (api/_lib/lookup-rank.js re-exports it for the server).
 */

const INGREDIENTS_RE = /\bingredients?\s*:/i;

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(q) {
  return String(q || "").toLowerCase().split(/[^a-z0-9&']+/).filter((w) => w.length >= 2);
}

/** 1–3, as above. `m` is a /api/lookup match ({product, firm, reason}). */
export function relevanceOf(m, q) {
  const query = String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!query) return 1;
  const firm = String(m.firm || "").toLowerCase();
  const product = String(m.product || "");
  const cut = product.search(INGREDIENTS_RE);
  const head = (cut === -1 ? product : product.slice(0, cut)).toLowerCase();
  const reason = String(m.reason || "").toLowerCase();

  const phrase = new RegExp(`(^|[^a-z0-9])${esc(query)}`, "i");
  if (phrase.test(firm) || phrase.test(head.slice(0, 80))) return 3;

  const terms = words(query);
  const strong = `${firm} \n ${head} \n ${reason}`;
  if (terms.length && terms.every((t) => new RegExp(`(^|[^a-z0-9])${esc(t)}`).test(strong))) return 2;
  return 1;
}

/** Rank, drop ingredient-only matches when better ones exist, and report how
 *  many were dropped. Matches keep every field they had and gain `relevance`.
 *  @returns {{ ranked: object[], dropped: number }} */
export function rankMatches(matches, q) {
  const scored = (matches || []).map((m) => ({ ...m, relevance: relevanceOf(m, q) }));
  const best = scored.reduce((n, m) => Math.max(n, m.relevance), 0);
  const kept = best >= 2 ? scored.filter((m) => m.relevance >= 2) : scored;
  kept.sort((a, b) => b.relevance - a.relevance || String(b.reportDate).localeCompare(String(a.reportDate)));
  return { ranked: kept, dropped: scored.length - kept.length };
}
