import { useEffect, useRef, useState } from "react";
import { ArrowDown, ChevronLeft, ChevronRight, CircleHelp, LoaderCircle, MapPin, SearchX, ShieldCheck, TriangleAlert } from "lucide-react";
import RecallThumb from "@/components/RecallThumb";
import { shortVerdict, rowDate } from "@/components/RecallRow";
import { fmtAsOf, oldestAsOf } from "@/components/FreshnessLine";
import { answerFor, bestGuesses } from "@/lib/query-answer";
import { plainHeadline, hazardLabel } from "@/lib/digest";
import { glanceOf } from "@/lib/glance";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * THE ANSWER — what Enter shows above the list
 *
 *   ┌ ◎ No active recall for “romaine” reached New York ─────────┐
 *   │   4 notices match: 4 went only to other states (AZ, CA).    │
 *   │   Checked FDA, USDA and CPSC · data as of Oct 14            │
 *   │   See all 4 notices ↓                                       │
 *   └─────────────────────────────────────────────────────────────┘
 *   Best match                                      1 of 4  ‹  ›
 *   ┌──────────────────────────┐┌───────────
 *   │ [tile] Taylor Farms …    ││ …           swipe, or ‹ ›
 *   │ Not reported in New York ││
 *   │ (Listeria) · Oct 8       ││
 *   └──────────────────────────┘└───────────
 *
 * The answer is src/lib/query-answer.js; this is only how it looks. Tone
 * follows the answer: alert only for "recalled", calm ink for "clear" (a
 * shield, never green, never "safe" — the line under it says what was
 * checked and as of when), neutral for the rest.
 * ───────────────────────────────────────────────────────────────────────── */

const LOOK = {
  recalled: { Icon: TriangleAlert, box: "bg-alert-soft shadow-[inset_0_0_0_1px_var(--rr-alert-line)]", icon: "text-alert" },
  check: { Icon: CircleHelp, box: "bg-sunken", icon: "text-fog" },
  clear: { Icon: ShieldCheck, box: "bg-panel-2 shadow-[inset_0_0_0_1px_var(--rr-line)]", icon: "text-paper" },
  none: { Icon: SearchX, box: "bg-sunken", icon: "text-fog" },
  needsLoc: { Icon: MapPin, box: "bg-sunken", icon: "text-fog" },
};

function GuessCard({ recall, loc, onOpen }) {
  const g = glanceOf(recall);
  const hazard = g.hazard || hazardLabel(recall);
  const facts = [g.soldAt.slice(0, 2).join(", "), g.when || rowDate(recall)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={() => onOpen && onOpen(recall)}
      className="press flex h-full w-full flex-col rounded-3xl bg-panel-2 p-4 text-left shadow-[var(--rr-shadow-1),inset_0_0_0_1px_var(--rr-line)] hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
    >
      <span className="flex items-start gap-3">
        <RecallThumb recall={recall} size="md" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15.5px] font-semibold leading-[1.3] text-paper">
            {plainHeadline(recall) || recall.product}
          </span>
          {recall.firm && <span className="mt-0.5 block truncate text-[12.5px] text-subtle">{recall.firm}</span>}
        </span>
      </span>
      <span className="verdict-line mt-3 block text-[14px] font-semibold leading-snug text-paper">{shortVerdict(recall, loc)}</span>
      <span className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-subtle">
        {hazard && !/^(?:other reason|reason not stated)$/i.test(hazard) && (
          <span className="rounded-full bg-sunken px-2 py-px text-[11.5px] font-medium leading-[18px] text-paper/85">{hazard}</span>
        )}
        <span className="tnum">{facts}</span>
      </span>
      <span className="mt-auto pt-3 text-[13px] font-semibold text-mint">Open the recall</span>
    </button>
  );
}

function Guesses({ guesses, loc, onOpen }) {
  const rail = useRef(null);
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(0); if (rail.current) rail.current.scrollLeft = 0; }, [guesses]);
  const go = (i) => {
    const el = rail.current;
    const n = Math.max(0, Math.min(guesses.length - 1, i));
    const card = el && el.children[n];
    if (card) el.scrollTo({ left: card.offsetLeft - el.offsetLeft, behavior: "smooth" });
    setAt(n);
  };
  const onScroll = () => {
    const el = rail.current;
    if (!el || !el.children.length) return;
    const w = el.children[0].getBoundingClientRect().width + 12;
    setAt(Math.max(0, Math.min(guesses.length - 1, Math.round(el.scrollLeft / w))));
  };
  if (!guesses.length) return null;
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-paper">{guesses.length > 1 ? "Best matches" : "Best match"}</h3>
        {guesses.length > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="tnum mr-1 text-[12.5px] text-subtle" aria-live="polite">{at + 1} of {guesses.length}</span>
            <button type="button" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Previous match"
                    className="icon-btn disabled:opacity-30"><ChevronLeft aria-hidden="true" className="size-[18px]" /></button>
            <button type="button" onClick={() => go(at + 1)} disabled={at === guesses.length - 1} aria-label="Next match"
                    className="icon-btn disabled:opacity-30"><ChevronRight aria-hidden="true" className="size-[18px]" /></button>
          </div>
        )}
      </div>
      <div
        ref={rail}
        onScroll={onScroll}
        className="-mx-4 mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0"
      >
        {guesses.map((r) => (
          <div key={r.id} className={cn("shrink-0 snap-start", guesses.length > 1 ? "w-[86%] sm:w-[22rem]" : "w-full")}>
            <GuessCard recall={r} loc={loc} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * @param {object[]} props.records     the search results, as listed below
 * @param {string}   props.q
 * @param {object}   [props.loc]
 * @param {object[]} [props.freshness] freshnessOf() entries
 * @param {boolean}  [props.checking]  FDA is still being asked directly
 * @param {Function} props.onOpen      (recall) => void
 * @param {Function} [props.onShowAll] () => void — jump to the full list
 * @param {Function} [props.onRequestLocation]
 */
export default function SearchAnswer({ records, q, loc, freshness, checking, onOpen, onShowAll, onRequestLocation, className }) {
  const a = answerFor(records, q, loc);
  const guesses = bestGuesses(records, q, loc, 5);
  const { Icon, box, icon } = LOOK[a.kind];
  const asOf = oldestAsOf(freshness || []);
  /* Enter is a question; land on the answer. On a phone the box, the pills
   * and the keyboard would otherwise leave it below the fold. */
  const self = useRef(null);
  useEffect(() => {
    const el = self.current;
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [q]);
  return (
    <section ref={self} className={cn("fade-item scroll-mt-24", className)} aria-label="Answer">
      <div className={cn("rounded-3xl p-4 sm:p-5", box)} role="status">
        <p className="flex items-start gap-2.5 text-[18px] font-semibold leading-snug text-paper">
          <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", icon)} />
          <span>{a.headline}</span>
        </p>
        <div className="mt-1.5 flex flex-col gap-1 pl-[30px] text-[14px] leading-relaxed text-fog">
          {a.lines.map((l) => <p key={l}>{l}</p>)}
          {checking && (
            <p className="flex items-center gap-1.5 text-[13px]"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Still checking FDA directly…</p>
          )}
          <p className="text-[12.5px] leading-snug text-subtle">
            Checked FDA, USDA and CPSC{asOf ? ` · data as of ${fmtAsOf(asOf)}` : ""}.
            {a.kind === "clear" && asOf && ` A recall announced after ${fmtAsOf(asOf)} may not be here yet.`}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {a.kind === "needsLoc" && onRequestLocation && (
              <button type="button" onClick={onRequestLocation}
                      className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-panel-3 px-3 text-[13px] font-semibold text-paper">
                <MapPin aria-hidden="true" className="size-3.5" /> Set your location
              </button>
            )}
            {records.length > 0 && onShowAll && (
              <button type="button" onClick={onShowAll}
                      className="press inline-flex min-h-9 items-center gap-1 text-[13px] font-semibold text-mint hover:underline">
                See all {records.length} {records.length === 1 ? "notice" : "notices"} <ArrowDown aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
      <Guesses guesses={guesses} loc={loc} onOpen={onOpen} />
    </section>
  );
}
