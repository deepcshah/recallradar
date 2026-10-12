import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import RecallRow from "@/components/RecallRow";
import { Button } from "@/components/ui/button";
import { inPrimary, primaryNoun } from "@/lib/primary-category";
import ScopeSwitch from "@/components/ScopeSwitch";
import FreshnessLine, { FdaGapNote, fdaMissing, fmtAsOf, oldestAsOf } from "@/components/FreshnessLine";
import { freshnessOf, indexRecordInArea } from "@/lib/search-index";
import { resolveLoc } from "@/lib/verdict";
import { newsDay } from "@/lib/digest";

/* ─────────────────────────────────────────────────────────────────────────
 * LATEST RECALLS — the home screen's list
 *
 *   Latest recalls                       [ Near me · NY | All US ]
 *   142 active in NY · data as of Sep 30
 *
 *   [tile]  Listeria in bagged spinach
 *           [Serious] Listeria · Oct 8 · In NY
 *
 * The category pills above (Home) narrow it to one primary category; the
 * count line and the empty state then say which, so "nothing here" always
 * names what was looked at.
 *
 * One dataset: the local copy of our database (lib/data-sync.js). Near me
 * is that copy through the area rule (isInArea, via indexRecordInArea); All
 * US is every active record in it. The freshness line is the manifest's.
 *
 * Newest first by newsDay (the day the agency published the notice,
 * `posted || date`). Ended notices are left out: this is the list of what is
 * in force. An empty list says what was read, never "safe".
 *
 * Loading: a first-ever visit shows the skeleton until the `latest` chunk
 * lands; a return visit renders the stored copy at once, with "Updating…"
 * only while a sync runs; offline says so, with when the copy was last
 * brought up to date.
 * ───────────────────────────────────────────────────────────────────────── */

const PAGE = 20;
const sev = { high: 0, med: 1, low: 2 };
const ended = (r) => (r.status ? r.status === "ended" : r.active === false);

/** Active records in the scope, newest first — the list before any category
 *  filter. Exported so the page can count the category pills from the very
 *  same set the list shows. */
export function latestInScope(records, { us, loc }) {
  if (!records) return [];
  const L = resolveLoc(loc);
  const list = records.filter((r) => !ended(r) && (us || indexRecordInArea(r, L)));
  const day = new Map(list.map((r) => [r, newsDay(r)]));
  return list.sort((a, b) => day.get(b).localeCompare(day.get(a)) || (sev[a.severity] ?? 1) - (sev[b.severity] ?? 1));
}

function RowSkeleton() {
  return (
    <li className="flex items-center gap-3.5 py-2.5" aria-hidden="true">
      <div className="shimmer size-14 shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1">
        <div className="shimmer h-4 w-4/5 rounded-full" />
        <div className="shimmer mt-2 h-3 w-2/5 rounded-full" />
      </div>
    </li>
  );
}

function fmtWhen(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* The sync's state, in one quiet line — only when it is news: an update in
 * progress over data already on screen, or a copy that could not be
 * refreshed. Nothing at all once the data is current. */
export function SyncNote({ status, lastSynced, hasData, className = "" }) {
  if (!hasData) return null;
  let text = null;
  if (status === "syncing") text = "Updating…";
  else if (status === "offline") text = `Offline · last updated ${fmtWhen(lastSynced) || "earlier"}`;
  else if (status === "error") text = `Couldn't update just now · showing data from ${fmtWhen(lastSynced) || "earlier"}`;
  if (!text) return null;
  return (
    <p id="sync-note" role="status" data-sync-status={status}
       className={"mt-1 text-[12px] leading-snug text-subtle " + className}>
      {text}
    </p>
  );
}

/**
 * @param {object}   props.loc          verdict location ({ state, stateAbbr }) or null
 * @param {boolean}  props.hasLocation  the reader set a place of their own
 * @param {string}   props.scope        "near" | "us"
 * @param {object}   props.dataset      data-sync `dataset` ({ recalls, sources }), or null
 * @param {object}   props.sync         { status, lastSynced } from data-sync
 * @param {Function} props.onChangeScope (next, via) => void — App's changeScope
 * @param {Function} props.onOpenRecall (record) => void
 * @param {Function} props.onBrowseAll  () => void — the full list with filters
 */
export default function LatestRecalls({
  loc, hasLocation, scope, dataset, sync, onChangeScope, onOpenRecall, onBrowseAll, category = "all", onClearCategory,
}) {
  const L = resolveLoc(loc);
  const us = scope === "us" || !hasLocation || !L;
  const abbr = L && L.stateAbbr;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [us, abbr, category]);

  const records = dataset ? dataset.recalls : null;
  const scoped = useMemo(() => latestInScope(records, { us, loc: L }), [records, us, abbr]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => (category === "all" ? scoped : scoped.filter((r) => inPrimary(r, category))), [scoped, category]);
  const freshness = useMemo(() => (dataset ? freshnessOf(dataset) : []), [dataset]);
  const status = (sync && sync.status) || "empty";
  const fdaGap = !!records && sorted.length > 0 && fdaMissing(freshness, sorted);
  /* Skeleton only while there is nothing on the device yet and a sync is
   * (or is about to be) on its way. A failed first sync is said, below. */
  const loading = !records && (status === "empty" || status === "syncing");
  const failedEmpty = !records && (status === "offline" || status === "error");
  const shown = sorted.slice(0, limit);
  const remaining = sorted.length - shown.length;
  const place = us ? "in the US" : `in ${abbr}`;
  const noun = category === "all" ? "" : primaryNoun(category);
  const asOf = oldestAsOf(freshness);
  const anyStale = freshness.some((e) => e.stale);

  /* Rows fade in on the list's first render with data, and never again — a
   * scope switch or a filter is an answer, and answers should not perform. */
  const animatedRef = useRef(false);
  const animate = !animatedRef.current && shown.length > 0;
  useEffect(() => { if (shown.length) animatedRef.current = true; }, [shown.length]);

  return (
    <section aria-labelledby="latest-title" className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h2 id="latest-title" className="section-title text-paper">Latest recalls</h2>
        <ScopeSwitch scope={us ? "us" : "near"} stateAbbr={hasLocation ? abbr : null}
                     onChange={(next) => onChangeScope(next, "home_list")} />
      </div>
      {/* One line: how many, and the oldest agency date among what was read —
          the honest bound on "a recall after this may not be here yet". The
          per-agency dates sit under the list. */}
      <p className="tnum mt-1 min-h-5 truncate text-[13px] leading-relaxed text-subtle" id="latest-count">
        {!loading && !failedEmpty && (
          <>
            {/* The number is on the category pills; this line says what the
                list is and how fresh it is. */}
            {noun ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} recalls active ${place}` : `Active ${place}, newest first`}
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
      <SyncNote status={status} lastSynced={sync && sync.lastSynced} hasData={!!records} />
      {fdaGap && <FdaGapNote className="mt-2" />}

      <ul aria-busy={loading || undefined} aria-describedby="latest-count" className="mt-3 flex flex-col">
        {loading
          ? [0, 1, 2, 3, 4].map((i) => <RowSkeleton key={i} />)
          : shown.map((r, i) => (
            <RecallRow key={r.id} recall={r} onOpen={onOpenRecall} inState={us ? null : abbr}
                       index={i} animate={animate} />
          ))}
      </ul>

      {failedEmpty && (
        <p className="card mt-2 px-5 py-5 text-[14px] leading-relaxed text-fog">
          {status === "offline"
            ? "You're offline, and recall data hasn't been saved on this device yet. Connect once and it stays available offline."
            : "The recall data didn't load. Nothing has been checked yet — this is not an empty result."}
        </p>
      )}

      {!loading && !failedEmpty && !sorted.length && (
        <div className="card mt-2 px-5 py-5 text-[14px] leading-relaxed text-fog">
          <p>
            No active {noun ? `${noun} ` : ""}recall {us ? "in the notices we read" : `naming ${abbr}, or nationwide, in the notices we read`}
            {asOf ? ` (data as of ${fmtAsOf(asOf)})` : ""}.
            That is a statement about these notices, not about any product — search above to check a specific one.
          </p>
          {noun && scoped.length > 0 && onClearCategory && (
            <button type="button" onClick={onClearCategory}
                    className="tap mt-2 inline-flex items-center gap-1 text-[14px] font-semibold text-mint hover:underline">
              Show all {scoped.length.toLocaleString("en-US")} active {place} <ArrowRight aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-col items-center gap-4">
        {remaining > 0 && (
          <Button type="button" variant="secondary" onClick={() => setLimit((n) => n + PAGE)} className="min-w-40">
            Show more
          </Button>
        )}
        {!loading && !failedEmpty && onBrowseAll && (
          <button type="button" onClick={onBrowseAll}
                  className="tap inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-mint hover:underline">
            Browse all with filters <ArrowRight aria-hidden="true" className="size-4" />
          </button>
        )}
        {!loading && freshness.length > 0 && <FreshnessLine entries={freshness} className="text-center" />}
      </div>
    </section>
  );
}
