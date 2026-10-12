import RecallThumb from "@/components/RecallThumb";
import { plainHeadline, dayOf } from "@/lib/digest";
import { reasonFor } from "@/lib/reason";
import { coverageOf, isAnnounced, verdictFor, resolveLoc, VERDICTS } from "@/lib/verdict";
import { coverageLine } from "@/lib/coverage-line";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * ONE RECALL, ONE ROW
 *
 *   ┌────┐  Listeria in bagged spinach                (2 lines max)
 *   │ 🥬 │  [Serious] Listeria · Oct 8 · In NY
 *   └────┘
 *
 * The home screen's list and its search results are the same row: a 56px
 * tile (the agency's photo, or a calm category tile — RecallThumb), the plain
 * headline (every word from the notice), and one quiet line under it. The
 * only warm thing a row can carry is "Serious", and only where the agency's
 * own class says so; "Announced" is a dashed neutral label for a recall FDA
 * has not classified. No chevron: the whole row is the target.
 *
 * A search row leads its line with the verdict for the reader's state
 * ("Not reported in New York · Sep 30 · United Sugar…"), in ink, never
 * green: a shipping list is not an all-clear.
 * ───────────────────────────────────────────────────────────────────────── */

const THIS_YEAR = new Date().getFullYear();

/** "Sep 30", or "Sep 30, 2025" outside this year. Publish date first. */
export function rowDate(r) {
  const day = dayOf((r && (r.posted || r.date)) || "");
  if (!day) return "";
  const t = new Date(`${day}T12:00:00Z`);
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (t.getUTCFullYear() !== THIS_YEAR) opts.year = "numeric";
  return t.toLocaleDateString("en-US", opts);
}

/** Where, in a word or two: "Nationwide", "In NY", "IA, IL", "8 states". */
export function rowWhere(r, { inState } = {}) {
  const cov = coverageOf(r);
  if (cov.kind === "nationwide") return "Nationwide";
  if (cov.kind === "states") {
    if (inState && cov.states.includes(inState)) return `In ${inState}`;
    if (cov.states.length <= 2) return cov.states.join(", ");
    return `${cov.states.length} states`;
  }
  return "Region not stated";
}

/** The verdict as a short line, for search results. Same reading as
 *  verdictFor; only the words are shorter. */
export function shortVerdict(r, loc) {
  const L = resolveLoc(loc);
  const v = verdictFor(r, L);
  switch (v.verdict) {
    case VERDICTS.ANNOUNCED: return "Announced, not yet classified";
    case VERDICTS.ENDED: return "Ended";
    case VERDICTS.UNSTATED: return "Region not stated";
    case VERDICTS.NEEDS_LOCATION: return coverageLine(r);
    default: return v.headline;
  }
}

const isEnded = (r) => (r.status ? r.status === "ended" : r.active === false);

export function RowBadge({ recall, skipAnnounced = false }) {
  if (isAnnounced(recall) && !isEnded(recall)) {
    if (skipAnnounced) return null;
    return (
      <span className="mr-1.5 inline-flex -translate-y-px items-center rounded-full border border-dashed border-line-strong px-2 py-px align-middle text-[11.5px] font-medium leading-[18px] text-fog">
        Announced
      </span>
    );
  }
  if (recall.severity === "high" && !isEnded(recall)) {
    return (
      <span className="mr-1.5 inline-flex -translate-y-px items-center rounded-full bg-alert-soft px-2 py-px align-middle text-[11.5px] font-semibold leading-[18px] text-alert shadow-[inset_0_0_0_1px_var(--rr-alert-line)]">
        Serious
      </span>
    );
  }
  return null;
}

/**
 * @param {object}   props.recall
 * @param {Function} props.onOpen       (recall) => void
 * @param {string}   [props.verdict]    search rows: the short verdict, leads the meta line
 * @param {string}   [props.meta]       the muted line; built from the record when omitted
 * @param {string}   [props.inState]    "NY" — lets the meta line say "In NY"
 * @param {number}   [props.index]      position, for the first-render stagger
 * @param {boolean}  [props.animate]    fade in (first render of a list only)
 */
export default function RecallRow({ recall, onOpen, verdict, meta, inState, className, style, index = 0, animate = false }) {
  const headline = plainHeadline(recall) || recall.product || "Recall notice";
  /* "Other reason" / "Reason not stated" are filter buckets, not news; the
   * headline already carries the hazard when there is one. */
  const reason = reasonFor(recall);
  /* An announced recall with no geography says so with its "Announced"
   * label — FDA hasn't published a distribution list yet — so the row does
   * not spend a second line repeating "Region not stated". */
  const where = rowWhere(recall, { inState });
  const quietWhere = isAnnounced(recall) && !isEnded(recall) && where === "Region not stated";
  const line = meta != null ? meta : [
    reason.key === "other" || reason.key === "unspecified" ? "" : reason.label,
    rowDate(recall),
    quietWhere ? "" : where,
  ].filter(Boolean).join(" · ");
  return (
    <li className={cn(animate && "row-in", className)} style={animate ? { ...style, "--i": Math.min(index, 12) } : style}>
      <button
        type="button"
        onClick={() => onOpen && onOpen(recall)}
        className={cn(
          "press group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3.5 rounded-[20px] px-2 py-2.5 text-left",
          "hover:bg-panel-3/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint",
        )}
      >
        <RecallThumb recall={recall} size="md" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15.5px] font-semibold leading-[1.3] tracking-[-0.011em] text-paper">
            {headline}
          </span>
          <span className="tnum mt-1 line-clamp-2 text-[13px] leading-snug text-subtle">
            <RowBadge recall={recall} skipAnnounced={!!verdict && /^Announced/.test(verdict)} />
            {verdict && <span className="verdict-line font-medium text-paper">{verdict}</span>}
            {verdict && line && <span aria-hidden="true"> · </span>}
            {line}
          </span>
        </span>
      </button>
    </li>
  );
}
