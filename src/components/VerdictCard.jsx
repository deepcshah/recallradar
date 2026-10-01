import { useEffect, useId, useState } from "react";
import {
  BellRing, Check, CircleHelp, ExternalLink, History, MapPin, MapPinOff, Megaphone, Plus, Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/tooltip";
import StateMap from "@/components/StateMap";
import WatchButton from "@/components/WatchButton";
import { verdictFor, coverageOf, resolveLoc, VERDICTS, isAnnounced } from "@/lib/verdict";
import { coverageLine } from "@/lib/coverage-line";
import { fmtAsOf } from "@/components/FreshnessLine";
import { classInfo, severityLabel, severityVariant } from "@/lib/classification";
import { reasonFor } from "@/lib/reason";
import { recallUpcs, lookupProduct } from "@/lib/upc";
import { shareRecall } from "@/lib/share";
import { addFollow, removeFollow, getFollows, FOLLOWS_EVENT } from "@/lib/follows";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

/* ─────────────────────────────────────────────────────────────────────────
 * ONE RECALL, ANSWERED
 *
 * A search result here is not a list row, it is an answer to "did that reach
 * me?", so the answer leads: the product, then verdictFor's headline, then —
 * on opening — everything the headline rests on. The order inside an open
 * card is the order a sceptical reader checks things in:
 *
 *   1. the verdict in a sentence (verdictFor's detail, never re-worded here)
 *   2. what the agency actually wrote, verbatim and in quotes, so the reader
 *      can see we did not invent "not reported in California"
 *   3. the same thing as a picture (StateMap)
 *   4. why it was recalled, how serious, when, and the official notice
 *   5. what to do with it: share it, get told when it changes, or follow
 *      the brand
 *
 * Colour stays where the rest of the app keeps it. The severity badge is the
 * only warm thing on the card, because the class is the government's own
 * word. The verdict line is ink, whatever it says: "Not reported in Texas" is
 * not an all-clear and must not be dressed as one, and "Distributed in Texas"
 * is a fact about a shipping list, not an alarm — the class badge beside it
 * says how alarmed to be.
 * ───────────────────────────────────────────────────────────────────────── */

const VERDICT_ICON = {
  [VERDICTS.IN_AREA]: MapPin,
  [VERDICTS.NOT_LISTED]: MapPinOff,
  [VERDICTS.UNSTATED]: CircleHelp,
  [VERDICTS.ENDED]: History,
  [VERDICTS.NEEDS_LOCATION]: MapPin,
  [VERDICTS.ANNOUNCED]: Megaphone,
};

/* The agency key freshnessOf() uses for a record's source. */
function freshKey(source) {
  const s = String(source || "");
  if (s.startsWith("FDA")) return "FDA";
  if (s.startsWith("USDA")) return "USDA FSIS";
  return s === "CPSC" ? "CPSC" : null;
}

/* "Announced — not yet classified". Neutral and dashed, never amber or red:
 * the class is the government's word, and the government hasn't said one. */
export function AnnouncedBadge() {
  return (
    <InfoTip
      title="Announced — not yet classified"
      body="The company announced this recall. FDA hasn't classified it or published where it went yet."
      label="Announced, not yet classified: what this means"
      variant="badge"
      triggerClassName="text-fog"
      side="bottom"
    >
      <Badge variant="low" className="border-dashed border-line-strong bg-transparent text-fog">
        Announced — not yet classified
      </Badge>
    </InfoTip>
  );
}

/** "FDA Food" → "FDA". The evidence line names the agency, not our feed key. */
export function agencyOf(source) {
  const s = String(source || "");
  if (s.startsWith("FDA")) return "FDA";
  if (s.startsWith("USDA")) return "USDA";
  if (s === "CPSC") return "CPSC";
  return s || "agency";
}

/* A normalizer writes this in place of an empty FSIS states field. It is our
 * sentence, not the agency's, so it must never be quoted as if they said it. */
const OUR_PLACEHOLDERS = /^(?:region not stated|)$/i;

function fmtDay(iso) {
  if (!iso) return "";
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (isNaN(t)) return "";
  return t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** The phrase a Follow button offers: the brand, as a person would type it.
 *
 *  Notices name the legal entity — "Fontanini Foods, LLC", "S-Q Business (HK)
 *  Limited, dba ZCK01, of China" — and follows.js matches every word of a term
 *  against the start of a word in the product or firm. So the corporate
 *  suffixes, the parentheticals and the "of China" tail have to go, or the
 *  follow would never match the next notice that spells the firm slightly
 *  differently. A "dba" name wins: it is the name on the box.
 *
 *  Capped at 40 characters on a word boundary, which is what the push server
 *  accepts (see push-store.js) — a follow that silently could not be pushed
 *  would be a broken promise. */
export function followTermFor(recall) {
  let t = String((recall && recall.firm) || "");
  /* Most USDA and CPSC records in the index carry no firm field at all; their
   * title does, in a fixed shape — "Sempio Food Services Inc. Recalls …",
   * "… Battery Packs Recalled Due to …". Take the words before the verb. A
   * title with neither shape offers no follow rather than a guessed one. */
  if (!t.trim()) {
    const m = /^(.{2,80}?)\s+recall(?:s|ed)?\b/i.exec(String((recall && recall.product) || ""));
    t = m && !/^(?:fsis|usda|fda|cpsc)\b/i.test(m[1])
      ? m[1].replace(/\s+(?:expands?|expanded|announces?|issues?|voluntarily)$/i, "")
      : "";
  }
  const dba = /\bd\.?b\.?a\.?\s+([^,;]+)/i.exec(t);
  if (dba) t = dba[1];
  t = t.split(/[,;]/)[0]
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:inc|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|incorporated|lp|llp|plc|gmbh|s\.?a|s\.?a\.? de c\.?v)\.?(?=\s|$)/gi, " ")
    .replace(/\s+of\s+[A-Z][\w .]*$/i, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s.&-]+$/, "")
    .trim();
  if (t.length > 40) t = t.slice(0, 40).replace(/\s+\S*$/, "");
  return t.length >= 2 ? t : "";
}

function sameTerm(a, b) {
  const f = (s) => String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  return f(a) === f(b);
}

/* ───────────────────────────── the class badge ─────────────────────────── */

/* The same disclosure the area list's cards carry (see SeverityBadge in
 * App.jsx and the README's "Terms that explain themselves"), rebuilt from the
 * same two pieces rather than imported, so this component stays free of the
 * app shell. If one changes, change both. */
export function ClassBadge({ recall }) {
  const info = classInfo(recall);
  const badge = <Badge variant={severityVariant(recall)}>{severityLabel(recall)}</Badge>;
  if (!info) return badge;
  return (
    <InfoTip
      title={`${info.term} — ${info.plain}`}
      body={`${info.body} Assigned by ${info.agency}.`}
      label={`${info.term}: what this means`}
      variant="badge"
      triggerClassName="text-fog"
      side="bottom"
    >
      {badge}
    </InfoTip>
  );
}

/* ───────────────────────────── the product photo ───────────────────────── */

/* Only for an open card. A result list can hold forty notices, and a photo
 * per result would be forty requests to a third party on every keystroke's
 * worth of results; the reader who opens one card is the reader who wants to
 * know whether the thing in their fridge is this thing. */
function ProductPhoto({ recall }) {
  const [src, setSrc] = useState(recall.image || "");
  useEffect(() => {
    if (recall.image) { setSrc(recall.image); return; }
    setSrc("");
    const code = (Array.isArray(recall.upcs) && recall.upcs[0]) || recallUpcs(recall)[0];
    if (!code) return;
    let live = true;
    lookupProduct(code).then((p) => live && p?.image && setSrc(p.image)).catch(() => {});
    return () => { live = false; };
  }, [recall]);
  if (!src) return null;
  return (
    <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer"
         className="size-16 shrink-0 rounded-lg border border-line bg-panel object-cover"
         onError={(e) => { e.currentTarget.style.display = "none"; }} />
  );
}

/* ───────────────────────────── share + follow ──────────────────────────── */

function ShareButton({ recall, stateAbbr }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 2200);
    return () => clearTimeout(t);
  }, [said]);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="pointer-coarse:h-10"
      onClick={async () => {
        const out = await shareRecall(recall, stateAbbr);
        /* The outcome word and the verdict the link will unfurl as — never
         * the link itself, which carries the reader's state. 'failed' is
         * mostly a dismissed sheet, and is worth seeing as such. */
        track("share_clicked", {
          outcome: out,
          verdict: verdictFor(recall, stateAbbr ? { stateAbbr } : null).verdict,
          source: recall.source || null,
        });
        // 'failed' is usually a dismissed share sheet — say nothing.
        if (out === "copied") setSaid("Link copied");
        else if (out === "shared") setSaid("Shared");
      }}
    >
      {said ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
      <span aria-live="polite">{said || "Share"}</span>
    </Button>
  );
}

function useFollowing(term) {
  const [on, setOn] = useState(() => !!term && getFollows().some((f) => sameTerm(f, term)));
  useEffect(() => {
    if (!term) return;
    const sync = () => setOn(getFollows().some((f) => sameTerm(f, term)));
    sync();
    window.addEventListener(FOLLOWS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(FOLLOWS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [term]);
  return on;
}

function FollowButton({ term }) {
  const on = useFollowing(term);
  if (!term) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-pressed={on}
      className="max-w-full pointer-coarse:h-10"
      onClick={() => (on ? removeFollow(term) : addFollow(term))}
    >
      {on ? <BellRing aria-hidden="true" /> : <Plus aria-hidden="true" />}
      <span className="truncate">{on ? `Following ${term}` : `Follow ${term}`}</span>
    </Button>
  );
}

/* ───────────────────────────── the card ────────────────────────────────── */

/**
 * @param {object}   props
 * @param {object}   props.recall     a normalized or national-index record
 * @param {object}   [props.loc]      { state, stateAbbr } or null
 * @param {boolean}  [props.expanded] show the evidence, map and actions
 * @param {Function} [props.onToggle] () => void — header clicked; omit to make
 *                                    the card static (always as `expanded` says)
 * @param {Function} [props.onRequestLocation] () => void — "Check your state",
 *                                    shown only when loc is null
 * @param {object[]} [props.freshness] freshnessOf() entries; dates the
 *                                    "not reported" answer
 * @param {string}   [props.eyebrow]  a small label above the product ("Linked recall")
 * @param {string}   [props.className]
 * @param {object}   [props.style]
 */
export default function VerdictCard({
  recall, loc, expanded = false, onToggle, onRequestLocation, eyebrow, className, style, freshness,
}) {
  const bodyId = useId();
  const L = resolveLoc(loc);
  const v = verdictFor(recall, L);
  const cov = coverageOf(recall);
  const reason = reasonFor(recall);
  const agency = agencyOf(recall.source);
  const Icon = VERDICT_ICON[v.verdict] || CircleHelp;
  const needsLoc = v.verdict === VERDICTS.NEEDS_LOCATION;
  const announced = isAnnounced(recall);
  /* Without a location the coverage IS the answer we can give, so it takes
   * the verdict's line; the CTA under it turns it into a verdict. */
  const where = coverageLine(recall);
  const headline = needsLoc ? where : v.headline;
  const showWhere = !needsLoc && where !== v.headline;
  const fresh = (freshness || []).find((e) => e.source === freshKey(recall.source));
  const asOf = fresh && fresh.asOf ? fmtAsOf(fresh.asOf) : "";
  const evidence = OUR_PLACEHOLDERS.test(String(v.evidence || "").trim()) ? "" : v.evidence;
  const term = followTermFor(recall);
  /* The publish date leads: it is the one that matches the headline the
   * reader saw. The start date is weeks earlier and reads as stale on its own. */
  const date = recall.posted
    ? `Posted ${fmtDay(recall.posted)}${recall.date && fmtDay(recall.date) !== fmtDay(recall.posted) ? ` · started ${fmtDay(recall.date)}` : ""}`
    : fmtDay(recall.date);

  const head = (
    <>
      {eyebrow && <p className="microlabel mb-1">{eyebrow}</p>}
      <p className={cn("text-[15px] font-semibold leading-snug text-paper", !expanded && "line-clamp-2")}>
        {recall.product || "(no product description)"}
      </p>
      {recall.firm && <p className="mt-0.5 truncate text-xs text-fog">{recall.firm}</p>}
      <p className="mt-2 flex items-start gap-1.5 text-sm font-bold leading-snug text-paper">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fog" />
        <span className="verdict-line">{headline}</span>
      </p>
      {showWhere && (
        <p className="coverage-line mt-0.5 pl-[22px] text-[12px] leading-snug text-fog">{where}</p>
      )}
    </>
  );

  return (
    <article
      className={cn(
        "elev-1 rounded-xl border border-line bg-panel-2 transition-colors",
        onToggle && !expanded && "hover:bg-panel-3",
        v.verdict === VERDICTS.ENDED && "bg-panel",
        className,
      )}
      style={style}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="block w-full rounded-xl px-3.5 pt-3.5 pb-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
        >
          {head}
        </button>
      ) : (
        <div className="px-3.5 pt-3.5 pb-2">{head}</div>
      )}

      {/* Outside the toggle: a button inside a button is invalid. */}
      {needsLoc && onRequestLocation && (
        <div className="-mt-1 px-3.5 pb-1.5 pl-[36px]">
          <button
            type="button"
            onClick={onRequestLocation}
            className="tap inline-flex items-center gap-1 text-[13px] font-semibold text-mint hover:underline"
          >
            <MapPin aria-hidden="true" className="size-3.5" /> Check your state
          </button>
        </div>
      )}

      {/* Badges sit outside the toggle: the class badge is its own button
       * (a disclosure), and a button inside a button is invalid and would
       * swallow the tap meant for one of them. */}
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3">
        {announced ? <AnnouncedBadge /> : <ClassBadge recall={recall} />}
        <Badge variant="low">{reason.label}</Badge>
        {v.verdict === VERDICTS.ENDED && <Badge variant="scope">Ended</Badge>}
        <Badge variant="source">{recall.source}</Badge>
        {date && <span className="tnum text-[11px] text-subtle">{date}</span>}
      </div>

      {expanded && (
        <div id={bodyId} className="fade-item border-t border-line px-3.5 pt-3 pb-3.5">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-relaxed text-paper">{v.detail}</p>
              {v.note && <p className="mt-1.5 text-[12px] leading-snug text-fog">{v.note}</p>}
              {v.verdict === VERDICTS.NOT_LISTED && (
                <p className="mt-1.5 text-[12px] leading-snug text-subtle">
                  Distribution as published by {agency}{asOf ? `; data as of ${asOf}` : ""}.
                </p>
              )}
            </div>
            <ProductPhoto recall={recall} />
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-start">
            <div className="min-w-0">
              {/* The words the verdict was read from, as published. The label
               * says whose words they are; our own placeholder for "the agency
               * gave none" is never put in quotation marks. */}
              {evidence ? (
                <blockquote className="m-0 rounded-lg border border-line bg-sunken px-3 py-2.5">
                  <p className="microlabel">
                    {agency === "CPSC" ? "Where the CPSC notice says it was sold" : `The ${agency} notice says`}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-paper [overflow-wrap:anywhere]">
                    “{evidence}”
                  </p>
                </blockquote>
              ) : (
                <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] leading-relaxed text-fog">
                  The {agency} notice gives no distribution at all.
                </p>
              )}
              {agency === "CPSC" && (
                <p className="mt-1.5 text-[11px] leading-snug text-subtle">
                  CPSC recalls products sold across the country and never limits a notice to
                  particular states.
                </p>
              )}
              {recall.reason && (
                <p className="mt-3 text-[13px] leading-relaxed text-fog">
                  <span className="font-semibold text-paper">Why: </span>
                  {recall.reason}
                </p>
              )}
            </div>
            <StateMap kind={cov.kind} states={cov.states} userState={L && L.stateAbbr} />
          </div>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <ShareButton recall={recall} stateAbbr={L && L.stateAbbr} />
            {/* This notice, watched for changes — closed, more states,
                reclassified. Follow <brand> beside it watches for new ones. */}
            <WatchButton recall={recall} />
            <FollowButton term={term} />
            {recall.url && (
              <a
                href={recall.url}
                target="_blank"
                rel="noopener noreferrer"
                className="tap inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-mint hover:underline"
              >
                Official notice
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
