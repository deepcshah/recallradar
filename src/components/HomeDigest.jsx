/* ─────────────────────────────────────────────────────────────────────────
 * HOME DIGEST — the quick check
 *
 * The first thing on the home screen, and the answer comes before the list:
 *
 *     This week in CA: 2 new food recalls · 1 serious
 *     Most serious: Listeria in bagged spinach
 *
 * then three ways in — the aisle rail (stories, see AisleStories.jsx), the
 * products you follow, and the full list / stores — each one tap.
 *
 * Two scopes, one component. "Near me" reads the reader's state; "All US"
 * reads every recall, wherever it went (the global ScopeSwitch decides).
 *
 * Where the records come from. `live` is the app's own list for the current
 * scope — the in-area list, or the national one (/api/recalls?scope=us) —
 * freshly fetched from the live feeds, and is preferred whenever it has
 * anything in it. While it's still loading — or if every live source failed —
 * the national index (public/feeds/index.json, refreshed by a workflow) is
 * read instead: through `recentFor` (the same isInArea rule) for Near me,
 * through `recentForUs` (no area filter) for All US. The digest never mixes
 * the two: two lists with different freshness summed into one count is a
 * number nobody can check. Which one it read is in the freshness line at the
 * bottom, per agency.
 *
 * What it will not say. "Nothing new" is always followed by how many recalls
 * are still in force, and "that we know of" — an empty week is a statement
 * about the notices we read, not about the reader's fridge. No green, no
 * check marks, no "safe"; the only warm colour is the classification badge
 * and the dot on a follow that matched.
 * ───────────────────────────────────────────────────────────────────────── */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronRight, MapPin, Plus, X } from "lucide-react";
import FreshnessLine, { FdaGapNote, fdaMissing } from "@/components/FreshnessLine";
import { Badge } from "@/components/ui/badge";
import AisleStories, { AISLE_ICONS } from "@/components/AisleStories";
import { recentFor, recentForUs, freshnessOf } from "@/lib/search-index";
import { resolveLoc } from "@/lib/verdict";
import { coverageSuffix } from "@/lib/coverage-line";
import { severityLabel, severityVariant } from "@/lib/classification";
import { getFollows, addFollow, removeFollow, matchFollows, FOLLOWS_EVENT } from "@/lib/follows";
import {
  summarize, aislesFor, plainHeadline, getSeen, SEEN_EVENT, visitBaseline, dayOf,
} from "@/lib/digest";
import { cn } from "@/lib/utils";

/* How far back the index fallback reaches. The index holds a year; the
 * digest's own windows are a week (headline) and 30 days (aisles), but the
 * "still in force" total wants everything active, so read it all. */
const INDEX_LOOKBACK_DAYS = 400;

function useFollowsList() {
  const [list, setList] = useState(getFollows);
  useEffect(() => {
    const sync = () => setList(getFollows());
    window.addEventListener(FOLLOWS_EVENT, sync);
    window.addEventListener("storage", sync); // other tabs
    return () => {
      window.removeEventListener(FOLLOWS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return list;
}

function useSeenSet() {
  const [seen, setSeen] = useState(getSeen);
  useEffect(() => {
    const sync = () => setSeen(getSeen());
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SEEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return seen;
}

function fmtDay(d) {
  const day = dayOf(d);
  if (!day) return "";
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}


/* ───────────────────────────── aisle bubble ─────────────────────────────
 * Three states, told apart by the ring and nothing else:
 *   unseen  — a solid ring in the text colour (the stories convention)
 *   seen    — a hairline grey ring
 *   empty   — no ring, dimmed, not pressable
 * The ring is deliberately NOT green: green in this app means "selected" or
 * "go", and a ring round Meat must never read as "meat is fine". */
function AisleBubble({ aisle, unseen, onOpen }) {
  const Icon = AISLE_ICONS[aisle.key];
  const count = aisle.records.length + (aisle.more || 0);
  const empty = count === 0;
  const state = empty ? "empty" : unseen > 0 ? "unseen" : "seen";
  const label = empty
    ? `${aisle.label}: no recent recalls in the notices we read`
    : `${aisle.label}: ${count} recent recall${count === 1 ? "" : "s"}${unseen ? `, ${unseen} not viewed yet` : ", all viewed"}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(aisle.key)}
      disabled={empty}
      aria-label={label}
      title={label}
      className={cn(
        "group flex w-[68px] shrink-0 flex-col items-center gap-1.5 rounded-xl py-1 outline-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mint/60",
        empty && "opacity-45",
      )}
    >
      <span
        className={cn(
          "flex size-[60px] items-center justify-center rounded-full p-[2.5px] transition-transform duration-100",
          !empty && "group-active:scale-95 motion-reduce:group-active:scale-100",
          state === "unseen" && "bg-paper",
          state === "seen" && "bg-line-strong p-[1.5px]",
        )}
      >
        <span
          className={cn(
            "flex size-full items-center justify-center rounded-full bg-panel-2",
            state !== "empty" && "border-[2.5px] border-panel",
            state === "empty" && "border border-dashed border-line-strong",
          )}
        >
          <Icon className={cn("size-6", state === "unseen" ? "text-paper" : "text-fog")} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </span>
      <span className={cn("text-[11px] font-semibold leading-none", state === "unseen" ? "text-paper" : "text-fog")}>
        {aisle.label}
      </span>
      <span className="tnum text-[10px] leading-none text-subtle" aria-hidden="true">
        {empty ? "—" : unseen ? `${unseen} new` : count}
      </span>
    </button>
  );
}

/* ───────────────────────────── follows strip ───────────────────────────── */
function FollowsStrip({ follows, matches, where, noticeLabel, loading, onOpenRecall }) {
  const [draft, setDraft] = useState("");
  const [openTerm, setOpenTerm] = useState(null);
  const byTerm = useMemo(() => new Map(matches.map((m) => [m.term, m.records])), [matches]);
  // Matches first, each group in follow order.
  const ordered = useMemo(
    () => [...follows.filter((t) => byTerm.has(t)), ...follows.filter((t) => !byTerm.has(t))],
    [follows, byTerm],
  );
  const open = openTerm && byTerm.get(openTerm);

  const submit = (e) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    addFollow(t);
    setDraft("");
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="microlabel">Products you follow</h3>
        {matches.length > 0 && (
          <span className="text-[11px] font-semibold text-alert">
            {matches.length} with a recall {where}
          </span>
        )}
      </div>

      {follows.length === 0 ? (
        <p className="text-[13px] leading-snug text-fog">
          Follow what you buy — like “spinach” or “infant formula” — and any recall that names it shows up here first.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Followed products">
          {ordered.map((term) => {
            const hits = byTerm.get(term);
            const on = openTerm === term;
            return (
              <li key={term} className="inline-flex">
                <span
                  className={cn(
                    /* Not `.chip`: that class is unlayered CSS and its padding
                     * and caps would beat any utility here. Same size rule,
                     * though — a thumb-sized box on touch, compact under a mouse. */
                    "inline-flex min-h-[28px] items-stretch overflow-hidden rounded-full border",
                    "shadow-[var(--rr-bevel),var(--rr-shadow-1)] [@media(pointer:coarse)]:min-h-9",
                    hits ? "border-alert-line bg-panel-2 text-paper" : "border-line bg-panel-2 text-fog",
                    on && "border-line-strong bg-panel-3",
                  )}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 pl-3 pr-1.5 text-[12px] font-semibold disabled:cursor-default"
                    onClick={() => hits && setOpenTerm(on ? null : term)}
                    disabled={!hits}
                    aria-expanded={hits ? on : undefined}
                    aria-label={hits ? `${term}: ${hits.length} matching recall${hits.length === 1 ? "" : "s"}` : `${term}: no match in current notices`}
                  >
                    {hits && <span className="size-2 rounded-full bg-alert" aria-hidden="true" />}
                    <span className="max-w-[16ch] truncate">{term}</span>
                    {hits && <span className="tnum text-[11px] text-fog">{hits.length}</span>}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center pl-0.5 pr-2.5 text-subtle hover:text-paper"
                    onClick={() => { removeFollow(term); if (on) setOpenTerm(null); }}
                    aria-label={`Stop following ${term}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <ul className="space-y-1 rounded-xl border border-line bg-panel-2 p-1.5">
          {open.slice(0, 5).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpenRecall && onOpenRecall(r)}
                className="tap flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel-3"
              >
                <Badge variant={severityVariant(r)} className="shrink-0">{severityLabel(r)}</Badge>
                <span className="line-clamp-1 flex-1 text-paper">{plainHeadline(r)}</span>
                <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              </button>
            </li>
          ))}
          {open.length > 5 && (
            <li className="px-2 py-1 text-[12px] text-subtle">+{open.length - 5} more in the full list</li>
          )}
        </ul>
      )}

      {/* Only once there is something to have matched against: "none appear"
          while the list is still loading would be a claim we haven't checked. */}
      {follows.length > 0 && matches.length === 0 && !loading && (
        <p className="text-[12px] leading-snug text-subtle">
          None of these appear in the {noticeLabel} notices we read right now. Matching looks at product and brand names only.
        </p>
      )}

      <form onSubmit={submit} className="flex items-center gap-1.5">
        <label htmlFor="rr-follow-input" className="sr-only">Add a product you buy</label>
        <input
          id="rr-follow-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={60}
          placeholder="Add a product you buy"
          autoComplete="off"
          enterKeyHint="done"
          className={cn(
            "h-9 min-w-0 flex-1 rounded-full border border-line-strong bg-panel-2 px-3.5 text-[13px] text-paper",
            "shadow-[var(--rr-field)] placeholder:text-subtle focus-visible:border-mint/60 focus-visible:outline-none",
            "focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
          )}
        />
        <button type="submit" className="chip chip-off shrink-0" disabled={!draft.trim()}>
          <Plus className="size-3.5" aria-hidden="true" /> Follow
        </button>
      </form>
    </div>
  );
}

/**
 * The quick-check home digest.
 *
 * Props:
 *   loc                { state, stateAbbr } | null — the state verdicts answer in
 *   hasLocation        the reader has set a place of their own (stores need one)
 *   scope              "near" | "us" — see the top of this file
 *   index              the national index (search-index.js loadIndex()), or null while loading
 *   live               { records, sources } for the current scope, or null;
 *                      preferred when it has records
 *   onOpenRecall(r)    open one recall's verdict sheet
 *   onOpenStores()     "Stores near me →" (only offered with a location)
 *   onRequestLocation(reason) opens the location picker
 *   onOpenAll()        optional; "All recalls in ST / the US →"
 *   onEnablePush()     optional; the stories end card's "Get a weekly heads-up"
 *   lastVisit          optional ISO|null; when omitted the component takes the
 *                      baseline itself (digest.js visitBaseline, which calls
 *                      follows.js markVisit once per tab). Pass it if App
 *                      already calls markVisit, or the marker moves twice.
 *   onStorySeen(id)    optional; each story as it is shown (analytics)
 *   onCaughtUp()       optional; the stories' end card was reached (analytics)
 */
export default function HomeDigest({
  loc, hasLocation = false, scope = "near", index, live, onOpenRecall, onOpenStores, onRequestLocation, onOpenAll,
  onEnablePush, lastVisit, onStorySeen, onCaughtUp,
}) {
  const L = resolveLoc(loc);
  const us = scope === "us" || !L;
  const place = us ? null : L.stateAbbr;
  const where = us ? "in the US" : `in ${place}`;
  const [baseline] = useState(() => (lastVisit !== undefined ? lastVisit : visitBaseline()));
  const since = lastVisit !== undefined ? lastVisit : baseline;

  const { records, from, sources } = useMemo(() => {
    if (live && Array.isArray(live.records) && live.records.length) {
      return { records: live.records, from: "live", sources: live.sources || null };
    }
    if (index && Array.isArray(index.recalls)) {
      const recs = us
        ? recentForUs(index, { sinceDays: INDEX_LOOKBACK_DAYS })
        : recentFor(index, loc, { sinceDays: INDEX_LOOKBACK_DAYS });
      return { records: recs, from: "index", sources: null };
    }
    return { records: [], from: "none", sources: null };
  }, [live, index, loc, us]);

  const freshness = useMemo(() => (index || sources ? freshnessOf(index, sources) : []), [index, sources]);
  const fdaGap = from !== "none" && fdaMissing(freshness, records);

  const summary = useMemo(
    () => summarize(records, { loc, scope: us ? "us" : "near", lastVisit: since }),
    [records, loc, us, since],
  );
  const aisles = useMemo(() => aislesFor(records), [records]);
  const seen = useSeenSet();
  const follows = useFollowsList();
  const matches = useMemo(() => matchFollows(records, follows), [records, follows]);

  const [storiesAisle, setStoriesAisle] = useState(null);
  const openStories = useCallback((key) => setStoriesAisle(key), []);
  const closeStories = useCallback(() => setStoriesAisle(null), []);

  const anyAisle = aisles.some((a) => a.records.length);
  const top = summary.top;

  return (
    <section aria-labelledby="rr-digest-title" className="space-y-5 rounded-2xl border border-line bg-panel p-4 shadow-[var(--rr-shadow-2)] sm:p-5">
      {/* ── the answer ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="microlabel">Quick check</span>
          <span className="microlabel text-subtle" aria-label={us ? "Showing all US recalls" : `Showing recalls for ${L.state}`}>
            {us ? "All US" : place}
          </span>
        </div>
        {from === "none" ? (
          <>
            <h2 id="rr-digest-title" className="text-lg font-semibold leading-snug text-paper sm:text-xl">
              Checking the latest recall notices…
            </h2>
            <div className="shimmer h-4 w-2/3 rounded" aria-hidden="true" />
          </>
        ) : (
          <>
            <h2 id="rr-digest-title" className="text-lg font-semibold leading-snug tracking-tight text-paper sm:text-xl">
              {summary.sentence}
              {us && summary.announced > 0 && (
                <span className="text-[14px] font-normal text-fog"> · +{summary.announced} announced, not yet classified</span>
              )}
            </h2>
            {top ? (
              <button
                type="button"
                onClick={() => onOpenRecall && onOpenRecall(top)}
                className="tap group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-panel-3"
              >
                {/* Badge above the line on a phone, beside it where there's room:
                    beside, at 375px, it squeezed the sentence into a column. */}
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
                <Badge variant={severityVariant(top)} className="shrink-0">{severityLabel(top)}</Badge>
                <span className="min-w-0 flex-1 text-[15px] leading-snug text-paper">
                  {/* "Most serious" only when it is: a Class II at the top of
                      an otherwise quiet week is the newest, not the worst. */}
                  <span className="text-fog">{top.severity === "high" ? "Most serious: " : "Newest: "}</span>
                  {plainHeadline(top)}
                  {fmtDay(top.date) && <span className="tnum text-[12px] text-subtle"> · {fmtDay(top.date)}</span>}
                  {us && coverageSuffix(top) && <span className="tnum text-[12px] text-subtle"> · {coverageSuffix(top)}</span>}
                </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-subtle group-hover:text-paper" aria-hidden="true" />
              </button>
            ) : (
              <p className="text-[14px] leading-snug text-fog">{summary.quiet}</p>
            )}
          </>
        )}
        {!hasLocation && onRequestLocation && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[13px] text-fog">
            <span>Set a location to see which of these reached your state.</span>
            <button type="button" onClick={() => onRequestLocation("to show recalls for your state", "digest")}
                    className="tap inline-flex items-center gap-1 font-semibold text-mint hover:underline">
              <MapPin aria-hidden="true" className="size-3.5" /> Set location
            </button>
          </p>
        )}
      </div>

      {/* ── aisle rail ── */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="microlabel">By aisle · last 30 days · {us ? "All US" : place}</h3>
          {!anyAisle && from !== "none" && <span className="text-[11px] text-subtle">No aisle has a recent notice</span>}
        </div>
        <div
          className="-mx-4 flex gap-1 overflow-x-auto px-3 pb-1 sm:-mx-5 sm:px-4 lg:mx-0 lg:justify-between lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: "none" }}
          role="list"
        >
          {aisles.map((a) => (
            <div role="listitem" key={a.key}>
              <AisleBubble
                aisle={a}
                unseen={a.records.filter((r) => !seen.has(r.id)).length}
                onOpen={openStories}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ── follows ── */}
      <FollowsStrip follows={follows} matches={matches} where={where} noticeLabel={us ? "US" : place}
                    loading={from === "none"} onOpenRecall={onOpenRecall} />

      {/* ── what this was read from, and how fresh ── */}
      {(fdaGap || freshness.length > 0) && (
        <div className="space-y-1.5">
          {fdaGap && <FdaGapNote />}
          <FreshnessLine entries={freshness} />
        </div>
      )}

      {/* ── the way out ── */}
      <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-3" aria-label="More">
        {(() => {
          const link = "tap inline-flex items-center gap-1 text-[13px] font-semibold text-mint hover:underline";
          const all = onOpenAll && (
            <button key="all" type="button" onClick={onOpenAll} className={link}>
              All recalls {where} <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          );
          const stores = hasLocation
            ? onOpenStores && (
              <button key="stores" type="button" onClick={onOpenStores} className={link}>
                Stores near me <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            )
            : onRequestLocation && (
              <button key="stores" type="button" onClick={() => onRequestLocation("to find stores near you", "digest")} className={link}>
                Find stores near you <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            );
          return us ? [all, stores] : [stores, all];
        })()}
      </nav>

      <AisleStories
        open={storiesAisle != null}
        aisles={aisles}
        startAisle={storiesAisle}
        loc={loc}
        scope={us ? "us" : "near"}
        onRequestLocation={!hasLocation && onRequestLocation ? () => { closeStories(); onRequestLocation("for alerts", "stories"); } : undefined}
        onClose={closeStories}
        onOpenRecall={onOpenRecall}
        onEnablePush={onEnablePush ? () => { closeStories(); onEnablePush(); } : undefined}
        onSeen={onStorySeen}
        onCaughtUp={onCaughtUp}
      />
    </section>
  );
}
