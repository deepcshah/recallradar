import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import RecallRow from "@/components/RecallRow";
import ScopeSwitch from "@/components/ScopeSwitch";
import FreshnessLine, { FdaGapNote, fdaMissing, fmtAsOf, oldestAsOf } from "@/components/FreshnessLine";
import { recentFor, recentForUs, freshnessOf } from "@/lib/search-index";
import { resolveLoc } from "@/lib/verdict";

/* ─────────────────────────────────────────────────────────────────────────
 * LATEST RECALLS — the home screen's list
 *
 *   Latest recalls                       [ Near me · NY | All US ]
 *   142 active · Data: FDA as of Sep 30 · USDA Oct 7 · CPSC Oct 8
 *   ─────────────────────────────────────────────────────────────
 *   Listeria in bagged spinach                              Serious
 *   Listeria · Oct 8 · In NY
 *
 * Where the records come from is the digest's old rule, unchanged: the app's
 * live list for the current scope (the area list for Near me, the national
 * one for All US) whenever it has anything in it; while it loads, or if every
 * live source failed, the national index read through the same area rule
 * (recentFor) or none (recentForUs). Never a mix of the two — and the
 * freshness line says which one this is, per agency.
 *
 * Newest first by the day the agency published the notice (`posted || date`,
 * the same rule as the full list). Ended notices are left out: this is the
 * list of what is in force. An empty list says what was read, never "safe".
 * ───────────────────────────────────────────────────────────────────────── */

const PAGE = 20;
const INDEX_LOOKBACK_DAYS = 400;

const t = (r) => { const d = r.posted || r.date; return d ? new Date(d).getTime() || 0 : 0; };
const sev = { high: 0, med: 1, low: 2 };
const ended = (r) => (r.status ? r.status === "ended" : r.active === false);

function RowSkeleton() {
  return (
    <li className="py-3.5" aria-hidden="true">
      <div className="shimmer h-4 w-4/5 rounded" />
      <div className="shimmer mt-2 h-3 w-2/5 rounded" />
    </li>
  );
}

/**
 * @param {object}   props.loc          verdict location ({ state, stateAbbr }) or null
 * @param {boolean}  props.hasLocation  the reader set a place of their own
 * @param {string}   props.scope        "near" | "us"
 * @param {object}   props.index        national index, or null while loading
 * @param {object}   props.live         { records, sources } for the scope, or null
 * @param {boolean}  props.busy         the live list for this scope is loading
 * @param {Function} props.onChangeScope (next, via) => void — App's changeScope
 * @param {Function} props.onOpenRecall (record) => void
 * @param {Function} props.onBrowseAll  () => void — the full list with filters
 */
export default function LatestRecalls({
  loc, hasLocation, scope, index, live, busy, onChangeScope, onOpenRecall, onBrowseAll,
}) {
  const L = resolveLoc(loc);
  const us = scope === "us" || !hasLocation || !L;
  const abbr = L && L.stateAbbr;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [us, abbr]);

  const { records, from, sources } = useMemo(() => {
    if (live && Array.isArray(live.records) && live.records.length) {
      return { records: live.records, from: "live", sources: live.sources || null };
    }
    if (index && Array.isArray(index.recalls)) {
      const recs = us
        ? recentForUs(index, { sinceDays: INDEX_LOOKBACK_DAYS })
        : recentFor(index, L, { sinceDays: INDEX_LOOKBACK_DAYS });
      return { records: recs, from: "index", sources: null };
    }
    return { records: [], from: "none", sources: null };
  }, [live, index, us, abbr]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(
    () => records.filter((r) => !ended(r))
      .sort((a, b) => t(b) - t(a) || (sev[a.severity] ?? 1) - (sev[b.severity] ?? 1)),
    [records],
  );
  const freshness = useMemo(() => (index || sources ? freshnessOf(index, sources) : []), [index, sources]);
  const fdaGap = from !== "none" && sorted.length > 0 && fdaMissing(freshness, sorted);
  const loading = from === "none" || (busy && from !== "live" && !sorted.length);
  const shown = sorted.slice(0, limit);
  const remaining = sorted.length - shown.length;
  const place = us ? "in the US" : `in ${abbr}`;
  const asOf = oldestAsOf(freshness);
  const anyStale = freshness.some((e) => e.stale);

  return (
    <section aria-labelledby="latest-title" className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h2 id="latest-title" className="text-[17px] font-semibold tracking-tight text-paper">Latest recalls</h2>
        <ScopeSwitch scope={us ? "us" : "near"} stateAbbr={hasLocation ? abbr : null}
                     onChange={(next) => onChangeScope(next, "home_list")} />
      </div>
      {/* One line: how many, and the oldest agency date among what was read —
          the honest bound on "a recall after this may not be here yet". The
          per-agency dates sit under the list. */}
      <p className="tnum mt-1 min-h-5 truncate text-[13px] leading-relaxed text-subtle">
        {!loading && (
          <>
            {sorted.length.toLocaleString("en-US")} active {place}
            {asOf && (
              <>
                {" · "}
                {anyStale && <span aria-hidden="true" className="mr-1 inline-block size-1.5 -translate-y-px rounded-full bg-amber align-middle" />}
                data as of {fmtAsOf(asOf)}
                {anyStale && <span className="sr-only"> (some sources may be out of date)</span>}
              </>
            )}
          </>
        )}
      </p>
      {fdaGap && <FdaGapNote className="mt-2" />}

      <ul aria-busy={loading || undefined} className="mt-2 divide-y divide-line border-t border-line">
        {loading
          ? [0, 1, 2, 3, 4].map((i) => <RowSkeleton key={i} />)
          : shown.map((r) => (
            <RecallRow key={r.id} recall={r} onOpen={onOpenRecall} inState={us ? null : abbr} />
          ))}
      </ul>

      {!loading && !sorted.length && (
        <p className="border-b border-line py-5 text-[14px] leading-relaxed text-fog">
          No active recall {us ? "in the notices we read" : `naming ${abbr}, or nationwide, in the notices we read`}.
          That is a statement about these notices, not about any product — search above to check a specific one.
        </p>
      )}

      <div className="mt-4 flex flex-col items-center gap-3">
        {!loading && freshness.length > 0 && <FreshnessLine entries={freshness} className="order-last text-center" />}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setLimit((n) => n + PAGE)}
            className="tap inline-flex h-11 items-center rounded-full border border-line bg-panel px-5 text-[14px] font-semibold text-paper shadow-[var(--rr-bevel),var(--rr-shadow-1)] hover:border-line-strong"
          >
            Show more
          </button>
        )}
        {!loading && onBrowseAll && (
          <button type="button" onClick={onBrowseAll}
                  className="tap inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-mint hover:underline">
            Browse all with filters <ArrowRight aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </section>
  );
}
