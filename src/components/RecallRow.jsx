import { ChevronRight } from "lucide-react";
import { plainHeadline, dayOf } from "@/lib/digest";
import { reasonFor } from "@/lib/reason";
import { coverageOf, isAnnounced, verdictFor, resolveLoc, VERDICTS } from "@/lib/verdict";
import { coverageLine } from "@/lib/coverage-line";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * ONE RECALL, ONE ROW
 *
 * The home screen's list and its search results are the same shape: what is
 * wrong with what (plainHeadline, every word from the notice), one quiet line
 * under it, and a text badge only where the agency's own class says
 * "serious". No icons, no tinted chips per row — the class badge is the only
 * warm thing on screen, so it still means something when it appears.
 *
 * A search row adds the verdict for the reader's state as its own line
 * ("Not reported in New York"), in ink, never green: a shipping list is not
 * an all-clear. Everything the verdict rests on — the quote, the state map,
 * follow, share — is one tap away in the recall sheet.
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

export function RowBadge({ recall }) {
  if (isAnnounced(recall) && !isEnded(recall)) {
    return (
      <span className="rounded-md border border-dashed border-line-strong px-1.5 py-px text-[11px] font-semibold text-fog">
        Announced
      </span>
    );
  }
  if (recall.severity === "high" && !isEnded(recall)) {
    return (
      <span className="rounded-md border border-alert-line bg-alert-soft px-1.5 py-px text-[11px] font-semibold text-alert">
        Serious
      </span>
    );
  }
  return null;
}

/**
 * @param {object}   props.recall
 * @param {Function} props.onOpen       (recall) => void
 * @param {string}   [props.verdict]    search rows: the short verdict line
 * @param {string}   [props.meta]       the muted line; built from the record when omitted
 * @param {string}   [props.inState]    "NY" — lets the meta line say "In NY"
 */
export default function RecallRow({ recall, onOpen, verdict, meta, inState, className, style }) {
  const headline = plainHeadline(recall) || recall.product || "Recall notice";
  /* "Other reason" / "Reason not stated" are filter buckets, not news; the
   * headline already carries the hazard when there is one. */
  const reason = reasonFor(recall);
  const line = meta != null ? meta : [
    reason.key === "other" || reason.key === "unspecified" ? "" : reason.label,
    rowDate(recall),
    rowWhere(recall, { inState }),
  ].filter(Boolean).join(" · ");
  return (
    <li className={className} style={style}>
      <button
        type="button"
        onClick={() => onOpen && onOpen(recall)}
        className={cn(
          "group flex w-full items-start gap-3 py-3.5 text-left",
          "rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15px] font-semibold leading-snug text-paper group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-2">
            {headline}
          </span>
          {verdict && (
            <span className="verdict-line mt-1 block text-[13px] font-medium leading-snug text-paper">{verdict}</span>
          )}
          <span className="tnum mt-0.5 block truncate text-[12.5px] leading-snug text-subtle">{line}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <RowBadge recall={recall} />
          <ChevronRight aria-hidden="true" className="size-4 text-subtle transition-colors group-hover:text-paper" />
        </span>
      </button>
    </li>
  );
}
