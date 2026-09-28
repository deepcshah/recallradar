import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RotateCw, Search, SearchX, TrendingUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import VerdictCard from "@/components/VerdictCard";
import { loadIndex, searchIndex, trending, liveLookup } from "@/lib/search-index";
import { verdictFor, resolveLoc, VERDICTS } from "@/lib/verdict";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * "HEARD ABOUT A RECALL?" — search the whole country, answer for one state
 *
 * The rest of the app starts from a place and asks what reached it. People
 * mostly arrive the other way round: they saw a headline about a sausage and
 * want to know whether it is *their* sausage. This searches the national
 * index (every FDA, USDA and CPSC notice for the last year, ended ones
 * included) and answers each hit with verdictFor, grouped by that answer:
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
 * 2. "Not checked" is not "not found". When the index could not get FDA data
 *    (`sources.fda.ok === false`) — or simply has no FDA hit for the query —
 *    openFDA is asked directly through liveLookup, and while that is in
 *    flight the page says so. If that fails too, the empty-state headline
 *    stops claiming anything about the FDA.
 *
 * 3. Without a location there is no verdict, only coverage. Every card then
 *    offers the one thing that would turn "sent to AZ, NM, TX" into an answer:
 *    a ZIP.
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
const TRENDING_N = 6;

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

const isFda = (r) => String(r && r.source).startsWith("FDA");

/* ───────────────────────────── grouping ────────────────────────────────── */

export function groupsFor(records, loc) {
  const L = resolveLoc(loc);
  const order = L
    ? [
        [VERDICTS.IN_AREA, "In your area"],
        [VERDICTS.UNSTATED, "Region not stated"],
        [VERDICTS.NOT_LISTED, `Not reported in ${L.state}`],
        [VERDICTS.ENDED, "Ended"],
      ]
    : [
        [VERDICTS.NEEDS_LOCATION, "Where the notices say they went"],
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

/* ───────────────────────────── the ZIP prompt ──────────────────────────── */

function ZipPrompt({ onSubmit, inputRef }) {
  const [zip, setZip] = useState("");
  const ok = /^\d{5}$/.test(zip);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2 px-3.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(zip);
      }}
    >
      <label htmlFor="rs-zip" className="min-w-[12rem] flex-1 text-[13px] leading-snug text-fog">
        <span className="font-semibold text-paper">Add your ZIP to see if it reached you.</span>{" "}
        Only your state is used to answer.
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id="rs-zip"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={5}
          placeholder="ZIP"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
          className="tnum h-10 w-24 rounded-lg border border-line-strong bg-panel px-3 text-sm text-paper shadow-[var(--rr-field)] placeholder:text-subtle focus-visible:border-mint/60 focus-visible:outline-none"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!ok} className="h-10">
          Check
        </Button>
      </div>
    </form>
  );
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
  if (!src.ok) return src.fetchedAt ? `last good copy ${ago(src.fetchedAt)}` : "not in the index";
  return `${src.count} notices · updated ${ago(src.fetchedAt)}`;
}

function NothingFound({ query, index, live, fdaChecked }) {
  const s = (index && index.sources) || {};
  const span = lookbackPhrase(index && index.lookbackDays);
  const fdaInIndex = !!(s.fda && s.fda.ok);

  let fdaLine;
  if (fdaInIndex) fdaLine = freshness(s.fda);
  else if (live.status === "pending") fdaLine = "not in today's index · checking openFDA directly…";
  else if (live.status === "done") fdaLine = "not in today's index · checked openFDA directly just now";
  else if (live.status === "idle") fdaLine = `not in today's index · type ${LIVE_MIN_CHARS}+ letters to check openFDA directly`;
  else fdaLine = "not in today's index, and openFDA couldn't be reached — not checked";

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
 * @param {Function} [props.onOpenRecall]    (record) => void, when a card is opened
 * @param {string}   [props.initialRecallId] open this recall's card on load (/r/:id deep links)
 * @param {boolean}  [props.autoFocus]       focus the search box on mount
 * @param {Function} [props.onRequestLocation] (zip: string) => void; with loc null,
 *                                           a ZIP form is shown and calls this
 * @param {Function} [props.onSearch]      ({ query, results, live }) => void, once per
 *                                           query that has settled (see SETTLED_MS)
 * @param {string}   [props.className]
 */
export default function RecallSearch({
  loc, onOpenRecall, initialRecallId, autoFocus = false, onRequestLocation, onSearch, className,
}) {
  const [index, setIndex] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loadTry, setLoadTry] = useState(0);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");               // debounced
  const [openId, setOpenId] = useState(initialRecallId || null);
  const [live, setLive] = useState({ q: "", status: "idle", records: [] });
  const liveCache = useRef(new Map());
  const inputRef = useRef(null);
  const zipRef = useRef(null);
  const L = resolveLoc(loc);

  // ── the index ──────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoadError("");
    loadIndex()
      .then((ix) => { if (alive) setIndex(ix); })
      .catch((err) => { if (alive) setLoadError((err && err.message) || "couldn't load"); });
    return () => { alive = false; };
  }, [loadTry]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (initialRecallId) setOpenId(initialRecallId);
  }, [initialRecallId]);

  // ── typing ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const hits = useMemo(
    () => (index && q ? searchIndex(index, q, { limit: RESULT_LIMIT }) : []),
    [index, q],
  );

  const fdaInIndex = !!(index && index.sources && index.sources.fda && index.sources.fda.ok);
  const wantLive = !!index && q.length >= LIVE_MIN_CHARS && (!fdaInIndex || !hits.some(isFda));

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

  const results = useMemo(() => {
    if (!q) return [];
    const seen = new Set(hits.map((r) => r.id));
    const extra = live.q === q ? live.records.filter((r) => r && !seen.has(r.id)) : [];
    return [...hits, ...extra];
  }, [hits, live, q]);

  const groups = useMemo(() => groupsFor(results, L), [results, L && L.stateAbbr]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Reported once per settled query, through a ref so a parent passing a
   * fresh callback each render cannot re-fire it. The count is read when the
   * timer fires, which is after any live FDA answer has had its 500ms. */
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const resultsRef = useRef(0);
  resultsRef.current = results.length;
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

  const chips = useMemo(() => (index ? trending(index, TRENDING_N) : []), [index]);

  const pinned = useMemo(() => {
    if (!initialRecallId || !index) return null;
    return index.recalls.find((r) => r.id === initialRecallId) || null;
  }, [index, initialRecallId]);

  /* The callback runs outside the state updater: StrictMode calls updaters
   * twice, and onOpenRecall is typically analytics or a URL change. */
  const toggle = useCallback((r) => {
    const opening = openId !== r.id;
    setOpenId(opening ? r.id : null);
    if (opening && onOpenRecall) onOpenRecall(r);
  }, [openId, onOpenRecall]);

  const focusZip = useCallback(() => {
    const el = zipRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, []);

  const showZip = !L && typeof onRequestLocation === "function";
  const cardZip = showZip ? focusZip : undefined;
  const livePending = live.q === q && live.status === "pending";
  const liveFailed = live.q === q && live.status === "error";
  const fdaChecked = fdaInIndex || (live.q === q && live.status === "done");

  let n = 0; // running index for the staggered entrance

  return (
    <section className={cn("flex flex-col gap-4", className)} aria-label="Search recalls">
      {/* ── the box ── */}
      <div>
        <label htmlFor="rs-query" className="mb-2 block text-lg font-bold leading-tight text-paper sm:text-xl">
          Heard about a recall? Search it
        </label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-subtle" />
          <input
            ref={inputRef}
            id="rs-query"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Product, brand or barcode"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
            className={cn(
              "h-13 w-full rounded-xl border border-line-strong bg-panel-2 pr-12 pl-11 text-base text-paper",
              "shadow-[var(--rr-field)] transition-shadow placeholder:text-subtle",
              "focus-visible:border-mint/60 focus-visible:outline-none",
              "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
              "[&::-webkit-search-cancel-button]:appearance-none",
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 grid size-10 -translate-y-1/2 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      {showZip && <ZipPrompt onSubmit={onRequestLocation} inputRef={zipRef} />}

      {/* ── loading / failure ── */}
      {!index && !loadError && (
        <p className="flex items-center gap-2 text-[13px] text-fog" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading every recall from the last year…
        </p>
      )}
      {loadError && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel-2 px-3.5 py-3" role="alert">
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-fog">
            <span className="font-semibold text-paper">The recall index didn't load.</span>{" "}
            Nothing has been searched yet — this is not an empty result.
          </p>
          <Button type="button" size="sm" variant="secondary" onClick={() => setLoadTry((x) => x + 1)}>
            <RotateCw aria-hidden="true" /> Try again
          </Button>
        </div>
      )}

      {/* ── a linked recall (/r/:id) ── */}
      {!q && initialRecallId && index && (
        pinned ? (
          <VerdictCard
            recall={pinned}
            loc={L}
            eyebrow="Shared with you"
            expanded={openId === pinned.id}
            onToggle={() => toggle(pinned)}
            onRequestLocation={cardZip}
            className="fade-item"
          />
        ) : (
          <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[13px] leading-relaxed text-fog">
            The shared recall isn't in our index of {lookbackPhrase(index.lookbackDays)} — it may be
            older, or its notice may have been withdrawn. Try searching for the product by name.
          </p>
        )
      )}

      {/* ── empty box: trending ── */}
      {!q && index && chips.length > 0 && (
        <div>
          <p className="microlabel flex items-center gap-1.5">
            <TrendingUp aria-hidden="true" className="size-3.5" /> Recent serious recalls
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c.id || c.query}
                type="button"
                onClick={() => { setQuery(c.query); setQ(c.query); }}
                className="chip chip-off"
              >
                {/* .chip is unlayered CSS and outranks utilities on the same
                 * element, so the case and tracking reset lives on a child —
                 * the same move App.jsx makes. These are content, not labels. */}
                <span className="text-[12px] normal-case tracking-normal">{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── results ── */}
      {q && index && (
        <div className="flex flex-col gap-4">
          <p className="sr-only" role="status" aria-live="polite">
            {results.length
              ? `${results.length} ${results.length === 1 ? "recall matches" : "recalls match"} ${q}`
              : livePending ? `Checking FDA for ${q}` : `No recall matches ${q}`}
          </p>

          {(livePending || (liveFailed && !fdaInIndex && results.length > 0)) && (
            <p className="flex items-center gap-2 text-xs text-fog">
              {livePending && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              {livePending
                ? "Checking FDA directly…"
                : "openFDA couldn't be reached, so FDA recalls aren't included below."}
            </p>
          )}

          {groups.map((g) => (
            <div key={g.key}>
              <h3 className="microlabel mb-2">
                {g.label} <span className="tnum font-normal">· {g.records.length}</span>
              </h3>
              <ul className="flex flex-col gap-2.5">
                {g.records.map((r) => (
                  <li key={r.id}>
                    <VerdictCard
                      recall={r}
                      loc={L}
                      expanded={openId === r.id}
                      onToggle={() => toggle(r)}
                      onRequestLocation={cardZip}
                      className="fade-item"
                      style={{ animationDelay: `calc(var(--rr-card-stagger, 50ms) * ${Math.min(n++, 8)})` }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {!results.length && !livePending && (
            <NothingFound query={q} index={index} live={live.q === q ? live : { status: "idle" }} fdaChecked={fdaChecked} />
          )}
          {!results.length && livePending && (
            <p className="text-[13px] text-fog">
              Nothing in the USDA or CPSC notices for “{q}”. Still waiting on FDA before saying more.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
