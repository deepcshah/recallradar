/* ─────────────────────────────────────────────────────────────────────────
 * "GET HELP" — which recalls the assistant offers which tasks
 *
 * Two tasks, both run server-side by api/_lib/assist.js:
 *
 *   next   what to do with the one you own: the remedy the notice offers
 *          (refund, replacement, repair kit), how to claim it, who to
 *          contact, and how to dispose of it safely.
 *   alts   something else to buy that does the same job, not itself under
 *          a recall.
 *
 * "Something like it" is a question about objects. A recalled bath seat or
 * space heater has a like-for-like replacement worth finding; a recalled lot
 * of romaine has "buy a different bag", which needs no assistant, and a
 * recalled medicine or medical device has "ask your pharmacist or doctor",
 * which an assistant must not answer. So `alts` is consumer products only
 * (CPSC), and `next` is consumer products and medical devices, where the
 * remedy is a process (a firmware update, a return) rather than "throw it
 * out". Food and drug notices keep the plain What to do steps.
 *
 * Pure, so the sheet and the serverless function agree on what is offered.
 * ───────────────────────────────────────────────────────────────────────── */

export const ASSIST_TASKS = ["next", "alts"];

/** The tasks offered for one recall, in display order. */
export function assistTasksFor(recall) {
  const r = recall || {};
  if (r.status === "announced" || r.announcement === true) return [];
  const src = String(r.source || "");
  if (src === "CPSC") return ["next", "alts"];
  if (src === "FDA Device") return ["next"];
  return [];
}

export function isAssistTask(t) {
  return ASSIST_TASKS.includes(t);
}

/** Only http(s) links ever reach an href — the answer is built from web
 *  pages, and a `javascript:` URL in one must not become a link here. */
export function safeHttpUrl(u) {
  try {
    const url = new URL(String(u || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

/** A shopping search for one suggested item. We link a search, never a
 *  product page the model named: a search can't 404 or point at a listing
 *  that is itself the recalled unit. */
export function shopSearchUrl(query) {
  const q = String(query || "").trim().slice(0, 120);
  return q ? `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}` : "";
}
