/* ─────────────────────────────────────────────────────────────────────────
 * SHARING ONE RECALL — a link that carries its own answer
 *
 *   https://yanked.app/r/fsis-024-2026?st=CA
 *
 * A shared recall is read twice: once by a link unfurler (iMessage, Slack,
 * WhatsApp), which sees only /api/share's meta tags and /api/og's card, and
 * once by the person who taps it, who lands in the app with that recall's
 * verdict open (`/?r=<id>&st=<ST>`). The state rides along because the
 * verdict is meaningless without one — "Not reported in California" is the
 * sender's answer, and the card has to say whose answer it is rather than
 * leave a reader in Texas to assume it is theirs.
 *
 * Only the two-letter state travels, never anything finer. That is the same
 * line the analytics draw (see the README): the state is the granularity the
 * feeds are scoped to, and the coarsest thing that still answers the
 * question. A share link is pasted into group chats; it must not be a way to
 * learn where someone lives.
 *
 * `cardVerdict` lives here, not in api/, because three surfaces word the same
 * answer — the share sheet's text, the unfurl's og:description, and the big
 * line on the OG image — and it is pure, so both the browser bundle and the
 * serverless functions can import it. It is a thin layer over verdictFor:
 * the sentence itself is never re-invented here, only shortened where a
 * 1200×630 card cannot hold the long form, and given a line for the one case
 * verdictFor deliberately leaves open (no state was shared).
 * ───────────────────────────────────────────────────────────────────────── */
import { verdictFor, coverageOf, resolveLoc, VERDICTS } from "./verdict.js";

const SITE = "https://yanked.app";

/** The recipient's reading of a two-letter state: upper-cased, and dropped
 *  entirely if it is not a state we know — a bad `st` must degrade to "no
 *  state" rather than into a verdict about somewhere that does not exist. */
export function cleanState(st) {
  const L = resolveLoc(st ? { stateAbbr: String(st).slice(0, 2) } : null);
  return L ? L.stateAbbr : null;
}

function origin() {
  try {
    if (typeof window !== "undefined" && window.location && /^https?:$/.test(window.location.protocol)) {
      return window.location.origin;
    }
  } catch (_) { /* not a browser */ }
  return SITE;
}

/** The public link for one recall, as seen from `stateAbbr`. The path form
 *  (/r/:id) is what the unfurler fetches; vercel.json rewrites it to
 *  /api/share, which answers with meta tags and forwards people to the app. */
export function shareUrl(recall, stateAbbr) {
  const id = recall && recall.id ? String(recall.id) : "";
  if (!id) return origin() + "/";
  const st = cleanState(stateAbbr);
  return `${origin()}/r/${encodeURIComponent(id)}${st ? `?st=${st}` : ""}`;
}

function listShort(states, max = 6) {
  if (!states.length) return "";
  if (states.length <= max) return states.join(", ");
  return `${states.length} states`;
}

/** The verdict as a card can hold it.
 *
 *  { verdict, line, headline, detail, tone, stateAbbr }
 *    line — the big words on the OG image. verdictFor's headline, except:
 *           `unstated` becomes "Region not stated" (the long form wraps to
 *           three lines at card size), and with no state shared the card
 *           states what the notice covers instead of asking the viewer —
 *           who is not the sender — to "add your location".
 *    tone — 'alert' only for a high-severity recall in the sender's area
 *           (nationwide counts: it is in everyone's area); everything else
 *           is 'neutral'. There is no 'ok' tone and never a green: a state
 *           missing from a distribution list is not an all-clear.
 */
export function cardVerdict(recall, stateAbbr) {
  const r = recall || {};
  const st = cleanState(stateAbbr);
  const v = verdictFor(r, st ? { stateAbbr: st } : null);
  const cov = coverageOf(r);
  let line = v.headline;
  let tone = "neutral";

  if (v.verdict === VERDICTS.UNSTATED) line = "Region not stated";
  if (v.verdict === VERDICTS.IN_AREA && r.severity === "high") tone = "alert";
  if (v.verdict === VERDICTS.NEEDS_LOCATION) {
    if (cov.kind === "nationwide") {
      line = "Distributed nationwide";
      if (r.severity === "high") tone = "alert";
    } else if (cov.kind === "states") {
      line = `Sent to ${listShort(cov.states)}`;
    } else {
      line = "Region not stated";
    }
  }
  return { verdict: v.verdict, line, headline: v.headline, detail: v.detail, tone, stateAbbr: st };
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  /* execCommand is deprecated but is still the only copy that works on an
   * insecure origin (a LAN preview over http) and in older WebViews. */
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

/** Share one recall through the OS share sheet, or copy its link.
 *  @returns {Promise<'shared'|'copied'|'failed'>}
 *
 *  The share text leads with the product and carries the verdict as worded
 *  for the sender's state — so a pasted message says "Not reported in
 *  California", never a bare "not in your area" that the recipient, who may
 *  live elsewhere, would read as being about them.
 *
 *  A share sheet the user dismisses rejects with AbortError. That returns
 *  'failed' without falling back to the clipboard: silently overwriting the
 *  clipboard after someone chose not to share would be a surprise. Callers
 *  should treat 'failed' as "say nothing loud" rather than an error toast. */
export async function shareRecall(recall, stateAbbr) {
  if (typeof window === "undefined" || !recall) return "failed";
  const url = shareUrl(recall, stateAbbr);
  const { headline, verdict } = cardVerdict(recall, stateAbbr);
  const product = String(recall.product || "Recalled product").slice(0, 140);
  const text = verdict === VERDICTS.NEEDS_LOCATION ? `Recall: ${product}` : `Recall: ${product} — ${headline}.`;

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const data = { title: product, text, url };
    let can = true;
    try { if (typeof navigator.canShare === "function") can = navigator.canShare(data); } catch (_) { can = false; }
    if (can) {
      try {
        await navigator.share(data);
        return "shared";
      } catch (err) {
        if (err && err.name === "AbortError") return "failed";
        /* NotAllowedError (no user activation) and friends: the sheet never
         * opened, so copying is what the user actually asked for. */
      }
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}
