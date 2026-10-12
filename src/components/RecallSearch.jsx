import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RotateCw, ScanLine, Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import RecallRow, { shortVerdict, rowDate } from "@/components/RecallRow";
import FreshnessLine, { fmtAsOf, oldestAsOf } from "@/components/FreshnessLine";
import { prepareSearch, searchIndex, liveLookup } from "@/lib/search-index";
import { verdictFor, resolveLoc, VERDICTS } from "@/lib/verdict";
import { relevanceOf } from "@/lib/relevance";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * "HEARD ABOUT A RECALL?" — search the whole country, answer for one state
 *
 * The rest of the app starts from a place and asks what reached it. People
 * mostly arrive the other way round: they saw a headline about a sausage and
 * want to know whether it is *their* sausage. This searches the local
 * copy of our database (lib/data-sync.js: every FDA, USDA and CPSC notice
 * for the last year, ended ones included) and answers each hit with verdictFor, grouped by that answer:
 *
 *   In your area            the notice names your state, or nationwide
 *   Region not stated       the notice names nowhere — not the same as "nowhere"
 *   Not reported in <ST>    it names states and yours isn't one
 *   Ended                   the agency closed it; the product may still be in a cupboard
 *
 * Three honesty rules decide most of what is on screen:
 *
 * 1. An empty result says what was checked. "No results" after a search is
 *    read as "not recalled", so the nothing-found state lists each agency, how
 *    fresh our copy of it is, and what no agency here covers at all (cars,
 *    car seats, boats, pesticides). It is grey, never green, and never says
 *    "safe".
 *
 * 2. "Not checked" is not "not found". When the database could not get FDA
 *    data (`sources.fda.ok === false`) — or holds no strong match for the
 *    query at all — openFDA is asked directly through liveLookup, as a last
 *    resort, and while that is in flight the page says so. Rows that came
 *    from it are labelled "From FDA directly". If it fails too, the
 *    empty-state headline stops claiming anything about the FDA.
 *
 * 3. Without a location there is no verdict, only coverage. Each row then
 *    says where the notice sent it ("Sent to AZ, NM, TX"), and the opened
 *    recall offers "Check your state", which opens the location picker.
 *
 * Search is always national, in both scopes — "is the thing on the news
 * mine?" must never be scoped away. The global scope switch changes framing
 * only: Near me orders rows by the verdict for your state; All US keeps
 * search order ("3 recalls across the US"). Every row carries its verdict as
 * one short line; the full answer (quote, state map, follow, share) is the
 * recall sheet a tap opens.
 * ───────────────────────────────────────────────────────────────────────── */

const DEBOUNCE_MS = 80;
/* openFDA is a rate-limited public API and this fires as people type, so it
 * waits for a pause in typing that the index search does not need to. */
const LIVE_DEBOUNCE_MS = 500;
const LIVE_MIN_CHARS = 3;
const RESULT_LIMIT = 40;
/* The box searches as you type, so there is no submit to count. A query that
 * has sat unchanged this long is one somebody actually read the answer to;
 * anything shorter is a word on its way to being another word. */
const SETTLED_MS = 1200;

const NOT_COVERED = "vehicles & car seats (NHTSA), boats (Coast Guard), pesticides (EPA)";

function lookbackPhrase(days) {
  const d = Number(days) || 365;
  if (d >= 360 && d <= 370) return "the last 12 months";
  if (d % 30 === 0 && d >= 60) return `the last ${d / 30} months`;
  return `the last ${d} days`;
}

const rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  : null;

function ago(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((t - Date.now()) / 60000);
  if (!rtf) return new Date(t).toLocaleDateString();
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 36) return rtf.format(hrs, "hour");
  return rtf.format(Math.round(hrs / 24), "day");
}


/* ───────────────────────────── grouping ────────────────────────────────── */

export function groupsFor(records, loc) {
  const L = resolveLoc(loc);
  const order = L
    ? [
        [VERDICTS.IN_AREA, `In ${L.state}`],
        [VERDICTS.UNSTATED, "Region not stated"],
        [VERDICTS.ANNOUNCED, "Announced, not yet classified"],
        [VERDICTS.NOT_LISTED, `Not reported in ${L.state}`],
        [VERDICTS.ENDED, "Ended"],
      ]
    : [
        [VERDICTS.NEEDS_LOCATION, "Where the notices say they went"],
        [VERDICTS.ANNOUNCED, "Announced, not yet classified"],
        [VERDICTS.ENDED, "Ended"],
      ];
  const buckets = new Map(order.map(([k]) => [k, []]));
  for (const r of records) {
    const v = verdictFor(r, L).verdict;
    (buckets.get(v) || buckets.get(order[0][0])).push(r);
  }
  return order
    .map(([key, label]) => ({ key, label, records: buckets.get(key) }))
    .filter((g) => g.records.length);
}

/* ───────────────────────────── nothing found ───────────────────────────── */

function SourceRow({ name, covers, children }) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="text-[13px] font-semibold text-paper">
        {name} <span className="font-normal text-fog">— {covers}</span>
      </span>
      <span className="text-xs text-subtle sm:ml-auto sm:text-right">{children}</span>
    </li>
  );
}

function freshness(src) {
  if (!src) return "not in the index";
  const at = src.syncedAt || src.fetchedAt;
  if (!src.ok) return at ? `last good copy ${ago(at)}` : "not in the index";
  return `${src.count} notices · updated ${ago(at)}`;
}

function NothingFound({ query, index, live, fdaChecked, freshness: fresh }) {
  const s = (index && index.sources) || {};
  const span = lookbackPhrase(index && index.lookbackDays);
  const fdaInIndex = !!(s.fda && s.fda.ok);

  let fdaLine;
  if (fdaInIndex) fdaLine = freshness(s.fda);
  else if (live.status === "pending") fdaLine = "not in our database · checking openFDA directly…";
  else if (live.status === "done") {
    const asOf = live.records && live.records.lastUpdated;
    fdaLine = asOf
      ? `not in our database · checked openFDA directly: its data runs to ${fmtAsOf(asOf)}`
      : "not in our database · checked openFDA directly just now";
  }
  else if (live.status === "idle") fdaLine = `not in our database · type ${LIVE_MIN_CHARS}+ letters to check openFDA directly`;
  else fdaLine = "not in our database, and openFDA couldn't be reached — not checked";

  return (
    <div className="fade-item rounded-xl border border-dashed border-line bg-panel-2/40 px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-panel-3">
          <SearchX aria-hidden="true" className="size-4 text-fog" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug text-paper">
            {fdaChecked
              ? <>No FDA, USDA or CPSC recall matches “{query}” in {span}.</>
              : <>No USDA or CPSC recall matches “{query}” in {span}. FDA recalls couldn't be checked just now.</>}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fog">
            That means no notice we hold uses those words — not that the product has never been
            recalled, and not that any particular package is fine.
          </p>
        </div>
      </div>

      <p className="microlabel mt-4">Checked</p>
      <ul className="mt-1 divide-y divide-line">
        <SourceRow name="FDA" covers="food, drugs, medical devices">{fdaLine}</SourceRow>
        <SourceRow name="USDA FSIS" covers="meat, poultry, eggs">{freshness(s.fsis)}</SourceRow>
        <SourceRow name="CPSC" covers="consumer products">{freshness(s.cpsc)}</SourceRow>
      </ul>

      {fresh && fresh.length > 0 && (() => {
        const fda = fresh.find((e) => e.source === "FDA");
        const oldest = oldestAsOf(fresh);
        const asked = live.status === "done" ? "no matching recall" : live.status === "pending" ? "still checking" : "couldn't be reached";
        return (
          <div className="mt-4 space-y-1">
            <FreshnessLine entries={fresh} variant="block" />
            {oldest && (
              <p className="text-[12px] leading-snug text-subtle">
                A recall announced after {fmtAsOf(oldest)} may not be here yet.
              </p>
            )}
            {fda && !fda.asOf && (
              <p className="text-[12px] leading-snug text-subtle">
                FDA couldn't be checked from our copy. We asked FDA directly: {asked}.
              </p>
            )}
            {/* openFDA publishes a recall in the weekly enforcement report
                after FDA classifies it, so a recall in this week's news can
                be missing from data that is otherwise current. Say so with
                FDA's own date, or the empty result reads as an answer. */}
            {live.status === "done" && live.records && live.records.lastUpdated && (
              <p className="text-[12px] leading-snug text-subtle">
                FDA's recall data runs to {fmtAsOf(live.records.lastUpdated)}. FDA adds a recall to it
                in the weekly report after classifying it, so one in the news since then may not be
                here yet — the official notice is on fda.gov.
              </p>
            )}
          </div>
        );
      })()}

      <p className="microlabel mt-4">Not covered here</p>
      <p className="mt-1 text-[13px] leading-relaxed text-fog">{NOT_COVERED}.</p>

      <p className="microlabel mt-4">Try</p>
      <ul className="mt-1 list-disc pl-5 text-[13px] leading-relaxed text-fog">
        <li>the brand on the package, or the company name (notices often use the maker, not the store brand)</li>
        <li>one distinctive word — “sausage” rather than “Italian pork sausage links”</li>
        <li>the barcode number, if you have the package</li>
      </ul>
    </div>
  );
}

/* ───────────────────────────── the component ───────────────────────────── */

/**
 * @param {object}   props
 * @param {object}   [props.loc]             { state, stateAbbr } or null
 * @param {object}   [props.index]           data-sync `dataset` ({ recalls, sources }), or null
 * @param {Map}      [props.byId]            data-sync `byId`
 * @param {string}   [props.dataStatus]      data-sync `status`
 * @param {boolean}  [props.dataPartial]     data-sync `partial` (stored months still being read)
 * @param {Function} [props.onRetry]         () => void, retry a failed first sync
 * @param {Function} [props.onOpenRecall]    (record) => void, a result row was tapped
 *                                           (the page opens the recall sheet)
 * @param {string}   [props.initialRecallId] a shared recall (/r/:id deep links)
 * @param {Function} [props.onOpenShared]    (record) => void, once, when that
 *                                           shared record is known
 * @param {Function} [props.onScan]          () => void; the barcode button in the field
 * @param {node}     [props.children]        shown under the box while nothing is typed
 * @param {boolean}  [props.autoFocus]       focus the search box on mount
 * @param {string}   [props.scope]           "near" | "us" — framing only (see top)
 * @param {object[]} [props.freshness]       freshnessOf() entries, for empty
 *                                           results and "not reported" cards
 * @param {Function} [props.onSearch]      ({ query, results, live }) => void, once per
 *                                           query that has settled (see SETTLED_MS)
 * @param {string}   [props.className]
 */
export default function RecallSearch({
  loc, onOpenRecall, onOpenShared, initialRecallId, autoFocus = false, onSearch, onScan, className,
  scope = "near", freshness, children, index = null, byId = null, dataStatus = "empty", dataPartial = false, onRetry,
}) {
  /* Nothing on the device and the sync could not get any: say so, rather
   * than spin. With data on the device, a failed refresh is the list's
   * business (LatestRecalls' SyncNote), not search's. */
  const loadError = !index && (dataStatus === "offline" || dataStatus === "error") ? dataStatus : "";
  /* Still fetching chunks beyond `latest`: a miss is not yet a miss. */
  const complete = !!index && !dataPartial && dataStatus !== "syncing" && dataStatus !== "empty";
  const [engineRev, setEngineRev] = useState(0);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");               // debounced
  const [live, setLive] = useState({ q: "", status: "idle", records: [] });
  const liveCache = useRef(new Map());
  const inputRef = useRef(null);
  const L = resolveLoc(loc);
  const flat = scope === "us" || !L;

  // ── the search engine, built off the critical path ─────────────────────
  useEffect(() => {
    if (!index) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      prepareSearch(index).then(() => { if (alive) setEngineRev((x) => x + 1); }).catch(() => { /* scan fallback */ });
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [index]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // ── typing ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const hits = useMemo(
    () => (index && q ? searchIndex(index, q, { limit: RESULT_LIMIT }) : []),
    [index, q, engineRev], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const fdaInIndex = !!(index && index.sources && index.sources.fda && index.sources.fda.ok);
  /* /api/lookup is the last resort, asked only when the local database has
   * no strong match (a cookie whose ingredient list mentions sugar is not a
   * strong match for "sugar"), or has no FDA data at all — and only once the
   * whole database is on the device, so a month still downloading is not
   * mistaken for a miss. A barcode has no "strong": any hit is the answer. */
  const strongLocal = /^\d[\d\s-]*$/.test(q) ? hits.length > 0 : hits.some((r) => relevanceOf(r, q) >= 2);
  const wantLive = complete && q.length >= LIVE_MIN_CHARS && (!fdaInIndex || !strongLocal);

  /* openFDA, directly — see rule 2 at the top. One request per settled query,
   * cached for the life of the component so backspacing to an earlier query
   * does not ask again, and a late answer for an old query is dropped. */
  useEffect(() => {
    if (!wantLive) { setLive({ q, status: "idle", records: [] }); return; }
    const cached = liveCache.current.get(q);
    if (cached) { setLive(cached); return; }
    let current = true;
    setLive({ q, status: "pending", records: [] });
    const t = setTimeout(() => {
      liveLookup(q)
        .then((records) => {
          const v = { q, status: "done", records };
          liveCache.current.set(q, v);
          if (current) setLive(v);
        })
        .catch(() => {
          // Not cached: a failure is worth retrying on the next search.
          if (current) setLive({ q, status: "error", records: [] });
        });
    }, LIVE_DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [q, wantLive]);

  /* The same tiers as /api/lookup (src/lib/relevance.js): when something is
   * ABOUT the query — "sugar" in the product's name or the firm's — a notice
   * that only lists it among ingredients is held back, behind a count and a
   * "show them" rather than silently, so nothing is hidden for good. */
  const [showWeak, setShowWeak] = useState(false);
  useEffect(() => { setShowWeak(false); }, [q]);
  const { results, weak } = useMemo(() => {
    if (!q) return { results: [], weak: [] };
    const seen = new Set(hits.map((r) => r.id));
    const extra = live.q === q
      ? live.records.filter((r) => r && !seen.has(r.id)).map((r) => ({ ...r, viaLookup: true }))
      : [];
    const all = [...hits, ...extra];
    if (/^\d[\d\s-]*$/.test(q)) return { results: all, weak: [] }; // a barcode has no "about"
    const rel = new Map(all.map((r) => [r.id, relevanceOf(r, q)]));
    if (![...rel.values()].some((v) => v >= 2)) return { results: all, weak: [] };
    return { results: all.filter((r) => rel.get(r.id) >= 2), weak: all.filter((r) => rel.get(r.id) < 2) };
  }, [hits, live, q]);
  const shown = useMemo(() => (showWeak ? [...results, ...weak] : results), [results, weak, showWeak]);

  /* One list, compact rows, the verdict on each. Near me keeps the order the
   * verdict groups used to impose — in your state, region not stated,
   * announced, not reported, ended — without a heading per group: the line on
   * every row already says it. All US keeps search order (the index's
   * relevance, then what FDA answered live). Ended recalls sink either way:
   * they are the least likely answer. */
  /* Relevance first: someone searching "sugar" wants the sugar recall, even
   * when it went to other states, before a nationwide cough drop that merely
   * mentions sugar. Within a relevance tier, Near me keeps the verdict order
   * (in your state, region not stated, announced, not reported); ended
   * recalls sink either way. The verdict line on each row says where it went. */
  const ordered = useMemo(() => {
    const ended = (r) => (r.status ? r.status === "ended" : r.active === false);
    const groupRank = new Map();
    if (!flat) groupsFor(shown, L).forEach((g, i) => g.records.forEach((r) => groupRank.set(r.id, i)));
    const pos = new Map(shown.map((r, i) => [r.id, i]));
    const rel = new Map(shown.map((r) => [r.id, relevanceOf(r, q)]));
    return [...shown].sort((a, b) =>
      (ended(a) - ended(b)) ||
      (rel.get(b.id) - rel.get(a.id)) ||
      ((groupRank.get(a.id) ?? 0) - (groupRank.get(b.id) ?? 0)) ||
      (pos.get(a.id) - pos.get(b.id)));
  }, [shown, flat, q, L && L.stateAbbr]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Reported once per settled query, through a ref so a parent passing a
   * fresh callback each render cannot re-fire it. The count is read when the
   * timer fires, which is after any live FDA answer has had its 500ms. */
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const resultsRef = useRef(0);
  resultsRef.current = shown.length;
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!q || !index || !onSearchRef.current) return undefined;
    const t = setTimeout(() => {
      const lv = liveRef.current;
      onSearchRef.current({ query: q, results: resultsRef.current, live: lv.q === q ? lv.status : "idle" });
    }, SETTLED_MS);
    return () => clearTimeout(t);
  }, [q, index]);

  const inIndex = useMemo(() => {
    if (!initialRecallId || !index) return null;
    return (byId && byId.get(initialRecallId)) || index.recalls.find((r) => r.id === initialRecallId) || null;
  }, [index, byId, initialRecallId]);

  /* A shared id the local database lacks once it is complete — it can lag a
   * refresh, and an FDA id can be answered from openFDA directly — is asked
   * of /api/share before the card says it couldn't be found. */
  const [fetched, setFetched] = useState({ id: null, status: "idle", record: null });
  useEffect(() => {
    if (!initialRecallId || !complete || inIndex || fetched.id === initialRecallId) return;
    let alive = true;
    setFetched({ id: initialRecallId, status: "pending", record: null });
    fetch(`/api/share?format=json&id=${encodeURIComponent(initialRecallId)}`, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (alive) setFetched({ id: initialRecallId, status: "done", record: (b && b.record) || null }); })
      .catch(() => { if (alive) setFetched({ id: initialRecallId, status: "done", record: null }); });
    return () => { alive = false; };
  }, [initialRecallId, complete, inIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinned = inIndex || (fetched.id === initialRecallId ? fetched.record : null);
  const pinnedPending = !inIndex && fetched.id === initialRecallId && fetched.status === "pending";

  /* A shared link opens its recall in the app's sheet, once, as soon as the
   * record is known (App tracks that view itself). */
  const sharedOpenedRef = useRef(null);
  useEffect(() => {
    if (!pinned || sharedOpenedRef.current === pinned.id) return;
    sharedOpenedRef.current = pinned.id;
    if (onOpenShared) onOpenShared(pinned);
  }, [pinned]); // eslint-disable-line react-hooks/exhaustive-deps

  const livePending = live.q === q && live.status === "pending";
  const liveFailed = live.q === q && live.status === "error";
  const fdaChecked = fdaInIndex || (live.q === q && live.status === "done");

  const count = ordered.length;
  const stateName = L && L.state;

  return (
    <section className={cn("flex flex-col", className)} aria-label="Search recalls">
      {/* ── the box ── */}
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-paper sm:text-[32px]">
          <label htmlFor="rs-query">Is it recalled?</label>
        </h1>
        <p className="mt-1.5 text-[15px] leading-snug text-fog">
          Check what you own, or plan to buy.
        </p>
        <div className="relative mt-4">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-subtle" />
          <input
            ref={inputRef}
            id="rs-query"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search a product or brand"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
            className={cn(
              "h-14 w-full rounded-2xl border border-line-strong bg-panel pl-12 text-[16px] text-paper",
              onScan ? (query ? "pr-24" : "pr-14") : "pr-12",
              "shadow-[var(--rr-field)] transition-shadow placeholder:text-subtle",
              "focus-visible:border-mint/60 focus-visible:outline-none",
              "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
              "[&::-webkit-search-cancel-button]:appearance-none",
            )}
          />
          <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                aria-label="Clear search"
                className="grid size-11 place-items-center rounded-xl text-fog hover:bg-panel-3 hover:text-paper"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            )}
            {onScan && (
              <button
                id="btn-scan"
                type="button"
                onClick={onScan}
                aria-label="Scan a barcode"
                title="Scan a barcode"
                className="grid size-11 place-items-center rounded-xl text-fog hover:bg-panel-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
              >
                <ScanLine aria-hidden="true" className="size-5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── loading / failure ── */}
      {!index && !loadError && (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-fog" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading every recall from the last year…
        </p>
      )}
      {loadError && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel-2 px-3.5 py-3" role="alert">
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-fog">
            <span className="font-semibold text-paper">
              {loadError === "offline" ? "You're offline, and no recall data is saved on this device yet." : "The recall data didn't load."}
            </span>{" "}
            Nothing has been searched yet — this is not an empty result.
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={() => onRetry && onRetry()}>
            <RotateCw aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {/* ── a linked recall (/r/:id): opened in the sheet; only the waits and
             the miss are said here ── */}
      {!q && initialRecallId && index && !pinned && (
        pinnedPending || fetched.id !== initialRecallId ? (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-fog">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Opening the shared recall…
          </p>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-line px-3.5 py-3 text-[13px] leading-relaxed text-fog">
            We couldn't find the recall in this link ({initialRecallId}) in our index of{" "}
            {lookbackPhrase(index.lookbackDays)} or at FDA — it may be older, or its notice may have been
            withdrawn. Try searching for the product by name.
          </p>
        )
      )}

      {/* ── nothing typed: whatever the page puts here (the latest list) ── */}
      {!q && children && <div className="mt-10">{children}</div>}

      {/* ── results ── */}
      {q && index && (
        <div className="mt-6 flex flex-col">
          <p className="sr-only" role="status" aria-live="polite">
            {results.length
              ? `${results.length} ${results.length === 1 ? "recall matches" : "recalls match"} ${q}`
              : livePending ? `Checking FDA for ${q}` : `No recall matches ${q}`}
          </p>

          {count > 0 && (
            <p className="tnum text-[13px] text-subtle">
              {count} {count === 1 ? "recall" : "recalls"}{flat ? " across the US" : ` · checked for ${stateName}`}
            </p>
          )}

          {(livePending || (liveFailed && !fdaInIndex && results.length > 0)) && (
            <p className="mt-1 flex items-center gap-2 text-xs text-fog">
              {livePending && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              {livePending
                ? "Checking FDA directly…"
                : "openFDA couldn't be reached, so FDA recalls aren't included below."}
            </p>
          )}

          {live.q === q && live.status === "done" && Number(live.records.total) > live.records.length && (
            <p className="mt-1 text-xs text-fog tnum">
              FDA has {live.records.total} matching notices; these are the {live.records.length} closest to “{q}”.
              A more specific word narrows it.
            </p>
          )}

          {count > 0 && (
            <ul className="mt-2 divide-y divide-line border-t border-line">
              {ordered.map((r) => (
                <RecallRow
                  key={r.id}
                  recall={r}
                  verdict={shortVerdict(r, L)}
                  meta={[r.viaLookup ? "From FDA directly" : null, rowDate(r), r.firm].filter(Boolean).join(" · ") || undefined}
                  onOpen={onOpenRecall}
                />
              ))}
            </ul>
          )}

          {weak.length > 0 && (
            <p className="mt-3 text-[12px] leading-snug text-fog">
              {showWeak
                ? <>Including {weak.length} {weak.length === 1 ? "notice" : "notices"} that {weak.length === 1 ? "mentions" : "mention"} “{q}” only in passing. </>
                : <>{weak.length} more {weak.length === 1 ? "notice mentions" : "notices mention"} “{q}” only in passing, such as in an ingredient list. </>}
              <button type="button" onClick={() => setShowWeak((v) => !v)}
                      className="font-semibold text-mint hover:underline">
                {showWeak ? "Hide them" : "Show them"}
              </button>
            </p>
          )}

          {!results.length && !livePending && (
            <NothingFound query={q} index={index} live={live.q === q ? live : { status: "idle" }} fdaChecked={fdaChecked}
                          freshness={freshness} />
          )}
          {!results.length && livePending && (
            <p className="text-[13px] text-fog">
              Nothing in the USDA or CPSC notices for “{q}”. Still waiting on FDA before saying more.
            </p>
          )}
          {count > 0 && freshness && freshness.length > 0 && (
            <FreshnessLine entries={freshness} className="mt-3" />
          )}
        </div>
      )}
    </section>
  );
}
