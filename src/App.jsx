import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Armchair, Baby, Beef, Bell, BellOff, Bike, Candy, Carrot, Check, ChevronDown, ChevronRight, ChevronUp,
  Crosshair, CupSoda, House, Map as MapIcon,
  ExternalLink, Fish, Info, Loader2, MapPin, MapPinOff, Milk, Package,
  PanelRightOpen, PawPrint, Pill, Plug, Plus, Radar, Rows2, Columns2, Search, SearchX,
  ScanLine, ShieldCheck, Soup, Stethoscope, Sun, Moon, MonitorSmartphone, MoreHorizontal, Store,
  ClipboardList, UtensilsCrossed, Wheat, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import LocationButton from "@/components/LocationButton";
import LocationPicker from "@/components/LocationPicker";
import ScopeSwitch from "@/components/ScopeSwitch";
import FreshnessLine, { FdaGapNote, fdaMissing } from "@/components/FreshnessLine";
import { AnnouncedBadge } from "@/components/VerdictCard";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip, InfoTip } from "@/components/ui/tooltip";
import { FilterButton, FilterSheet, FilterGroup, FilterChoice } from "@/components/FilterSheet";
import ScanSheet from "@/components/ScanSheet";
import RecallSearch from "@/components/RecallSearch";
import HomeDigest from "@/components/HomeDigest";
import VerdictCard from "@/components/VerdictCard";
import { Sheet, useSheetPresence } from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { recallUpcs, lookupProduct } from "@/lib/upc";
import { browserPosition, reverseGeocode, geocodeInput, geoError, locLabel } from "@/lib/geo";
import { fetchAll, fetchNational, recoverBlockedSources, sortRecalls } from "@/lib/sources";
import { isInArea, verdictFor, isAnnounced } from "@/lib/verdict";
import { loadIndex, freshnessOf, recentForUs } from "@/lib/search-index";
import { coverageLine } from "@/lib/coverage-line";
import { cleanState } from "@/lib/share";
import { ABBR_TO_NAME } from "@/lib/states";
import { FOLLOWS_EVENT, getFollows, getLastVisit, markVisit } from "@/lib/follows";
import {
  getPushState, needsInstallForPush, pushAvailable, pushSupported, subscribePush, syncPush, unsubscribePush,
} from "@/lib/push";
import { findStores, STORE_CAPS, DEFAULT_STORE_CAP } from "@/lib/stores";
import { byId, DEFAULT_NEARBY_CHAINS } from "@/lib/retailers";
import { categoryFor } from "@/lib/category";
import { classInfo, severityLabel, severityVariant } from "@/lib/classification";
import { reasonFor, REASON_ORDER } from "@/lib/reason";
import { DialRoot } from "dialkit";
import "dialkit/styles.css";
import { useMotionTuning, cardStagger } from "@/lib/tuning";
import { useTheme } from "@/lib/theme";
import { track, miles, searchQueryProp, registerSuper } from "@/lib/analytics";

/* The map is no longer the first thing anyone sees — Home is — and MapLibre
 * is most of the bundle (about 800kB of the 1.4MB it used to add to the
 * critical path). So it is its own chunk, fetched the first time the Stores
 * view is opened. React.lazy passes the ref straight through to MapView's
 * forwardRef, and every `mapRef.current` use below was already guarded,
 * because the map has always been allowed to be absent. */
const MapView = lazy(() => import("@/components/MapView"));

const CATEGORY_ICONS = {
  pet: PawPrint, kids: Baby, supplement: Pill, drug: Pill, device: Stethoscope,
  electrical: Zap, appliance: Plug, home: Armchair, sports: Bike,
  meat: Beef, seafood: Fish, dairy: Milk, produce: Carrot, grains: Wheat,
  snacks: Candy, beverage: CupSoda, pantry: Soup, food: UtensilsCrossed, product: Package,
};

/* Layout preferences persist per browser; storage may be unavailable. */
function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch (_) { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE REMEMBERED PLACE
 *
 * A return visit used to start from nothing: the same ZIP typed again, or the
 * same geolocation prompt answered again, before the app could say anything.
 * Home now answers straight away for a place it already knows, so the place
 * is kept — in this browser's localStorage and nowhere else, exactly the
 * fields a location already had in memory. It is never sent anywhere it was
 * not already going (the feeds' own query parameters; analytics gets only the
 * state, as before), and "Forget this location" in the location sheet clears
 * it.
 *
 * Read defensively: a hand-edited or half-written value must degrade to "no
 * location yet", never to a map centred on NaN.
 * ───────────────────────────────────────────────────────────────────────── */
const LOC_KEY = "rr-loc";

function loadSavedLoc() {
  const v = loadPref(LOC_KEY, null);
  if (!v || typeof v !== "object") return null;
  const lat = Number(v.lat);
  const lon = Number(v.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return cleanLoc(v, lat, lon);
}

function cleanLoc(v, lat, lon) {
  return {
    lat, lon,
    label: typeof v.label === "string" && v.label ? v.label.slice(0, 120) : "Saved location",
    place: typeof v.place === "string" && v.place ? v.place.slice(0, 80) : null,
    zip: typeof v.zip === "string" && /^\d{5}$/.test(v.zip) ? v.zip : null,
    state: typeof v.state === "string" ? v.state : null,
    stateAbbr: typeof v.stateAbbr === "string" && /^[A-Z]{2}$/.test(v.stateAbbr) ? v.stateAbbr : null,
  };
}

const locFields = (l) => ({
  lat: l.lat, lon: l.lon, label: l.label, place: l.place || null, zip: l.zip || null,
  state: l.state || null, stateAbbr: l.stateAbbr || null,
});

function saveLoc(l) {
  if (!l) {
    try { localStorage.removeItem(LOC_KEY); } catch (_) { /* private mode */ }
    return;
  }
  savePref(LOC_KEY, locFields(l));
}

/* Recent places: the last three set, newest first, never the current one.
 * Someone who checks for home (NY) and for a parent's house (IL) should not
 * have to retype either. Same storage, same rules, as the remembered place;
 * "Forget this location" clears these too. */
const RECENTS_KEY = "rr-recent-locs";
const RECENTS_MAX = 3;

function loadRecents() {
  const v = loadPref(RECENTS_KEY, []);
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const lat = Number(x && x.lat);
    const lon = Number(x && x.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const l = cleanLoc(x, lat, lon);
    return l.stateAbbr ? l : null;
  }).filter(Boolean).slice(0, RECENTS_MAX + 1);
}

function pushRecent(list, l) {
  if (!l || !l.stateAbbr) return list;
  const key = locLabel(l);
  const next = [locFields(l), ...list.filter((x) => locLabel(x) !== key)].slice(0, RECENTS_MAX + 1);
  savePref(RECENTS_KEY, next);
  return next;
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE GLOBAL SCOPE — "Near me · NY" or "All US"
 *
 * One switch in the header decides which recalls Home, the Recalls list and
 * the counts are about. Near me needs a state, so:
 *
 *   first visit, no location      → us
 *   a location set (or changed)   → near — they just told us they care
 *   "Forget this location"        → us
 *   otherwise                     → whatever the reader last chose
 *
 * Remembered in localStorage (`rr-scope`). A URL param wins on load —
 * `?scope=us` is a shareable "all US" link; `?scope=near` (or `local`) with no
 * location falls back to us and does not pop the picker at someone who only
 * followed a link. Changes are written back with replaceState: `scope=us`
 * added, or the param dropped for near, keeping `r` and `st`.
 * ───────────────────────────────────────────────────────────────────────── */
const SCOPE_KEY = "rr-scope";

function normalizeViewScope(v) {
  if (v === "us" || v === "all") return "us";
  if (v === "near" || v === "local") return "near";
  return null;
}

function readScopeParam() {
  try { return normalizeViewScope(new URLSearchParams(window.location.search).get("scope")); } catch (_) { return null; }
}
const SCOPE_PARAM = readScopeParam();

function initialViewScope(hasLoc) {
  if (!hasLoc) return "us";
  return SCOPE_PARAM || normalizeViewScope(loadPref(SCOPE_KEY, null)) || "near";
}

function writeScopeParam(scope) {
  try {
    const url = new URL(window.location.href);
    if (scope === "us") url.searchParams.set("scope", "us");
    else url.searchParams.delete("scope");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch (_) { /* sandboxed frame */ }
}

/* DialKit is an authoring tool: never in production; in dev, or on a preview
 * deploy opened with ?dialkit=1 (remembered for the tab). */
const DIALKIT_ASKED = (() => {
  try {
    if (new URLSearchParams(window.location.search).get("dialkit") === "1") sessionStorage.setItem("rr-dialkit", "1");
    return sessionStorage.getItem("rr-dialkit") === "1";
  } catch (_) { return false; }
})();
const DIALKIT_ON = import.meta.env.VITE_VERCEL_ENV !== "production" && (import.meta.env.DEV || DIALKIT_ASKED);

const fmtCount = (n) => {
  try { return new Intl.NumberFormat("en-US").format(n); } catch (_) { return String(n); }
};

/* A shared link lands as /?r=<id>&st=<ST> (api/share.js forwards /r/:id
 * here). `st` is the SENDER's state: it is what the link was about, so it is
 * the right state to answer in for someone the app knows nothing about yet —
 * and the wrong one for someone it does, whose own saved state wins. Read
 * once, at module load, because it describes how this page was opened and not
 * anything that changes while it is open. */
function readDeepLink() {
  try {
    const p = new URLSearchParams(window.location.search);
    const id = (p.get("r") || "").trim().slice(0, 80);
    return { recallId: id || null, st: cleanState(p.get("st")) };
  } catch (_) {
    return { recallId: null, st: null };
  }
}
const DEEP_LINK = readDeepLink();

/* "Since your last visit" needs the PREVIOUS visit, fixed for the whole of
 * this one. It is read once per tab (sessionStorage, so a reload does not
 * turn it into "since 4 seconds ago"), and the marker itself only moves when
 * the page is hidden or closed — see the visibility effect in App. Stamping it
 * on arrival instead would move it before the reader has seen anything, and a
 * visit that crashed on load would still count as caught up. */
const VISIT_BASELINE_KEY = "rr-visit-baseline";
function sessionVisitBaseline() {
  try {
    const s = sessionStorage.getItem(VISIT_BASELINE_KEY);
    if (s !== null) return s || null;
  } catch (_) { /* fall through */ }
  const prev = getLastVisit();
  try { sessionStorage.setItem(VISIT_BASELINE_KEY, prev || ""); } catch (_) { /* memory only */ }
  return prev;
}

const DEFAULT_SPLIT = 48; // % of the panel given to the stores list
const MIN_SPLIT = 18;
const MAX_SPLIT = 82;

/* The phone layout's own split: % of the body given to the map. It used to be
 * a hard-coded 42% with no way to change it, which is wrong in both
 * directions — reading the map you want it bigger, reading the list you want
 * it gone. */
const DEFAULT_MAP_PCT = 42;
const MIN_MAP_PCT = 20;
const MAX_MAP_PCT = 72;

/* The same trade on a wide screen, along the other axis: % of the window
 * given to the map. It was a fixed 26rem panel against however much was left,
 * which on a 1440 display meant 928px of basemap carrying five pins beside a
 * 416px column where all the reading happens. The phone could already drag
 * this boundary; the desktop could not. */
const DEFAULT_MAP_WIDTH = 58;
const MIN_MAP_WIDTH = 28;
const MAX_MAP_WIDTH = 78;

const RADII = [
  { value: 8047, label: "5" },
  { value: 16093, label: "10" },
  { value: 40234, label: "25" },
];

/* ─────────────────────────────────────────────────────────────────────────
 * SCOPE — how wide a net, in recalls
 *
 * This was three chips labelled Named / All stores / All recalls, and it had
 * two problems that fed each other.
 *
 * The first was the word. "Named" is the app's internal vocabulary: a notice
 * *names* a chain. Nobody arrives knowing that, and the chip did not say
 * named by whom, or of what.
 *
 * The second was arithmetic, and it is why the row read as confusing next to
 * the bottom bar. The three chips counted three different things — 8 stores,
 * 20 stores, 137 recalls — inside one segmented control, while the bottom
 * bar underneath counted "Near me 20" and "Recalls 137". Two rows of numbers,
 * different units, same digits, no stated subject. And two of the three chips
 * produced an identical recall list: "All stores" and "All recalls" differed
 * only in whether the store list was on screen, which is a layout question
 * wearing a filter's clothes.
 *
 * So the control was split along the seam it was actually hiding. What is
 * left is one question with two answers, both counted in recalls, under a
 * label that says so:
 *
 *   Recalls  [ At a store near you · 12 ]  [ All in CA · 137 ]
 *
 * Store-list visibility went where it belongs, to a collapse control on the
 * store list itself (wide screens; on a phone the bottom bar already is it).
 * ───────────────────────────────────────────────────────────────────────── */
const SCOPES = [
  { id: "named",
    label: "At a store near you",
    hint: "Only notices that name a chain with a storefront near you. The app's " +
          "most specific answer — and its smallest, because most notices name no " +
          "retailer at all." },
  { id: "area",
    label: "All in your area",
    hint: "Every active notice covering your area, named retailer or not. This is " +
          "what an independent grocer is exposed to, and it is the only honest " +
          "answer for one." },
];

/* A stored preference from the three-mode version, or a stale value from a
 * hand-edited localStorage, must not leave the app in a scope that no longer
 * exists — "recalls" and "stores" were both the wide net. */
function normalizeScope(v) {
  return v === "named" ? "named" : "area";
}

/* The phone's three layouts. The split is draggable between them; these are
 * the two ends it cannot be dragged to. */
const VIEWS = ["map", "split", "list"];

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "risk", label: "Highest risk first" },
];

function fmtDate(d) {
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* Recalls are regional far more often than they are national: a supplier
 * ships one lot to one of a chain's distribution centers, so the notice
 * covers the states that DC serves. Show that scope on every card. */
function regionLabel(r) {
  /* "Unstated" is its own answer and must never be flattened into
   * "Nationwide". The notice named a retailer and no geography; saying
   * nationwide would be inventing a claim the FDA did not make. Read through
   * coverageLine, so a national-index record (which carries `coverage`, not
   * `scope`) is described by the same rule as a live one. */
  return coverageLine(r, { max: 3 }).replace(/^Sent to /, "").replace(/^Distributed nationwide$/, "Nationwide")
    .replace(/^Where it was sold isn't stated$/, "Region not stated");
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/* A photo of the recalled product, where one can be had.
 *
 * CPSC publishes images; FDA and FSIS publish none at all. The gap closes
 * through the barcode: where a notice prints one, Open Food Facts can usually
 * turn it into a product shot. That lookup is a third-party request, so it
 * only happens for a card that has actually scrolled into view, once per
 * barcode per session, and it is silent when it fails — a missing photo is a
 * missing photo, never an error the reader has to deal with. */
function RecallImage({ recall }) {
  const [src, setSrc] = useState(recall.image || "");
  const ref = useRef(null);

  useEffect(() => {
    if (recall.image) return;
    const code = recallUpcs(recall)[0];
    const el = ref.current;
    if (!code || !el || typeof IntersectionObserver === "undefined") return;
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (done || !entries.some((e) => e.isIntersecting)) return;
      done = true;
      io.disconnect();
      lookupProduct(code).then((p) => p?.image && setSrc(p.image)).catch(() => {});
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [recall]);

  if (!src) return <span ref={ref} aria-hidden="true" className="size-0 shrink-0" />;
  return (
    <img ref={ref} src={src} alt="" loading="lazy" referrerPolicy="no-referrer"
         className="size-14 shrink-0 rounded-lg border border-line bg-panel object-cover"
         onError={(e) => { e.currentTarget.style.display = "none"; }} />
  );
}

/* What each feed is the only source for. When one is down, this is what is
 * actually missing from the list — which is the sentence the app owed the
 * reader and never said. An amber dot in the footer is not a disclosure. */
const SOURCE_COVERS = {
  "USDA FSIS": "meat, poultry and egg recalls",
  CPSC: "consumer product recalls — toys, furniture, appliances, electronics",
  "FDA Food": "food and supplement recalls",
  "FDA Drug": "drug recalls",
  "FDA Device": "medical device recalls",
};

function coverageFor(name) {
  const key = Object.keys(SOURCE_COVERS).find((k) => name.startsWith(k));
  const covers = key ? SOURCE_COVERS[key] : "Some recalls";
  return covers[0].toUpperCase() + covers.slice(1);
}

/* The feed names carry their own parenthetical — "USDA FSIS (meat, poultry,
 * egg)" — which is exactly the phrase the sentence after it is about to use.
 * Say it once. */
function shortSourceName(name) {
  return String(name).replace(/\s*\([^)]*\)\s*$/, "");
}

/* A source that is *down*, said in the list it is missing from.
 *
 * "USDA data still never shows" was true and the app was close to silent
 * about it: one amber dot in a desktop footer, one line inside About, and
 * nothing at all in the list where the gap actually lives. A missing agency is
 * not a status indicator, it is a hole in the answer, and it belongs in the
 * answer.
 *
 * A source serving a saved copy is the opposite case and does not belong
 * here. Its recalls are in the list; what changed is their provenance, and
 * the note explaining it is written for whoever runs this app rather than
 * whoever is standing in a shop — "Live fetch failed (HTTP 403 from
 * www.fsis.usda.gov) and no cache was warm" asks a reader to care about a
 * WAF, an ingest tier and a cold cache to learn something that does not
 * change what they should do next. It reads as breakage while describing a
 * fallback working exactly as designed. That belongs in About, next to the
 * per-source counts and the feed check, and About already renders every
 * `note` in full — so this is one place to read it, not none. */
function SourceNotice({ sources }) {
  const down = sources.filter((s) => !s.ok);
  /* Served from a saved copy *and* it matched nothing. Either half alone is
   * unremarkable — a copy that still found recalls is provenance and lives
   * in About; a live feed that found none is a real, trustworthy zero. It is
   * the pair that misleads, because the section renders identically to "no
   * recalls near you" while the actual claim is only "none in the copy we
   * had". That is the same mistake the scanner refuses to make about an
   * unmatched barcode, and it was worth catching here too: production once
   * shipped a snapshot holding a single New England notice, which every
   * other state scoped away to a silent nought.
   *
   * Only zero is caught. A copy thin enough to return two recalls where the
   * live feed would return thirty is equally wrong and cannot be told apart
   * from inside the app — the count it should have had is exactly what is
   * unavailable. Zero is the case that is both detectable and dangerous. */
  const quiet = sources.filter((s) => s.ok && s.note && !s.count);
  if (!down.length && !quiet.length) return null;
  return (
    <div id="source-notice" role="status"
         className="mb-2 flex flex-col gap-1.5 rounded-xl border border-amber/40 bg-amber-soft px-3 py-2.5">
      {down.map((s) => (
        <p key={s.name} className="flex items-start gap-2 text-[12px] leading-relaxed">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span>
            <span className="font-semibold text-paper">{shortSourceName(s.name)} is unavailable right now.</span>{" "}
            {coverageFor(s.name)} are missing from this list — an empty list is not the same as no
            recalls. <span className="text-subtle">({s.error || "no response"})</span>
          </span>
        </p>
      ))}
      {quiet.map((s) => (
        <p key={s.name} className="flex items-start gap-2 text-[12px] leading-relaxed">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span>
            <span className="font-semibold text-paper">
              {shortSourceName(s.name)} matched nothing near you, from a saved copy.
            </span>{" "}
            {coverageFor(s.name)} were checked against a stored copy rather than the live feed. Nothing
            here means none were found — not that there are none.
          </span>
        </p>
      ))}
    </div>
  );
}

/* The severity badge, which explains itself.
 *
 * "Class I" is the loudest thing on a recall card and the only word on it
 * that is not English — it is an FDA term of art shaped exactly like an
 * ordinal, so read cold it suggests "the first one", or worse, "the mildest".
 * It means the opposite: a reasonable probability of serious harm or death.
 * A reader who guesses wrong here guesses wrong about the only thing on the
 * card that decides what they do next.
 *
 * So the term is a disclosure, not a label. Hover explains it on a mouse; tap
 * explains it on a phone; the dotted underline and the ⓘ say so before either
 * happens. Where an agency assigns no class at all — CPSC never does — it says
 * that, rather than inventing "Medium risk" the way this badge used to. */
function SeverityBadge({ recall }) {
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

/* "Closed" is jargon in the same way "Class I" is: it sounds like "resolved,
 * nothing to do here", and the thing it actually means is "stop reading the
 * recall, start checking your freezer". So it gets the same disclosure
 * treatment rather than a bare chip, and a muted variant — a closed notice is
 * a fact about the paperwork, not a hazard level. */
function ClosedBadge() {
  return (
    <InfoTip
      title="Closed — USDA is no longer tracking this recall"
      body={
        "A notice closes once the recalling firm has finished recovering or disposing of the " +
        "product it could reach. It does not mean the product is safe, and it does not mean " +
        "every package came back — recalled food can sit in a freezer for months after the " +
        "notice closes. If you have it, it is still the recalled product."
      }
      label="Closed: what this means"
      variant="badge"
      triggerClassName="text-fog"
      side="bottom"
    >
      <Badge variant="scope">Closed</Badge>
    </InfoTip>
  );
}

function Bar({ w }) {
  return <div className="shimmer h-3 rounded-full" style={{ width: w }} />;
}

function RecallSkeleton({ delay = 0 }) {
  return (
    <li className="fade-item elev-1 rounded-xl border border-line bg-panel-2 p-3.5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex gap-1.5">
        <div className="shimmer h-4 w-16 rounded-md" />
        <div className="shimmer h-4 w-12 rounded-md" />
      </div>
      <div className="mt-3 flex flex-col gap-2"><Bar w="72%" /><Bar w="45%" /></div>
    </li>
  );
}

function StoreSkeleton({ delay = 0 }) {
  return (
    <li className="fade-item elev-1 rounded-xl border border-line bg-panel-2 p-3" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2"><Bar w="55%" /></div>
      <div className="mt-2 flex gap-1.5"><div className="shimmer h-4 w-20 rounded-md" /></div>
    </li>
  );
}

/* One line of the scan overlay's checklist. The two lookups run in sequence —
 * stores can't be searched until the recalls name the chains to search for —
 * so showing them as steps is the honest picture of what the app is doing. */
function ScanStep({ state, label, detail }) {
  return (
    <li className="flex items-center gap-2 text-[12px]">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {state === "done" ? <Check className="size-3.5 text-mint" strokeWidth={3} />
          : state === "busy" ? <Loader2 className="size-3.5 animate-spin text-mint" />
            : <span className="size-1.5 rounded-full bg-line-strong" />}
      </span>
      <span className={state === "waiting" ? "text-subtle" : "font-semibold text-paper"}>{label}</span>
      <span className="tnum ml-auto text-[11px] text-fog">{detail}</span>
    </li>
  );
}

function EmptyState({ icon: Icon, title, children, compact, action }) {
  return (
    <div className={"fade-item flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line bg-panel-2/40 px-5 text-center " + (compact ? "py-6" : "py-9")}>
      <span className="flex size-9 items-center justify-center rounded-full border border-mint-line bg-mint-soft">
        <Icon className="size-4 text-mint" />
      </span>
      <p className="mt-0.5 text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-fog">{children}</p>
      {action}
    </div>
  );
}

/** Section header shared by both panels: label, live count, optional trailing
 *  controls. On a phone the label and count are dropped — the tab directly
 *  above already says "Stores 10", and repeating it costs a row of a list
 *  that has about four to give.
 *
 *  It used to carry a `note` slot as well, which the store list used for a
 *  "8 named" tally. That tally was the fourth place the same 8 appeared —
 *  after the headline, the scope chip and the map pins — so the slot went with
 *  it. */
/* The label and count are already desktop-only, so on a phone this band is
 * whatever its children are. With the radius moved onto the map there is
 * nothing left for it to hold there, and an empty 40px band above a short
 * list is exactly the stacked-chrome problem this pass is undoing — hence
 * `max-lg:hidden` from the caller. The count it used to carry is on the tab
 * bar ("Near me 4"), which is where a phone reads it anyway. */
function PanelHeader({ label, countId, count, className = "", children }) {
  return (
    <div className={"flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel px-4 py-2 " + className}>
      <span className="flex items-center gap-2 max-lg:hidden">
        <span className="microlabel">{label}</span>
        <span id={countId} className="tnum text-xs font-semibold text-mint">{count}</span>
      </span>
      {/* Only when there is something to hold. The store header's controls
          moved onto the map, so this would otherwise be an empty flex box
          holding a `ml-auto` against nothing. */}
      {children && <div className="flex items-center gap-1.5 max-lg:mr-auto lg:ml-auto">{children}</div>}
    </div>
  );
}

/* Two ways a recall can matter at a store, and they are not the same claim:
 *   named — the notice names this chain, so its warehouses got the lot;
 *   area  — the notice covers your state but names no retailer, so it could
 *           be on any shelf here, this one included.
 * Independents only ever have the second kind.
 *
 * `except` drops one facet from the test. That is what lets a filter chip say
 * what turning it on would actually leave you with, counted against every
 * other filter that is already on — the selected store included. Counting
 * against the raw feed instead produced chips like "Undeclared allergen · 1"
 * that landed on an empty list, because the one allergen notice was not one
 * of the two that named the store you had picked. */
function passesFilters(r, f, except) {
  if (except !== "source" && f.hidden.has(r.source)) return false;
  if (except !== "high" && f.highOnly && r.severity !== "high") return false;
  if (except !== "cat" && f.cats && !f.cats.has(categoryFor(r).key)) return false;
  if (except !== "why" && f.whys && !f.whys.has(reasonFor(r).key)) return false;
  if (except !== "chainScope" && f.chainScope &&
      !(r.retailerIds || []).some((id) => f.chainScope.has(id))) return false;
  if (!f.q) return true;
  return [r.product, r.firm, r.reason, r.distribution, r.source].join(" ").toLowerCase().includes(f.q);
}

/* ─────────────────────────────────────────────────────────────────────────
 * DRAGGABLE DIVIDER
 *
 * One implementation, used twice: between the two lists inside the desktop
 * panel, and between the map and the panel on a phone — the second of which
 * did not exist, so the phone map was pinned at 42% of the viewport whether
 * you were reading the map or the list under it.
 *
 * It is a real separator, not a decoration: the pointer is captured so a drag
 * that wanders off the 8px handle keeps tracking, arrow keys nudge it for
 * anyone not using a pointer, and Home (or a double-tap) puts it back.
 * `touch-action: none` on the handle — see .split-handle in index.css — is
 * what stops a phone from scrolling the page instead of dragging.
 * ───────────────────────────────────────────────────────────────────────── */
function useSplitDrag({ boxRef, axis, value, setValue, storageKey, min, max, reset }) {
  const dragging = useRef(false);
  const [live, setLive] = useState(false);
  // The committed value, tracked outside React so pointerup persists what the
  // last pointermove actually applied rather than whatever the closure saw.
  const latest = useRef(value);
  if (!dragging.current) latest.current = value;

  const apply = useCallback((pct) => {
    const v = Math.min(max, Math.max(min, pct));
    latest.current = v;
    setValue(v);
    return v;
  }, [min, max, setValue]);

  const end = useCallback((e) => {
    if (!dragging.current) return;
    dragging.current = false;
    setLive(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    savePref(storageKey, latest.current);
  }, [storageKey]);

  return {
    "data-dragging": live ? "true" : undefined,
    onPointerDown(e) {
      dragging.current = true;
      setLive(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    onPointerMove(e) {
      if (!dragging.current || !boxRef.current) return;
      const r = boxRef.current.getBoundingClientRect();
      apply(axis === "x" ? ((e.clientX - r.left) / r.width) * 100
                         : ((e.clientY - r.top) / r.height) * 100);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onDoubleClick() { savePref(storageKey, apply(reset)); },
    onKeyDown(e) {
      const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (e.key !== back && e.key !== fwd && e.key !== "Home") return;
      e.preventDefault();
      savePref(storageKey, e.key === "Home" ? apply(reset) : apply(latest.current + (e.key === fwd ? 4 : -4)));
    },
  };
}

/** Top chains named in the given recalls, newest recall first.
 *  Capped at 24: the store service does one Mapbox lookup per chain. */
function chainsFor(recalls) {
  const byChain = new Map();
  for (const r of recalls) {
    for (const id of r.retailerIds || []) {
      if (!byChain.has(id)) byChain.set(id, []);
      byChain.get(id).push(r);
    }
  }
  const chains = [...byChain.entries()]
    .map(([id, rs]) => ({
      chain: byId(id),
      newest: Math.max(...rs.map((r) => (r.date ? r.date.getTime() : 0))),
    }))
    .filter((x) => x.chain)
    .sort((a, b) => b.newest - a.newest)
    .slice(0, 24)
    .map((x) => x.chain);
  return { chains, byChain };
}

/* Which chains to actually search for near the user. Recall-named chains come
 * first so they always make the cut, then the standing grocery set fills the
 * rest — otherwise a notice that says only "Nationwide" leaves the map empty. */
function chainsToSearch(recalls) {
  const { chains: named } = chainsFor(recalls);
  const out = [...named];
  const have = new Set(out.map((c) => c.id));
  for (const c of DEFAULT_NEARBY_CHAINS) {
    if (out.length >= 24) break;
    if (!have.has(c.id)) { out.push(c); have.add(c.id); }
  }
  return out;
}

export default function App() {
  const [loc, setLoc] = useState(null);
  /* The location picker (LocationButton → LocationPicker) is the only place a
   * location is set. `pickerReason` is the subtitle that says why it was
   * asked for ("to find stores near you"). */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerReason, setPickerReason] = useState(null);
  const [recents, setRecents] = useState(loadRecents);
  /* Near me · ST | All US. See THE GLOBAL SCOPE above. Named `viewScope`
   * because `scope` below is the panel's store scope (named | area). */
  const [viewScope, setViewScope] = useState(() => initialViewScope(Boolean(loadSavedLoc())));
  /* The All US list, fetched the first time it is needed and kept. */
  const [national, setNational] = useState({ status: "idle", recalls: [], sources: [] });
  /* Polite announcements: a new place, a new scope. */
  const [liveMsg, setLiveMsg] = useState("");
  const [radius, setRadius] = useState(16093);
  /* How many storefronts to keep. See STORE_CAPS in lib/stores.js: some cap
   * has to exist, and a fixed one silently disabled the radius control in
   * dense neighbourhoods. Remembered, because it is a preference about how
   * much list you want to read rather than a per-search decision. */
  const [storesTrimmed, setStoresTrimmed] = useState(0);
  const [storeCap, setStoreCap] = useState(() => loadPref("rr-store-cap", DEFAULT_STORE_CAP));
  useEffect(() => { savePref("rr-store-cap", storeCap); }, [storeCap]);

  const [recalls, setRecalls] = useState([]);
  const [sources, setSources] = useState([]);
  const [productsBusy, setProductsBusy] = useState(false);

  const [stores, setStores] = useState([]);
  const [storesStatus, setStoresStatus] = useState(null);
  const [activeStore, setActiveStore] = useState(-1); // drives map focus AND product filtering
  const [scope, setScope] = useState(() => normalizeScope(loadPref("rr-mode", "area")));
  /* Wide screens: each list is shown or hidden on its own.
   *
   * There used to be one "Hide Lists" button that took both, plus a separate
   * fold for the store list — two controls with overlapping jobs and no way
   * to express the case people actually want, which is "I am reading recalls
   * and do not care which shop they are in". Two switches say all four
   * states, and hiding both is what the old single button did. */
  const [storesShown, setStoresShown] = useState(() => loadPref("rr-show-stores", true));
  const [recallsShown, setRecallsShown] = useState(() => loadPref("rr-show-recalls", true));
  const [view, setView] = useState("split"); // phone only: map | split | list
  /* Where the reader is: home | near | recalls.
   *
   * Home is the landing now — search, then the digest — because the question
   * people most often arrive with is "is the thing I heard about mine?", and
   * that needs neither a map nor a location. The map with its store list
   * ("near", the old landing) and the full area list ("recalls") are still
   * here, one tap away, for the reader who wants to go through everything.
   * On a phone these are the bottom bar's destinations. On a wide screen
   * "near" and "recalls" are one view, the side-by-side map and panel, and
   * Home is a centred column. */
  const [tab, setTab] = useState("home");
  /* The map and the store lookup cost a MapLibre chunk and a Mapbox request
   * per chain, and Home needs neither. So nothing store-shaped happens until
   * the first time the Stores or Recalls view is opened; after that it stays
   * mounted, so going Home and back keeps the selection, the scroll and the
   * camera. */
  const [storesWanted, setStoresWanted] = useState(false);
  useEffect(() => { if (tab !== "home") setStoresWanted(true); }, [tab]);
  /* The national index (public/feeds/index.json). RecallSearch loads it for
   * itself; this is the same memoized promise, held here for the digest.
   * Started after first paint, never awaited by it. */
  const [index, setIndex] = useState(null);
  /* A recall opened from the digest (its headline, a follow match, a story),
   * answered in a sheet over wherever the reader is. */
  const [sheetRecall, setSheetRecall] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [push, setPush] = useState({ state: "unknown", busy: false, msg: null, dropped: [] });
  const [lastVisit] = useState(sessionVisitBaseline);
  /* Offered where it can work, or where one step would make it work (an
   * iPhone in a Safari tab: add to Home Screen first). Nowhere else — a
   * button that can only ever answer "not supported" is not an offer. */
  const [pushOffered, setPushOffered] = useState(() => pushSupported() || needsInstallForPush());
  /* …and only where this deployment can send them. Without VAPID keys the
   * server says { enabled: false }, and an offer that ends in "not switched
   * on for this site" is the same non-offer from the other side. */
  useEffect(() => {
    if (!pushOffered) return undefined;
    let alive = true;
    pushAvailable().then((v) => { if (alive && !(v && v.enabled)) setPushOffered(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [moreOpen, setMoreOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  /* "184 high-risk" was a statistic sitting where a control could be: it told
   * you the number and then left you to go and find Class I inside the filter
   * sheet. Same pixels, now the thing itself. */
  const [highOnly, setHighOnly] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [sideBySide, setSideBySide] = useState(() => loadPref("rr-side-by-side", false));
  const [splitPct, setSplitPct] = useState(() => loadPref("rr-split", DEFAULT_SPLIT));
  const [mapPct, setMapPct] = useState(() => loadPref("rr-map-pct", DEFAULT_MAP_PCT));
  const [mapWidthPct, setMapWidthPct] = useState(() => loadPref("rr-map-width", DEFAULT_MAP_WIDTH));
  const [storesNoteHidden, setStoresNoteHidden] = useState(() => {
    try { return sessionStorage.getItem("rr-stores-note") === "1"; } catch (_) { return false; }
  });
  const [isWide, setIsWide] = useState(false); // lg+ : two lists at once, no bottom nav

  const [filterText, setFilterText] = useState("");
  const [categoryKeys, setCategoryKeys] = useState([]); // empty = every type
  const [reasonKeys, setReasonKeys] = useState([]);     // empty = every reason
  const [sortBy, setSortBy] = useState("newest"); // newest | risk
  const [storeScope, setStoreScope] = useState("named"); // named | area
  const [diag, setDiag] = useState(null);
  /* Sources switched OFF in Filters. Stored as the hidden set, not the shown
   * one, so a list that arrives later (the national one, a late USDA) is
   * visible by default instead of filtered out until someone opts it in. */
  const [hiddenSources, setHiddenSources] = useState(new Set());
  const [limit, setLimit] = useState(25);

  // Live-tunable motion (DialKit panel in dev; shipped defaults in production).
  const { theme, setTheme, resolved: resolvedTheme, cycle: cycleTheme } = useTheme();
  const motionStyle = useMotionTuning();
  const stagger = cardStagger(motionStyle);
  /* About is the app's longest read and it used to vanish mid-sentence — an
   * entrance animation with no exit. Same presence machinery as the sheets. */
  const { mounted: aboutMounted, shown: aboutShown } = useSheetPresence(aboutOpen);

  const mapRef = useRef(null);
  const storeItemRefs = useRef([]);
  const splitRef = useRef(null);
  const mainRef = useRef(null);
  const productsScrollRef = useRef(null);

  const { byChain } = useMemo(() => chainsFor(recalls), [recalls]);

  /* The chains the store lookup should search for, plus a stable key for them.
   * Recalls land in two waves — the API payload, then USDA fetched directly by
   * the browser — so this set can grow after the first scan. */
  const searchChains = useMemo(() => chainsToSearch(recalls), [recalls]);
  const chainKey = useMemo(() => searchChains.map((c) => c.id).sort().join(","), [searchChains]);
  const searchChainsRef = useRef(searchChains);
  searchChainsRef.current = searchChains;
  /* Read through a ref for the same reason the chain list is: loadStores is
   * a stable callback with no dependencies, and giving it one would rebuild
   * the effect that owns store loading. */
  const capRef = useRef(storeCap);
  capRef.current = storeCap;

  /* Last request wins. A lookup still in flight for the old radius must never
   * overwrite the one the user is actually waiting on. */
  const storeRunRef = useRef(0);

  const loadStores = useCallback(async (locArg, radiusArg, { quiet = false } = {}) => {
    const run = ++storeRunRef.current;
    const stale = () => run !== storeRunRef.current;
    if (!quiet) {
      setActiveStore(-1);
      setStores([]);
      setStoresStatus({ msg: "Finding grocery stores near you — chains and independents…", busy: true });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const found = await findStores(searchChainsRef.current, locArg, radiusArg,
                                      undefined, capRef.current);
        if (stale()) return;
        setStores(found);
        track("stores_loaded", {
          count: found.length,
          radius_mi: miles(radiusArg),
          attempt: attempt + 1,
          chains_searched: searchChainsRef.current.length,
        });
        /* A truncated list that does not say so reads as the whole answer.
           Same rule the scanner follows about an unmatched barcode: the
           number you did not see is the one that matters. */
        setStoresTrimmed(found.inRangeTotal > found.length ? found.inRangeTotal : 0);
        setStoresStatus(found.length ? null : {
          empty: true,
          title: "Nothing in range",
          msg: "No stores found within this radius — try a wider one.",
        });
        return;
      } catch (err) {
        if (stale()) return;
        if (attempt === 0) {
          setStoresStatus({ msg: "First attempt failed — retrying…", busy: true });
          await new Promise((r) => setTimeout(r, 3000));
          if (stale()) return;
          continue;
        }
        setStores([]);
        track("stores_failed", {
          radius_mi: miles(radiusArg),
          error: String(err.message || "failed").slice(0, 120),
        });
        setStoresStatus({
          msg: `Store lookup failed (${err.message}). The recall list is unaffected.`,
          error: true,
          retry: () => loadStores(locArg, radiusArg),
        });
      }
    }
  }, []);

  /* A place changed while its list was still loading (a recent picked, then
   * another, in two taps) must not have the first answer land on the second
   * place. Each load takes a ticket; only the newest may write. */
  const recallsRunRef = useRef(0);
  const loadRecalls = useCallback(async (locArg) => {
    const run = ++recallsRunRef.current;
    const current = () => run === recallsRunRef.current;
    setProductsBusy(true);
    setRecalls([]);
    setSources([]);
    setLimit(25);
    try {
      /* The normalizers keep notices naming only other states ('elsewhere')
       * so a verdict can say "not reported in your state". This list is the
       * area list, so it filters through the one area rule. fetchAll already
       * applies it on every path; this is the guard at the point of use. */
      const { recalls: all, sources: srcs } = await fetchAll(locArg);
      if (!current()) return;
      const fetched = all.filter((r) => isInArea(r, locArg));
      setRecalls(fetched);
      setSources(srcs);

      track("recalls_loaded", {
        count: fetched.length,
        state: locArg.stateAbbr || null,
        sources_ok: srcs.filter((x) => x.ok).length,
        sources_failed: srcs.filter((x) => !x.ok).length,
      });
      /* One event per failed feed, not a list on the load event — a feed
       * going dark is the thing worth alerting on, and it needs its own
       * breakdown by name. See the four-tier fallback in the README. */
      for (const x of srcs) {
        if (!x.ok) track("source_failed", { source: x.name, error: String(x.error || "failed").slice(0, 120) });
      }

      /* USDA blocks our server but usually not the browser, so retry it here and
       * fold the result in when it lands. Deliberately not awaited: the stores
       * lookup is the slow part of the page and must not wait on a source that
       * may well be blocked here too. */
      // Deliberately not awaited: the store lookup is the slow part of this
      // page and must not wait on sources that may be unreachable from here
      // too. Whatever comes back is folded in and re-sorted.
      recoverBlockedSources(locArg, srcs).then((late) => {
        if (!late || !current()) return;
        // Whether the browser can reach what the server could not is the
        // whole premise of the fallback; without this it is unmeasurable.
        track("sources_recovered", { count: late.recalls.length });
        setRecalls((prev) => sortRecalls([...prev, ...late.recalls.filter((r) => isInArea(r, locArg))]));
        setSources(late.sources);
      });
    } finally {
      if (current()) setProductsBusy(false);
    }
  }, []);

  /* Store loading has exactly one trigger: this effect. The first load, a new
   * location and a radius change all take the same path — previously the first
   * load was an imperative tail-call inside the recall fetch and the radius
   * buttons were their own call, which is why nudging the radius could make
   * stores appear that had never loaded on their own. */
  const lastScanRef = useRef("");
  useEffect(() => {
    if (!loc || productsBusy || !storesWanted) return;
    const place = `${loc.lat},${loc.lon}|${radius}|${storeCap}`;
    const key = `${place}|${chainKey}`;
    if (key === lastScanRef.current) return;
    // Only the chain list changed (USDA landed late): refresh in place instead
    // of dropping the user's selection and replaying the whole scan overlay.
    const quiet = lastScanRef.current.startsWith(`${place}|`);
    lastScanRef.current = key;
    loadStores(loc, radius, { quiet });
  }, [loc, radius, storeCap, chainKey, productsBusy, storesWanted, loadStores]);

  /* ── scope ──
   * One setter for every way the scope changes, so persistence, the URL, the
   * analytics super property and the spoken announcement can never drift. */
  const viewScopeRef = useRef(viewScope);
  viewScopeRef.current = viewScope;
  const applyScope = useCallback((next, via, placeName) => {
    const from = viewScopeRef.current;
    if (next === from) return;
    setViewScope(next);
    // A national list that failed earlier gets another try on the way back.
    if (next === "us") setNational((n) => (n.status === "failed" ? { ...n, status: "idle" } : n));
    savePref(SCOPE_KEY, next);
    writeScopeParam(next);
    registerSuper({ scope: next });
    track("scope_changed", { from, to: next, scope: next, via });
    setLimit(25);
    setLiveMsg(next === "us" ? "Showing all US recalls" : `Showing recalls for ${placeName || "your state"}`);
  }, []);

  // On load: the scope is a super property from the first event on, and a
  // `?scope=` that could not be honoured (near, no place) is corrected.
  useEffect(() => {
    registerSuper({ scope: viewScope });
    if (SCOPE_PARAM && SCOPE_PARAM !== viewScope) writeScopeParam(viewScope);
    if (SCOPE_PARAM) track("scope_changed", { from: null, to: viewScope, scope: viewScope, via: "url" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* `method` is carried only so the funnel can separate "tapped locate"
   * from "typed a ZIP" — the coordinates, the ZIP and the resolved label stay
   * in the browser either way. A place set by the reader (anything but the
   * silent restore) switches to Near me: they just told us they care about
   * it. Not awaited by the picker: it closes once the place has resolved, and
   * the list loads under the header's progress bar. */
  const setLocation = useCallback(async (newLoc, method = "unknown") => {
    setLoc(newLoc);
    saveLoc(newLoc);
    track("location_set", {
      method,
      state: newLoc.stateAbbr || null,
      state_resolved: Boolean(newLoc.state || newLoc.stateAbbr),
    });
    if (method !== "saved") {
      setRecents((prev) => pushRecent(prev, newLoc));
      applyScope("near", "location_set", newLoc.state || newLoc.stateAbbr);
      setLiveMsg(`Location set to ${locLabel(newLoc)}. Showing Near me · ${newLoc.stateAbbr}.`);
    }
    await loadRecalls(newLoc);
  }, [loadRecalls, applyScope]);

  const [locating, setLocating] = useState(false);

  /* The picker's three ways in. Each resolves only once a place WITH a state
   * is in hand (every answer here is per state), and rejects with a coded
   * error the picker shows under its field. Analytics gets the code, never
   * the text or the ZIP. */
  const locateText = useCallback(async (text) => {
    const method = /^\s*\d/.test(String(text || "")) ? "zip" : "address";
    setLocating(true);
    try {
      const resolved = await geocodeInput(text);
      setLocation(resolved, resolved.method || method);
      setPickerOpen(false);
    } catch (err) {
      track("location_failed", { method, reason: err.code || "network" });
      throw err;
    } finally {
      setLocating(false);
    }
  }, [setLocation]);

  const locateDevice = useCallback(async () => {
    setLocating(true);
    try {
      const pos = await browserPosition();
      let resolved;
      try {
        resolved = await reverseGeocode(pos.lat, pos.lon);
      } catch (_) {
        throw geoError("network");
      }
      if (!resolved.stateAbbr) throw geoError("no_state");
      setLocation(resolved, "geo");
      setPickerOpen(false);
    } catch (err) {
      track("location_failed", { method: "geo", reason: err.code || "network" });
      throw err;
    } finally {
      setLocating(false);
    }
  }, [setLocation]);

  const pickRecent = useCallback(async (r) => {
    setLocation(r, "recent");
    setPickerOpen(false);
  }, [setLocation]);

  /* A remembered place is set exactly as a new one is — same fetch, same
   * event — so a return visit is the first visit minus the typing. Once, on
   * mount; StrictMode's second run finds the ref already set. */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = loadSavedLoc();
    if (saved) setLocation(saved, "saved");
  }, [setLocation]);

  const forgetLocation = useCallback(() => {
    saveLoc(null);
    setLoc(null);
    recallsRunRef.current += 1; // a list still loading for the old place must not land
    setProductsBusy(false);
    setRecalls([]);
    setSources([]);
    setStores([]);
    setStoresStatus(null);
    setActiveStore(-1);
    setRecents([]);
    try { localStorage.removeItem(RECENTS_KEY); } catch (_) { /* private mode */ }
    lastScanRef.current = "";
    storeRunRef.current += 1; // a lookup still in flight must not land afterwards
    track("location_forgotten");
    applyScope("us", "forget");
    setPickerOpen(false);
  }, [applyScope]);

  /* Every "set a location" in the app lands here, with why it was asked. */
  const openLocationPicker = useCallback((reason = null, via = "header") => {
    setSheetRecall(null);
    setPickerReason(reason);
    setPickerOpen(true);
    track("location_picker_opened", { via, has_location: Boolean(loc) });
  }, [loc]);

  /* The header switch. "Near me" without a place asks for one instead of
   * switching; setLocation switches once it is set, and closing the picker
   * without one leaves the reader in All US. */
  const changeScope = useCallback((next, via = "header") => {
    if (next === "near" && !loc) {
      openLocationPicker("to show recalls for your state", "scope_switch");
      return;
    }
    applyScope(next, via, loc && loc.state);
  }, [loc, applyScope, openLocationPicker]);

  /* The state every verdict is answered in. The reader's own place when the
   * app has one with a state; otherwise the state a shared link was sent from
   * (?st=), so "Not reported in California" still means something to someone
   * who opened a friend's link before telling the app anything. */
  const verdictLoc = useMemo(() => {
    if (loc && (loc.stateAbbr || loc.state)) return loc;
    if (DEEP_LINK.st) return { state: ABBR_TO_NAME[DEEP_LINK.st] || null, stateAbbr: DEEP_LINK.st };
    return loc;
  }, [loc]);
  const verdictState = verdictLoc && verdictLoc.stateAbbr ? verdictLoc.stateAbbr : null;

  // ── the national index, after first paint ─────────────────────────────
  useEffect(() => {
    let alive = true;
    loadIndex().then((ix) => { if (alive) setIndex(ix); }).catch(() => { /* RecallSearch shows the retry */ });
    return () => { alive = false; };
  }, []);

  /* A shared link's verdict counts as viewed once the record is known —
   * RecallSearch opens it itself, without a click to hang the event on. */
  const deepTrackedRef = useRef(false);
  useEffect(() => {
    if (!index || !DEEP_LINK.recallId || deepTrackedRef.current) return;
    deepTrackedRef.current = true;
    const r = (index.recalls || []).find((x) => x.id === DEEP_LINK.recallId);
    track("verdict_viewed", {
      verdict: r ? verdictFor(r, verdictLoc).verdict : "not_found",
      source: r ? r.source : null,
      via: "share_link",
      state: verdictState,
    });
  }, [index, verdictLoc, verdictState]);

  // ── analytics hooks for the Home components ───────────────────────────
  const onVerdictOpened = useCallback((r, via = "search") => {
    track("verdict_viewed", {
      verdict: verdictFor(r, verdictLoc).verdict,
      source: r.source || null,
      via,
      state: verdictState,
      scope: viewScope,
    });
  }, [verdictLoc, verdictState, viewScope]);

  const onSearchSettled = useCallback(({ query: q, results, live }) => {
    track("search_submitted", {
      query: searchQueryProp(q),
      query_length: q.length,
      results,
      fda_live: live,
      has_location: Boolean(verdictState),
      scope: viewScope,
    });
  }, [verdictState, viewScope]);

  const openRecallSheet = useCallback((r) => {
    if (!r) return;
    /* One recall, one answer. normalizeFsis and the index now share one
     * rule for when USDA's "not active" flag means ended (fsisStatus and
     * FSIS_TRUST_CLOSED_DAYS in lib/sources.js), so the two should agree; the
     * index's status still wins here as a guard against a live record cached
     * before that rule, which called a days-old notice "ended". Everything
     * else — lot codes, photo — stays the live record's, which has more of
     * it. `active` (USDA's raw flag, for the Closed chip) is left alone. */
    const ix = index && Array.isArray(index.recalls) ? index.recalls.find((x) => x.id === r.id) : null;
    const rec = ix ? { ...r, status: ix.status, endDate: ix.endDate } : r;
    setSheetRecall(rec);
    onVerdictOpened(rec, "digest");
  }, [onVerdictOpened, index]);

  /* ── the All US list ──
   * Fetched lazily, the first time the reader is in All US, and kept for the
   * session: it is one CDN-cached URL for everybody, but it is also the
   * biggest payload the app asks for. Until it lands (or if it fails) the
   * surfaces read the national index instead and say so. */
  useEffect(() => {
    if (viewScope !== "us" || national.status !== "idle") return;
    setNational((n) => ({ ...n, status: "loading" }));
    fetchNational().then((got) => {
      if (!got) {
        setNational({ status: "failed", recalls: [], sources: [] });
        track("recalls_failed", { scope: "us" });
        return;
      }
      setNational({ status: "done", recalls: got.recalls, sources: got.sources });
      track("recalls_loaded", {
        count: got.recalls.length,
        scope: "us",
        sources_ok: got.sources.filter((x) => x.ok).length,
        sources_failed: got.sources.filter((x) => !x.ok).length,
      });
    });
  }, [viewScope, national.status]);

  const goStores = useCallback(() => {
    setTab("near");
    setStoresShown((prev) => { if (!prev) savePref("rr-show-stores", true); return true; });
    if (view === "list") setView("split");
  }, [view]);
  const goRecalls = useCallback(() => {
    setTab("recalls");
    setRecallsShown((prev) => { if (!prev) savePref("rr-show-recalls", true); return true; });
    if (view === "map") setView("split");
  }, [view]);

  /* ── since your last visit ──
   * The marker moves when the page is put away, not when it arrives: the
   * baseline for this visit was read once (sessionVisitBaseline) and the
   * digest counts from it; hiding or closing the tab is what says "seen".
   * `visibilitychange` is the one that fires reliably on a phone, where tabs
   * are discarded rather than closed; `pagehide` covers the desktop close. */
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") markVisit(); };
    const onPageHide = () => markVisit();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  /* ── follows ──
   * Two jobs on one event. Analytics sees a follow when the list grows (the
   * term goes through the same guard as search text). And an existing push
   * subscription is kept in step, so alerts watch what the reader follows now
   * — syncPush never prompts, and does nothing for someone not subscribed. */
  const followCountRef = useRef(null);
  const ownState = (loc && loc.stateAbbr) || null;
  useEffect(() => {
    followCountRef.current = getFollows();
    const onChange = (e) => {
      const next = Array.isArray(e && e.detail) ? e.detail : getFollows();
      const prev = followCountRef.current || [];
      if (next.length > prev.length) {
        const added = next.find((t) => !prev.includes(t));
        track("follow_added", { term: searchQueryProp(added), follows: next.length });
      }
      followCountRef.current = next;
      /* The reader's OWN state, never verdictState: that can be the sender's
       * state from a shared link (?st=), and a subscription must not be moved
       * to Texas because a friend in Texas sent a link. */
      if (ownState && pushSupported()) syncPush({ stateAbbr: ownState, follows: next }).catch(() => {});
    };
    window.addEventListener(FOLLOWS_EVENT, onChange);
    return () => window.removeEventListener(FOLLOWS_EVENT, onChange);
  }, [ownState]);

  /* A new state is a different weekly digest: tell an existing subscription.
   * Only on a CHANGE of state — the restore on every page load is the same
   * state the subscription was saved with, and re-posting it each visit
   * would be a write per page view for nothing. */
  const syncedStateRef = useRef(null);
  useEffect(() => {
    const st = loc && loc.stateAbbr;
    if (!st) return;
    const prev = syncedStateRef.current;
    syncedStateRef.current = st;
    if (!prev || prev === st || !pushSupported()) return;
    syncPush({ stateAbbr: st, follows: getFollows() }).catch(() => {});
  }, [loc]);

  /* ── alerts ──
   * `enablePush` must run inside the click that asked for it: it is the one
   * call that can show the browser's permission prompt, and browsers only
   * allow that from a user gesture. So the stories' "Get a weekly heads-up"
   * calls it directly when it can succeed, and opens the alerts sheet either
   * way — the sheet is where the outcome, the iPhone Home Screen step, and the
   * way back out are said. */
  const refreshPushState = useCallback(async () => {
    let state = "unsupported";
    try { state = await getPushState(); } catch (_) { /* unsupported */ }
    setPush((p) => ({ ...p, state }));
    return state;
  }, []);

  const enablePush = useCallback(async () => {
    const stateAbbr = loc && loc.stateAbbr;
    setPush((p) => ({ ...p, busy: true, msg: null, dropped: [] }));
    const out = await subscribePush({ stateAbbr, follows: getFollows() });
    if (out.ok) {
      track("push_enabled", { state: out.stateAbbr || stateAbbr || null, follows: (out.follows || []).length });
      setPush({ state: "subscribed", busy: false, msg: null, dropped: out.dropped || [] });
    } else {
      track("push_failed", { reason: out.reason });
      setPush((p) => ({ ...p, busy: false, msg: out.message }));
      refreshPushState();
    }
  }, [loc, refreshPushState]);

  const disablePush = useCallback(async () => {
    setPush((p) => ({ ...p, busy: true, msg: null }));
    const out = await unsubscribePush();
    setPush((p) => ({ ...p, busy: false, msg: out.ok ? null : out.message, dropped: [] }));
    if (out.ok) track("push_disabled");
    refreshPushState();
  }, [refreshPushState]);

  const openAlerts = useCallback(() => {
    setAlertsOpen(true);
    refreshPushState();
  }, [refreshPushState]);

  const enablePushFromStories = useCallback(() => {
    setAlertsOpen(true);
    const canAskNow = loc && loc.stateAbbr && pushSupported() && !needsInstallForPush() &&
      typeof Notification !== "undefined" && Notification.permission !== "denied";
    if (canAskNow) enablePush();
    else refreshPushState();
  }, [loc, enablePush, refreshPushState]);

  /** Selecting a store is one action: focus its pin and scope the product list.
   *  Open on the bucket that has something in it — "names this store" when a
   *  notice names its chain, otherwise everything distributed in the area. */
  const scopeForStore = useCallback((i) => (i >= 0 && namedRecallsFor(stores[i]).length > 0 ? "named" : "area"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stores, byChain]);

  /* Picking a store is a navigation on a phone, not just a highlight.
   *
   * At md+ the stores and the recalls are both on screen, so selecting is a
   * toggle and the recalls beside it re-scope in place. On a phone they are
   * two tabs, so a selection that only re-scoped a list you cannot see looked
   * like nothing happened — which is exactly why the old card had to explain
   * itself with "Showing its recalls below ↓", pointing below at a tab bar.
   * Now the selection takes you there, the way every master/detail list on a
   * phone does, and re-tapping the selected store goes back to its recalls
   * rather than clearing it. Clearing is the ✕ on the selection bar, which is
   * on screen in both tabs. */
  const applySelection = useCallback((i, { fly }) => {
    setActiveStore((prev) => {
      const next = prev === i && isWide ? -1 : i;
      /* Only the camera. Whether a bubble opens is `showPopup` on the map,
       * decided by how much map there is to open it over — it is not this
       * function's business, and it used to be, which is how the bubble ended
       * up with a life of its own. */
      if (next >= 0 && fly && mapRef.current) mapRef.current.focusStore(next);
      setStoreScope(scopeForStore(next));
      return next;
    });
    setLimit(25);
    if (!isWide) setTab("recalls");
    // A re-scoped list read from wherever the last one was left off.
    if (productsScrollRef.current) productsScrollRef.current.scrollTop = 0;
  }, [scopeForStore, isWide]);

  const selectStore = useCallback((i) => applySelection(i, { fly: true }), [applySelection]);

  /* A pin is a toggle at every size, and it stays on the map.
   *
   * It was neither. Toggling was wide-screen only, so on a phone tapping the
   * pin you had just picked did nothing you could see — and the tap also ran
   * the list's navigation, throwing you onto the Recalls tab and taking the
   * map, the pin and the whole gesture off screen. Picking a store from the
   * list is a navigation because a list row is a link; tapping a pin is a
   * selection on the thing you are looking at, and you stay looking at it.
   * The store list scrolls to the row underneath, and the scope bar names the
   * selection on both tabs. */
  const onMarkerClick = useCallback((i) => {
    setActiveStore((prev) => {
      const next = prev === i ? -1 : i;
      setStoreScope(scopeForStore(next));
      return next;
    });
    setLimit(25);
    if (productsScrollRef.current) productsScrollRef.current.scrollTop = 0;
    const el = storeItemRefs.current[i];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [scopeForStore]);

  const clearStore = useCallback(() => {
    setActiveStore(-1);
    setStoreScope("named");
    setLimit(25);
  }, []);

  /* Two different mechanisms, one question: is there a panel beside the map.
   * A phone drags the boundary between them (`view`); a wide screen switches
   * the lists themselves off, and with nothing left to show the panel has no
   * reason to hold a column. */
  const listHidden = isWide ? !(storesShown || recallsShown) : view === "map";
  const mapHidden = view === "list" && !isWide;

  /* MapLibre caches its container size, so every change that resizes the map
   * column has to say so. The list switches are in here for the same reason
   * the split percentages are: they change the column's width, and without
   * this the canvas keeps the old one and the pins land off the edge. */
  useEffect(() => {
    mapRef.current && mapRef.current.resize();
  }, [view, stores, tab, sideBySide, splitPct, mapPct, mapWidthPct, storesShown, recallsShown, isWide]);

  const stepView = useCallback((dir) => {
    setView((v) => VIEWS[Math.min(VIEWS.length - 1, Math.max(0, VIEWS.indexOf(v) + dir))]);
  }, []);

  const setScopePref = useCallback((next) => {
    setScope(next);
    savePref("rr-mode", next);
    setLimit(25);
  }, []);

  /* Turning both off is how you get a full-bleed map, so neither switch
   * refuses to go off. What it must not do is leave an empty panel standing:
   * `listHidden` below reads the pair, and the panel goes with them. */
  const toggleStores = useCallback(() => {
    setStoresShown((prev) => { savePref("rr-show-stores", !prev); return !prev; });
  }, []);
  const toggleRecalls = useCallback(() => {
    setRecallsShown((prev) => { savePref("rr-show-recalls", !prev); return !prev; });
  }, []);

  /* One breakpoint for the whole information architecture, at lg (1024px).
   *
   * It used to be md (768), which put an iPad in portrait — 820px, touch —
   * into the two-column desktop layout: a 404px map next to a 416px panel,
   * serving neither. A two-column map-and-list layout needs about 1024px
   * before the second column is worth what it costs the first. Below that,
   * the phone's architecture is simply the better one, on a tablet as much as
   * on a phone. */
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const listSplit = useSplitDrag({
    boxRef: splitRef, axis: sideBySide ? "x" : "y", value: splitPct, setValue: setSplitPct,
    storageKey: "rr-split", min: MIN_SPLIT, max: MAX_SPLIT, reset: DEFAULT_SPLIT,
  });
  const panelSplit = useSplitDrag({
    boxRef: mainRef, axis: "x", value: mapWidthPct, setValue: setMapWidthPct,
    storageKey: "rr-map-width", min: MIN_MAP_WIDTH, max: MAX_MAP_WIDTH, reset: DEFAULT_MAP_WIDTH,
  });
  const mapSplit = useSplitDrag({
    boxRef: mainRef, axis: "y", value: mapPct, setValue: setMapPct,
    storageKey: "rr-map-pct", min: MIN_MAP_PCT, max: MAX_MAP_PCT, reset: DEFAULT_MAP_PCT,
  });

  async function runSourceCheck() {
    setDiag({ busy: true });
    try {
      const res = await fetch("/api/diag?probe=feeds", { headers: { Accept: "application/json" } });
      const body = await res.json();
      setDiag(res.ok ? body : { error: body.error || `diagnostics returned HTTP ${res.status}` });
    } catch (err) {
      setDiag({ error: `couldn't reach the diagnostics endpoint (${err.message})` });
    }
  }

  function toggleLayout() {
    const next = !sideBySide;
    setSideBySide(next);
    savePref("rr-side-by-side", next);
  }

  // Inline basis drives both axes; the phone divider owns the map's share.
  /* The split only exists while there are two lists to split. With one of them
   * switched off the survivor takes the panel, so it must not keep a basis
   * that leaves half the column empty. */
  const bothLists = storesShown && recallsShown;
  const storesStyle = isWide && bothLists
    ? { flexBasis: `${splitPct}%`, flexGrow: 0, flexShrink: 0 }
    : undefined;
  /* The map only gives up its share when there is a panel to give it to. With
   * no location yet there is no panel, and the old hard-coded 42% left the
   * landing screen's headline and its one button squeezed into the top of the
   * phone with half the viewport blank underneath. */
  const panelShowing = Boolean(loc) && !listHidden;
  /* Before a location there is no map and no panel, only the landing screen —
   * so the split must not exist yet. It did: on a wide window this column kept
   * its ~48% basis with flexGrow 0, which centred the landing copy inside the
   * left half of an otherwise empty page and read as a layout that had failed
   * to load. Getting a location is this screen's whole job, so it gets the
   * whole screen. */
  /* And when the lists are hidden the map takes the whole width — the same
   * argument, one level up. It did not: this branch kept handing the map its
   * `mapWidthPct` basis with `flexGrow: 0`, so hiding the panel left the map
   * at 48% of the window with an empty column beside it. A basis is only
   * right while there is something on the other side of it. */
  /* No location: the map column holds only "Stores need a location", and the
   * panel beside it (wide) or the Recalls tab (phone) still lists All US. */
  const mapStyle = listHidden || (!loc && !isWide)
    ? { flexBasis: "100%", flexGrow: 1, flexShrink: 1 }
    : isWide
      ? { flexBasis: `${mapWidthPct}%`, flexGrow: 0, flexShrink: 0 }
      : { flexBasis: panelShowing ? `${mapPct}%` : "100%" };

  const selectedStore = activeStore >= 0 ? stores[activeStore] : null;

  /* ── which list the Recalls panel reads ──
   *   Near me   the area list (live, state-scoped)
   *   All US    the national list (live, ?scope=us), or while it loads / if
   *             it failed, the national index — never a mix of the two
   *   a store   always the area list, whatever the scope: a store is a place,
   *             and a Texas-only recall naming Target does not concern the
   *             Target on 34th St. */
  const usMode = viewScope === "us";
  const nationalIndexList = useMemo(() => {
    if (!usMode || national.status === "done" || !index) return [];
    return recentForUs(index, { sinceDays: 400 })
      .map((r) => ({ ...r, date: r.date ? new Date(`${r.date}T12:00:00Z`) : null }));
  }, [usMode, national.status, index]);
  const listFrom = selectedStore || !usMode ? "area" : national.status === "done" ? "us" : "index";
  const listRecalls = listFrom === "area" ? recalls : listFrom === "us" ? national.recalls : nationalIndexList;
  const listSources = listFrom === "area" ? sources : listFrom === "us" ? national.sources : [];
  const listBusy = listFrom === "area" ? productsBusy : national.status === "loading" && !nationalIndexList.length;
  const listFreshness = useMemo(
    () => (index || listSources.length ? freshnessOf(index, listFrom === "index" ? null : listSources) : []),
    [index, listSources, listFrom],
  );
  /* Search is national in both scopes: its freshness is the index's, with the
   * live list's dates winning where the reader has one loaded. */
  const searchFreshness = useMemo(
    () => (index ? freshnessOf(index, usMode ? (national.status === "done" ? national.sources : null) : (loc ? sources : null)) : []),
    [index, usMode, national.status, national.sources, loc, sources],
  );
  const listFdaGap = !listBusy && listRecalls.length > 0 && fdaMissing(listFreshness, listRecalls);
  /* All US, one card: does it reach the reader's state? Neutral words only. */
  const ownAbbr = loc && loc.stateAbbr;

  /* Every chain with a storefront near you. The "at a store near you" scope is
   * exactly this set applied to the recall list: notices that name a chain you
   * could actually walk into, rather than notices that name any chain
   * anywhere. */
  const nearbyChainIds = useMemo(() => {
    const ids = new Set();
    for (const st of stores) for (const id of st.chainIds || []) ids.add(id);
    return ids;
  }, [stores]);

  /* Everything currently narrowing the recall list, in one object so the list
   * and the facet counts can never disagree about what is on. */
  const filterState = useMemo(() => ({
    q: filterText.trim().toLowerCase(),
    hidden: hiddenSources,
    highOnly,
    cats: categoryKeys.length ? new Set(categoryKeys) : null,
    whys: reasonKeys.length ? new Set(reasonKeys) : null,
    /* A selected store is the most specific claim available, so it wins.
     * Otherwise the scope decides: "named" narrows to the chains standing near
     * you; "area" does not narrow by store at all. */
    chainScope: selectedStore
      ? (storeScope === "named" ? new Set(selectedStore.chainIds) : null)
      : (scope === "named" && !usMode ? nearbyChainIds : null),
  }), [filterText, hiddenSources, highOnly, categoryKeys, reasonKeys, selectedStore, storeScope, scope, nearbyChainIds, usMode]);

  /* The option LIST comes from every recall, so a chip never disappears
   * mid-session; the COUNT on it comes from the current filters, so it never
   * over-promises. A chip that would land on nothing is disabled rather than
   * hidden — a menu that reshuffles as you use it is a menu you have to
   * re-read every time. */
  function facetOptions(keyFn) {
    const m = new Map();
    for (const r of listRecalls) {
      const c = keyFn(r);
      if (!m.has(c.key)) m.set(c.key, { value: c.key, label: c.label, count: 0 });
    }
    return m;
  }

  const categoryOptions = useMemo(() => {
    const m = facetOptions(categoryFor);
    for (const r of listRecalls) if (passesFilters(r, filterState, "cat")) m.get(categoryFor(r).key).count += 1;
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRecalls, filterState]);

  /* Why a thing was recalled, counted the same way its type is. Ordered by
   * hazard family rather than alphabetically or by count — someone scanning
   * for "the pathogens" should find them together, and a list that reorders
   * itself as the counts change is a list you have to re-read every time. */
  const reasonOptions = useMemo(() => {
    const m = facetOptions(reasonFor);
    for (const r of listRecalls) if (passesFilters(r, filterState, "why")) m.get(reasonFor(r).key).count += 1;
    return [...m.values()].sort((a, b) => REASON_ORDER.indexOf(a.value) - REASON_ORDER.indexOf(b.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRecalls, filterState]);

  const sourceOptions = useMemo(() => {
    const m = new Map();
    for (const r of listRecalls) if (!m.has(r.source)) m.set(r.source, { value: r.source, label: r.source, count: 0 });
    for (const r of listRecalls) if (passesFilters(r, filterState, "source")) m.get(r.source).count += 1;
    return [...m.values()];
  }, [listRecalls, filterState]);

  // A new location brings a different set of types and hazards; drop any
  // selection that no longer exists rather than silently filtering everything
  // out. (Two independent facets, one guard each — a stale reason must not
  // clear a live type.)
  useEffect(() => {
    if (!categoryKeys.length) return;
    const have = new Set(categoryOptions.map((o) => o.value));
    const next = categoryKeys.filter((k) => have.has(k));
    if (next.length !== categoryKeys.length) setCategoryKeys(next);
  }, [categoryOptions, categoryKeys]);

  useEffect(() => {
    if (!reasonKeys.length) return;
    const have = new Set(reasonOptions.map((o) => o.value));
    const next = reasonKeys.filter((k) => have.has(k));
    if (next.length !== reasonKeys.length) setReasonKeys(next);
  }, [reasonOptions, reasonKeys]);

  const filtered = useMemo(
    () => listRecalls.filter((r) => passesFilters(r, filterState)),
    [listRecalls, filterState]
  );

  // Severity-first ordering pushed months-old class I notices above this
  // week's, which reads as stale data. Newest is the default; risk is a choice.
  const sorted = useMemo(() => {
    const sev = { high: 0, med: 1, low: 2 };
    /* "Newest" means newest to the reader: the day the agency published the
     * notice (`posted`), not the day the company started the recall — FDA
     * publishes weeks later, and sorting by the start date buried a recall
     * that was in the news this week behind ones nobody has heard of. */
    const t = (r) => { const d = r.posted || r.date; return d ? new Date(d).getTime() : 0; };
    return [...filtered].sort((a, b) =>
      sortBy === "risk"
        ? ((sev[a.severity] ?? 1) - (sev[b.severity] ?? 1)) || t(b) - t(a)
        : t(b) - t(a) || ((sev[a.severity] ?? 1) - (sev[b.severity] ?? 1)));
  }, [filtered, sortBy]);

  /* Counted against every filter except its own, the way every facet chip in
   * this app is counted — otherwise switching it on would make it read
   * "184 of 184", which says nothing. */
  const highCount = useMemo(
    () => listRecalls.filter((r) => r.severity === "high" && passesFilters(r, filterState, "high")).length,
    [listRecalls, filterState]
  );
  const sourceNames = useMemo(() => [...new Set(listRecalls.map((r) => r.source))], [listRecalls]);
  const remaining = sorted.length - limit;

  /* Everything currently narrowing the list, as removable chips.
   *
   * The filters used to live in three places — the type menu in the global
   * header, the source toggles in the recalls toolbar, the sort chips in its
   * header — and none of them told you what was already on. So they all moved
   * behind one Filters control, and this row is the other half of that trade:
   * a filter may be one tap out of sight, but it is never invisible. */
  const activeFilters = useMemo(() => {
    const out = [];
    if (filterText.trim()) {
      out.push({ key: "q", label: `“${truncate(filterText.trim(), 22)}”`, clear: () => setFilterText("") });
    }
    if (highOnly) out.push({ key: "high", label: "High-risk only", clear: () => setHighOnly(false) });
    for (const k of categoryKeys) {
      const o = categoryOptions.find((x) => x.value === k);
      if (o) out.push({ key: `cat:${k}`, label: o.label, clear: () => setCategoryKeys(categoryKeys.filter((x) => x !== k)) });
    }
    for (const k of reasonKeys) {
      const o = reasonOptions.find((x) => x.value === k);
      if (o) out.push({ key: `why:${k}`, label: o.label, clear: () => setReasonKeys(reasonKeys.filter((x) => x !== k)) });
    }
    for (const name of sourceNames) {
      if (!hiddenSources.has(name)) continue;
      out.push({
        key: `src:${name}`, label: `${name} hidden`,
        clear: () => setHiddenSources((prev) => { const n = new Set(prev); n.delete(name); return n; }),
      });
    }
    return out;
  }, [filterText, highOnly, categoryKeys, categoryOptions, reasonKeys, reasonOptions, sourceNames, hiddenSources]);

  /* What the Filters button's badge counts.
   *
   * Not every active filter — severity, product type and the search text are
   * all visible as their own controls now, and a badge that counted them
   * would be a second, vaguer report of something already on screen. It
   * counts what is only inside the sheet: reason, source, and a non-default
   * sort. That is the question the badge is actually answering — is anything
   * narrowing this list that I cannot see? */
  const hiddenFilterCount = useMemo(() => {
    const hidden = sourceNames.filter((n) => hiddenSources.has(n)).length;
    return reasonKeys.length + hidden + (sortBy !== "newest" ? 1 : 0);
  }, [reasonKeys, sourceNames, hiddenSources, sortBy]);

  const clearFilters = useCallback(() => {
    setFilterText("");
    setHighOnly(false);
    setCategoryKeys([]);
    setReasonKeys([]);
    setHiddenSources(new Set());
    setLimit(25);
  }, []);

  // Nearest found store per chain, so a recall can link to the closest one.
  const nearestByChain = useMemo(() => {
    const m = new Map();
    stores.forEach((s, i) => {
      for (const id of s.chainIds) if (!m.has(id)) m.set(id, i);
    });
    return m;
  }, [stores]);

  function nearbyStoresFor(r) {
    const seen = new Set();
    const out = [];
    for (const id of r.retailerIds || []) {
      const i = nearestByChain.get(id);
      if (i != null && !seen.has(i)) { seen.add(i); out.push(i); }
    }
    return out.slice(0, 4);
  }

  /* Recalls that name this store's chain by name. Independents have no chain,
   * so this is always empty for them — which is the honest answer, not a gap. */
  function namedRecallsFor(store) {
    const seen = new Set();
    const out = [];
    for (const id of store.chainIds || []) {
      for (const r of byChain.get(id) || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
    return out;
  }

  /* Distance order, always.
   *
   * This used to hoist every named store above every unnamed one, which read
   * as helpful and worked as a filter nobody asked for: independents landed
   * below as many as 24 chains, off the bottom of a phone, and the app looked
   * like it had stopped returning them. Whether a notice names a store is now
   * the scope control's job — something you can see — and the list is free to
   * answer the question it is actually labelled with, which is what is near
   * me. */
  const rankedStores = useMemo(() => {
    const withCounts = stores.map((s, i) => ({ s, i, n: namedRecallsFor(s).length }));
    const list = scope === "named" ? withCounts.filter((x) => x.n > 0) : withCounts;
    return [...list].sort((a, b) => a.s.distanceMiles - b.s.distanceMiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, byChain, scope]);

  const namedCount = selectedStore ? namedRecallsFor(selectedStore).length : 0;

  /* Selection is chain-level: a notice names "Trader Joe's", not one address.
   * Every nearby location of the selected chain reflects that. */
  const activeChainIds = useMemo(
    () => new Set(selectedStore ? selectedStore.chainIds : []),
    [selectedStore]
  );
  const sameChain = (store) => (store.chainIds || []).some((id) => activeChainIds.has(id));
  const activeChainStores = useMemo(
    () => (selectedStore ? stores.filter(sameChain) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stores, activeChainIds, selectedStore]
  );

  /* Pin numerals follow the list's display order, and pins the list is
   * currently hiding get no numeral at all. Index-aligned with `stores`. */
  const { pinLabels, pinNamed, pinNotes, pinWeights } = useMemo(() => {
    const labels = stores.map(() => "");
    const counts = stores.map((st) => namedRecallsFor(st).length);
    const flags = counts.map((n) => n > 0);
    /* The line under a pin's name on the map. It gets one shot at saying
     * something the name does not, so it carries the count — which is the
     * only reason that pin is labelled at all — and falls back to what kind
     * of place it is. Never the chain label: for CVS that renders "CVS"
     * under "CVS". */
    const notes = stores.map((st, i) =>
      counts[i] > 0
        ? plural(counts[i], "notice", "notices")
        : st.independent ? "independent" : "");
    rankedStores.forEach(({ i }, pos) => { labels[i] = String(pos + 1); });
    return { pinLabels: labels, pinNamed: flags, pinNotes: notes, pinWeights: counts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, rankedStores, byChain]);

  /* What each scope would leave you with, counted against every other filter
   * that is already on — the same promise the facet chips make. Both numbers
   * are recalls, which is the whole point of the row: one subject, one unit,
   * two answers. */
  const scopeCounts = useMemo(() => {
    let named = 0;
    let area = 0;
    for (const r of recalls) {
      if (!passesFilters(r, filterState, "chainScope")) continue;
      area += 1;
      if ((r.retailerIds || []).some((id) => nearbyChainIds.has(id))) named += 1;
    }
    return { named, area };
  }, [recalls, filterState, nearbyChainIds]);

  /* The count the active scope chip is displaying, so nothing else on screen
   * has to repeat it. Null while a store is selected: that branch of the row
   * shows a different pair of chips and no single number stands for the list. */
  const scopeShown = selectedStore ? null : (scope === "named" ? scopeCounts.named : scopeCounts.area);
  /* All US banner count: the list before search text, so the banner and the
   * number beside the search box only differ once a search narrows it. */
  const filteredBase = useMemo(
    () => (usMode ? listRecalls.filter((r) => passesFilters(r, { ...filterState, q: "" })).length : 0),
    [usMode, listRecalls, filterState],
  );

  /* The one line that answers why anyone opened the app.
   *
   * It states the RELATIONSHIP — which chains, how bad — and deliberately no
   * longer restates the recall count, because the scope row directly above it
   * is now two chips whose whole content is that count. The same number in two
   * adjacent bands is how a screen starts feeling like a dashboard nobody
   * asked for. */
  const headline = useMemo(() => {
    if (usMode && !selectedStore) return null; // All US has its own banner
    if (storesStatus?.busy || productsBusy) return null;
    if (!recalls.length) return { tone: "calm", text: "No active recalls match your area." };
    const named = new Set();
    for (const st of stores) {
      for (const r of namedRecallsFor(st)) named.add(r.id);
    }
    if (!named.size) {
      return { tone: "calm",
        text: `No recall notice names a store near you. Everything below covers ${loc?.stateAbbr || "your area"} without naming a retailer.` };
    }
    /* Deliberately nothing.
     *
     * "13 chains near you are named in a recall notice" restated the chip
     * directly above it — "At a store near you 47" — in different units, and
     * spent a whole band on a phone doing it. Worse, it read as a statement
     * where a control already existed: switching to that scope narrows both
     * lists to exactly those chains (see rankedStores), so the sentence was
     * describing a thing you could already press.
     *
     * The two cases below survive because nothing else says them: an empty
     * result, and the one that matters most — notices cover your area but
     * name no shop near you, which is not the same as nothing being wrong.
     * The Class I count this used to carry is now the high-risk filter beside
     * the search box, where it is a control rather than a number. */
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, recalls, byChain, loc, storesStatus, productsBusy, usMode, selectedStore]);

  // Both lookups roll up into one "the app is working" flag.
  const scanning = productsBusy || Boolean(storesStatus?.busy);

  /* Which list is on screen, by size. A phone shows one at a time and the tab
   * bar picks; a wide screen shows both unless a switch says otherwise. The
   * `lg:` half comes last in the string because these are all `display`
   * utilities of equal specificity — the later one wins at the breakpoint. */
  /* No location, no store list: the map column says so, once. */
  const showStores = !loc ? "hidden " : "flex " + (tab === "near" ? "" : "max-lg:hidden ") +
    (storesShown ? "" : "lg:hidden ");
  const showProducts = "flex " + (tab === "recalls" ? "" : "max-lg:hidden ") +
    (recallsShown ? "" : "lg:hidden ");

  /* Where a selected store's recalls actually appear depends on the layout,
   * and getting this wrong is how the card came to say "Showing its recalls
   * below ↓" on a phone, where "below" is a tab you have to go to. */
  const recallsHere = isWide
    ? (sideBySide ? "Showing its recalls →" : "Showing its recalls below ↓")
    : "Showing its recalls — Recalls tab";

  /* The search row, defined once and placed twice.
   *
   * On a phone it leads the panel, above the scope chips: search is the
   * most-reached control in here and it was the fourth band down, under
   * two rows of chips. On a wide screen it stays with the recall list it
   * filters — up there it would sit above the store list, separated from
   * its own results by an entire second list. */
  const filterBar = (
  <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
    {/* The count only when it is news.
        The active scope chip a row above already reads "At a
        store near you 47", so repeating 47 here is the same
        number twice on one screen. It stops being the same
        number the moment a search or a facet narrows the list —
        and that is exactly when it is worth saying. */}
    <span className="microlabel hidden shrink-0 lg:inline">Recalls</span>
    {(listBusy || sorted.length !== (usMode && !selectedStore ? filteredBase : scopeShown)) && (
      <span id="stat-recalls" className="tnum shrink-0 text-xs font-semibold text-mint">
        {listBusy ? "…" : fmtCount(sorted.length)}
      </span>
    )}
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fog" />
      <Input
        id="filter-text"
        type="search"
        value={filterText}
        onChange={(e) => { setFilterText(e.target.value); setLimit(25); }}
        placeholder="Search recalls…"
        aria-label="Search recalled products"
        className="h-9 pl-9 text-[13px]"
      />
    </div>
    <div className="relative shrink-0">
      <FilterButton
        id="btn-filters"
        open={filtersOpen}
        count={hiddenFilterCount}
        onClick={() => setFiltersOpen((v) => !v)}
      />
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        anchored={isWide}
        count={activeFilters.length}
        onClear={clearFilters}
        resultLabel={`${plural(sorted.length, "recall", "recalls")}`}
      >
        <FilterGroup
          label="Reason for recall"
          options={reasonOptions}
          selected={reasonKeys}
          onChange={(next) => { setReasonKeys(next); setLimit(25); }}
          allLabel="Any reason"
        />
        <FilterGroup
          label="Product type"
          options={categoryOptions}
          selected={categoryKeys}
          onChange={(next) => { setCategoryKeys(next); setLimit(25); }}
          allLabel="All types"
        />
        <FilterGroup
          label="Source"
          options={sourceOptions}
          /* Empty means "everything", so a full set reads as empty
           * — otherwise the All chip could never be the on state. */
          selected={sourceNames.some((n) => hiddenSources.has(n)) ? sourceNames.filter((n) => !hiddenSources.has(n)) : []}
          onChange={(next) => {
            setHiddenSources(next.length ? new Set(sourceNames.filter((n) => !next.includes(n))) : new Set());
            setLimit(25);
          }}
          allLabel="All sources"
        />
        <FilterChoice
          label="Sort by"
          options={SORTS}
          value={sortBy}
          onChange={(v) => { setSortBy(v); setLimit(25); }}
        />
      </FilterSheet>
    </div>
  </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink" style={motionStyle}>
      {/* ================= top bar =================
          Identity and location only. The recall search box and the product
          type menu used to live here too, which put the controls that filter
          the recall list an entire layout away from the recall list — and on
          a phone squeezed all four into one 360px row. They now sit in the
          Recalls panel, next to the thing they act on. */}
      <header className="z-20 shrink-0 border-b border-line bg-panel elev-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2.5 sm:gap-x-3 sm:px-4">
          <span className="flex shrink-0 items-center gap-2">
            <Radar className="size-5 text-mint" />
            <span className="hidden text-base font-bold tracking-tight sm:inline">Yanked</span>
            <Tooltip content="Early release — data and matching are still being refined">
              <Badge variant="beta" className="hidden sm:inline-flex">beta</Badge>
            </Tooltip>
          </span>

          {/* ---- where you are (wide screens) ----
              The phone has the bottom bar for this; a wide screen has no bar,
              so Home and the map-and-lists view are a two-way switch here,
              next to the name. Two, not three: at this width the store list
              and the recall list are one view side by side, not two places. */}
          <div className="hidden shrink-0 items-center gap-1 rounded-full border border-line bg-panel-2 p-0.5 lg:flex"
               role="group" aria-label="View">
            {[
              ["home", "Home", House, () => setTab("home")],
              ["map", "Stores & recalls", MapIcon, () => setTab((t) => (t === "home" ? "near" : t))],
            ].map(([key, label, Icon, go]) => {
              const on = key === "home" ? tab === "home" : tab !== "home";
              return (
                <button key={key} type="button" onClick={go} aria-pressed={on}
                        className={"tap inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold " +
                          (on ? "bg-mint-soft text-mint" : "text-fog hover:text-paper")}>
                  <Icon className="size-3.5" aria-hidden="true" /> {label}
                </button>
              );
            })}
          </div>

          {/* ---- where you are, and how wide to look ----
              One control for the place, the same element at every width,
              and beside it the one switch for the scope. It used to be five
              location entry points — a header form, a search button, a "My
              Location" button, a ZIP card in search and a button in the
              digest — with errors printed in a strip across the page, 900px
              from the field that caused them. */}
          <div role="group" aria-label="Location and scope" className="flex min-w-0 items-center gap-1.5">
            <LocationButton
              loc={loc}
              busy={locating || (productsBusy && !recalls.length)}
              open={pickerOpen}
              onOpen={() => (pickerOpen ? setPickerOpen(false) : openLocationPicker(null, "header"))}
            />
            <ScopeSwitch scope={viewScope} stateAbbr={loc && loc.stateAbbr} onChange={changeScope} />
          </div>

          {/* Scanning is a task, not a filter.
              On a phone it is a bottom-bar destination; on a desktop it sat in
              the recalls toolbar next to Filters, styled like a sibling of
              one — so the same action read as top-level on one screen and as
              a list control on the other. It is the app's one primary verb,
              so here it is the header's one primary button. */}
          <Tooltip content="Point the camera at a package and check it against these notices">
            <Button
              id="btn-scan" size="sm"
              className="hidden h-9 shrink-0 px-3.5 lg:ml-auto lg:inline-flex"
              onClick={() => setScanOpen(true)}
            >
              <ScanLine /> Scan
            </Button>
          </Tooltip>

          {/* Phone: one overflow control instead of three standing ones. */}
          <Button
            id="btn-more" variant="secondary" size="icon" className="ml-auto h-9 w-9 shrink-0 lg:hidden"
            onClick={() => setMoreOpen(true)}
            aria-label="More: theme, data sources, about"
          >
            <MoreHorizontal />
          </Button>
          <Tooltip content={theme === "system" ? "Following your system theme — click for light" : `${theme[0].toUpperCase()}${theme.slice(1)} theme — click to change`}>
            <Button
              id="btn-theme" variant="secondary" size="icon" className="hidden h-9 w-9 shrink-0 lg:ml-0 lg:inline-flex"
              onClick={cycleTheme}
              aria-label={`Theme: ${theme}. Click to change.`}
            >
              {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <MonitorSmartphone />}
            </Button>
          </Tooltip>

          {/* ---- what the window is showing (wide screens) ----
              These were one "Hide Lists" button floating over the top-left
              corner of the map, which is where a map control belongs and not
              where a layout control does: it sat on the map while acting on
              everything except the map, and it could only take both lists at
              once. Beside the theme switch they read as what they are — chrome
              that decides what the window shows — and they take one list each,
              so "just the recalls, I don't care which shop" is finally a thing
              you can ask for. Turning both off is the old button. */}
          {loc && tab !== "home" && (
            <>
              <span aria-hidden="true" className="hidden h-5 w-px shrink-0 bg-line lg:block" />
              <div className="hidden shrink-0 items-center gap-1.5 lg:flex" role="group" aria-label="Panels to show">
                {[
                  ["stores", "Stores", "store list", Store, storesShown, toggleStores, "stores-list-scroll"],
                  ["recalls", "Recalls", "recall list", ClipboardList, recallsShown, toggleRecalls, "recalls-list-scroll"],
                ].map(([key, label, spoken, Icon, on, toggle, controls]) => (
                  <Tooltip key={key}
                           content={on ? `Hide the ${spoken} and give the room to the map` : `Show the ${spoken}`}>
                    <Button
                      id={`btn-show-${key}`}
                      variant="secondary" size="sm"
                      aria-pressed={on}
                      aria-controls={controls}
                      onClick={toggle}
                      className={"h-9 shrink-0 px-3 " +
                        (on ? "border-mint bg-mint-soft text-mint" : "text-fog")}
                    >
                      <Icon /><span className="hidden xl:inline">{label}</span>
                    </Button>
                  </Tooltip>
                ))}
                {/* Disabled when there is only one list, never absent. A
                    control that vanishes takes its own explanation with it —
                    you are left wondering where it went, and on the way back
                    the row changes width under the pointer. Greyed out, it
                    says the same thing and stays put; the tooltip says why. */}
                <Tooltip content={!bothLists
                  ? "Needs both lists — turn the other one back on"
                  : sideBySide ? "Stack the two lists vertically" : "Put the two lists side by side"}>
                  <Button
                    id="btn-toggle-layout"
                    variant="secondary" size="icon"
                    aria-pressed={sideBySide}
                    disabled={!bothLists}
                    onClick={toggleLayout}
                    aria-label={sideBySide ? "Stack the lists vertically" : "Put the lists side by side"}
                    className="h-9 w-9 shrink-0"
                  >
                    {sideBySide ? <Rows2 /> : <Columns2 />}
                  </Button>
                </Tooltip>
              </div>
            </>
          )}
        </div>

        {(productsBusy || storesStatus?.busy || (usMode && national.status === "loading")) && <div id="progress" className="progress-track" />}

        {/* Announcements for a new place or a new scope. Nothing visible:
            the header button and the switch already show both. */}
        <p id="scope-status" role="status" aria-live="polite" className="sr-only">{liveMsg}</p>
      </header>

      {/* ================= home =================
          Search first, digest second, one column at every width.

          Search leads because it is the question people arrive with ("is
          the sausage on the news mine?") and it needs nothing from them —
          no location, no permission. The digest answers the other question,
          "anything new near me?", and falls back from the live area list to
          the national index so it has something to say before (or without)
          a location. The map, the store list and the full recall list are
          the power-user views now: one tap away on the bottom bar, or the
          header switch on a wide screen, and exactly as they were.

          On a wide screen this is a centred column rather than a stretched
          one: a verdict is a sentence, and a sentence 1400px wide is not
          one anybody reads. */}
      <div id="home-scroll"
           className={(tab === "home" ? "block " : "hidden ") + "tabbar-space min-h-0 flex-1 overflow-y-auto"}>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-5 pb-8 lg:pt-8">
          <RecallSearch
            loc={verdictLoc}
            scope={viewScope}
            freshness={searchFreshness}
            initialRecallId={DEEP_LINK.recallId}
            onOpenRecall={(r) => onVerdictOpened(r, "search")}
            onRequestLocation={() => openLocationPicker("to check your state", "search_card")}
            onSearch={onSearchSettled}
          />
          <HomeDigest
            loc={verdictLoc}
            hasLocation={Boolean(loc)}
            scope={viewScope}
            index={index}
            live={usMode
              ? (national.status === "done" ? { records: national.recalls, sources: national.sources } : null)
              : (loc && !productsBusy ? { records: recalls, sources } : null)}
            lastVisit={lastVisit}
            onOpenRecall={openRecallSheet}
            onOpenStores={goStores}
            onOpenAll={goRecalls}
            onRequestLocation={(reason, via) => openLocationPicker(reason, via || "digest")}
            onEnablePush={pushOffered ? enablePushFromStories : undefined}
            onStorySeen={(id) => track("story_viewed", { recall_id: id })}
            onCaughtUp={() => track("caught_up", { state: verdictState })}
          />
          {pushOffered && (
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-panel-2">
                <Bell className="size-4 text-fog" aria-hidden="true" />
              </span>
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-fog">
                <span className="font-semibold text-paper">A weekly heads-up</span>
                {" "}for {loc?.stateAbbr || "your state"}, and an alert straight away for a serious recall there
                or one matching a product you follow.
              </p>
              <Button variant="secondary" size="sm" className="shrink-0 pointer-coarse:h-10" onClick={openAlerts}>
                {push.state === "subscribed" ? "Alerts on" : "Set up"}
              </Button>
            </div>
          )}
          <p className="text-center text-xs leading-relaxed text-subtle">
            Beta. Recall data comes from public FDA, USDA and CPSC feeds. Not a substitute for the official
            notice — always check the product codes against it.
          </p>
        </div>
      </div>

      {/* ================= body: map + panel =================
          Mounted the first time it is opened, then kept (hidden) so a trip
          Home and back does not throw away the map, the selection or the
          scroll position. */}
      {storesWanted && (
      <main ref={mainRef}
            className={tab === "home" ? "hidden" : "flex min-h-0 flex-1 flex-col lg:flex-row"}>
        {/* -------- map -------- */}
        <div
          className={"map-shell relative min-h-0 lg:min-w-0 lg:flex-1 lg:basis-auto " +
            (loc || isWide ? "shrink-0 " : "") +
            ((loc ? (mapHidden || tab === "recalls") : tab === "recalls") ? "hidden lg:block " : "") +
            (selectedStore ? "map-has-selection" : "")}
          style={mapStyle}
        >
          {loc ? (
            <>
              {/* The bubble needs room to sit over. A wide screen always has
                  it; a phone only when the map has the screen, which is why
                  the selection also reads out in the scope row — the one place
                  that is on both tabs at every size. */}
              <Suspense fallback={<div className="shimmer absolute inset-0" aria-hidden="true" />}>
                <MapView ref={mapRef} loc={loc} stores={stores} radius={radius}
                         labels={pinLabels} named={pinNamed} notes={pinNotes} weights={pinWeights}
                         activeIndex={activeStore}
                         theme={resolvedTheme}
                         showPopup={isWide || view === "map"}
                         onMarkerClick={onMarkerClick}
                         onBackgroundClick={clearStore} />
              </Suspense>
              {/* Controls on the map, not in a band above the list.
                  The radius is a question about the map — "how far out am I
                  looking" — so it belongs on the thing it changes, where the
                  answer is visible in the same glance. Floating it also gives
                  a phone back the row it used to spend on a label, a chip
                  group and the word "mi".
                  At every size, now. A wide screen kept its own copy in the
                  store list's header, which put the map's control in the
                  header of a list — three bands from the thing it governs,
                  and gone entirely the moment you hid that list. The argument
                  for floating it was never about how wide the window is. */}
              <div className="map-controls">
                <div className="map-control-pill" role="group" aria-label="Store search radius">
                  {RADII.map((r) => (
                    <button key={r.value} type="button" onClick={() => setRadius(r.value)}
                            aria-pressed={radius === r.value}
                            className={"map-radius " + (radius === r.value ? "map-radius-on" : "")}>
                      {r.label}
                    </button>
                  ))}
                  <span className="map-radius-unit">mi</span>
                </div>
                {/* How much list you want back. Sits beside the radius
                    because the two are one question — how far, and how many
                    — and because a cap chosen out of sight is a cap nobody
                    knows is trimming their results. */}
                <Select value={String(storeCap)} onValueChange={(v) => setStoreCap(Number(v))}>
                  <SelectTrigger className="map-control-pill map-cap" aria-label="Maximum stores to show">
                    <SelectValue />
                    <span className="map-radius-unit">max</span>
                  </SelectTrigger>
                  <SelectContent>
                    {/* The heading carries the noun so the rows can stay a
                        column of numbers — "20 stores / 50 stores" reads as
                        four different things rather than one scale. */}
                    <SelectGroup>
                      <SelectLabel>Show at most</SelectLabel>
                      {STORE_CAPS.map((n) => (
                        <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              {/* One ask, one button. This screen used to carry its own "Use
                  My Location" and its own ZIP form — a fourth and fifth way
                  to set a place — and on a desktop told you to "enter a ZIP
                  above", pointing at a field in the header. */}
              <div className="fade-item max-w-sm">
                <EmptyState
                  icon={MapPin}
                  title="Stores need a location"
                  action={(
                    <Button className="mt-3" onClick={() => openLocationPicker("to find stores near you", "stores_empty")}>
                      <MapPin /> Set location
                    </Button>
                  )}
                >
                  We match recall notices to stores within a few miles of you.
                </EmptyState>
              </div>
            </div>
          )}

          {/* One overlay for the whole scan. The two lookups are sequential —
              the recalls name the chains the store search then looks for — so
              the steps are shown as a checklist instead of two loading states
              that appear to be racing each other. */}
          {scanning && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-ink/70 backdrop-blur-[2px]">
              <span className="radar-sweep" />
              {[0, 1, 2].map((i) => (
                <span key={i} className="radar-ring"
                      style={{ animationDelay: `calc(var(--rr-radar-stagger) * ${i})` }} />
              ))}
              <span className="radar-dot" />
              <div className="absolute bottom-4 flex w-full max-w-[19rem] flex-col items-center gap-2 px-4 sm:bottom-6">
                <p className="text-sm font-semibold text-paper">Scanning {loc?.label || "your area"}</p>
                <ul id="scan-steps" role="status" aria-live="polite"
                    className="elev-2 flex w-full flex-col gap-1.5 rounded-xl border border-line bg-panel px-3 py-2.5">
                  <ScanStep
                    state={productsBusy ? "busy" : "done"}
                    label="Recall notices"
                    detail={productsBusy ? "Loading…" : `${recalls.length} found`}
                  />
                  <ScanStep
                    state={productsBusy ? "waiting" : storesStatus?.busy ? "busy" : "done"}
                    label="Nearby stores"
                    detail={productsBusy ? "Waiting on notices"
                      : storesStatus?.busy ? `Searching ${RADII.find((r) => r.value === radius)?.label || ""} mi…`
                        : `${stores.length} found`}
                  />
                </ul>
              </div>
            </div>
          )}

          {/* Phone only, and only the way back. Dragging the grabber down is
              how the map goes full-screen here; once it is, there is no
              grabber left on screen, so the return trip has to sit on the map
              itself. A wide screen has the pair of switches in the top bar —
              the same state offered twice on one screen is one offer too
              many. */}
          {loc && view === "map" && (
            <div className="absolute left-3 top-3 z-10 lg:hidden">
              <Button
                id="btn-toggle-list" variant="secondary" size="sm"
                aria-controls="stores-panel"
                onClick={() => setView("split")}
                className="bg-panel/90 backdrop-blur"
              >
                <PanelRightOpen /> Show Lists
              </Button>
            </div>
          )}
        </div>

        {/* ---- map / panel divider (wide screens) ----
            The desktop counterpart of the phone's grabber: the same gesture,
            the same hook, the same keyboard handling, on the other axis. */}
        {!listHidden && isWide && (
          <div
            id="panel-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the map"
            aria-valuenow={Math.round(mapWidthPct)} aria-valuemin={MIN_MAP_WIDTH} aria-valuemax={MAX_MAP_WIDTH}
            tabIndex={0}
            {...panelSplit}
            className="split-handle group hidden w-2 shrink-0 cursor-col-resize items-center justify-center border-x border-line bg-panel hover:bg-mint-soft lg:flex"
          >
            <span className="split-grip h-8 w-0.5" />
          </div>
        )}

        {/* -------- right panel: stores over products -------- */}
        {!listHidden && (
          <aside id="stores-panel"
                 className={"relative z-10 flex min-h-0 flex-1 flex-col border-t border-line bg-ink shadow-[var(--rr-shadow-2)] lg:border-t-0 " +
                   "lg:min-w-[22rem] lg:flex-1 " + (!loc && tab === "near" ? "max-lg:hidden" : "")}>
            {/* ---- phone divider: map vs. panel ---- */}
            {/* Only where there is a map to resize. On the recalls screen there
                isn't one, and a drag handle for an absent element is 32px of
                furniture. */}
            <div className={"relative flex shrink-0 items-center border-b border-line bg-panel lg:hidden " +
              (tab === "near" && loc ? "" : "hidden")}>
              <div
                id="map-split-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the map"
                aria-valuenow={Math.round(mapPct)} aria-valuemin={MIN_MAP_PCT} aria-valuemax={MAX_MAP_PCT}
                tabIndex={0}
                {...mapSplit}
                className="split-handle group flex h-8 flex-1 cursor-row-resize items-center justify-center"
              >
                <span className="split-grip h-1 w-10" />
              </div>
              {/* The two ends the drag cannot reach: map only, and list only.
                  Dragging covers everything in between. */}
              <div className="absolute right-1.5 flex items-center gap-0.5">
                <button type="button" onClick={() => stepView(-1)} disabled={view === "map"}
                        aria-label="Show more map"
                        className="grid size-9 place-items-center rounded-md text-fog disabled:opacity-30 active:bg-panel-3">
                  <ChevronDown className="size-4" />
                </button>
                <button type="button" onClick={() => stepView(1)} disabled={view === "list"}
                        aria-label="Show more list"
                        className="grid size-9 place-items-center rounded-md text-fog disabled:opacity-30 active:bg-panel-3">
                  <ChevronUp className="size-4" />
                </button>
              </div>
            </div>

            {/* ---- one scope row ----
                The scope bar and the selected-store bar were two stacked bands
                — 53px and 93px — both answering the same question: what is
                this panel currently showing? They were never both needed,
                because picking a store overrides the scope. So they are one
                row that swaps its contents, scrolling sideways rather than
                wrapping, which is how a phone holds a variable number of
                chips without changing height.

                The leading "Recalls" label is doing real work, not decoration.
                Without it this row was a strip of numbers sitting a few
                hundred pixels above another strip of numbers (the bottom bar),
                with nothing on either saying what was being counted. Naming
                the unit once is what separates the two rows into a scope
                control and a set of destinations. */}
            {!isWide && filterBar}

            {/* ---- All US: a banner instead of the store scope ----
                The global switch already says All US; this says what the list
                is and how to read it, and offers the one narrowing that makes
                sense from here — which, being the Near me list, IS Near me. */}
            {usMode && !selectedStore ? (
              <div id="us-banner"
                   className="scope-row flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel px-3 py-2 text-[12px] text-fog">
                <span className="tnum">
                  <span className="font-semibold text-paper">All US</span>
                  {" · "}{listBusy ? "loading…" : `${fmtCount(filteredBase)} ${filteredBase === 1 ? "recall" : "recalls"}`}
                  <span className="hidden sm:inline">{" · "}each card shows where it went</span>
                </span>
                {loc && loc.stateAbbr && (
                  <button type="button" aria-pressed="false" onClick={() => changeScope("near", "recalls_chip")}
                          className="chip chip-off ml-auto shrink-0">
                    <span className="normal-case tracking-normal">Only ones that reached {loc.stateAbbr}</span>
                  </button>
                )}
                {listFdaGap && <FdaGapNote className="w-full" />}
              </div>
            ) : (
            <div className="scope-row flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-3 py-2">
              {/* "Recalls" was a label over a control that scopes recalls,
                  sitting above a list of *stores* — so on the near-me tab it
                  named the wrong thing, and on the recalls tab it named the
                  obvious one. The chips are self-describing ("At a store near
                  you", "All in NY"); a heading over them is a row of
                  chrome spent on nothing. Kept for screen readers, which do
                  need the group named. */}
              <span className="sr-only" id="scope-row-label">Recall scope</span>
              {/* The chip tooltips are a mouse affordance and nothing else, so
                  the row carries one disclosure a thumb can open. It sits
                  beside the label rather than after the chips: this row scrolls
                  sideways, and on a 390px phone anything trailing the last chip
                  is parked off the edge, which is not an affordance at all. */}
              <InfoTip
                label="What these scopes mean"
                title="How wide a net"
                body={`“${SCOPES[0].label}” shows only notices that name a chain standing near you — the most specific answer this app can give, and the smallest. “All in ${loc?.stateAbbr || "your area"}” adds every other active notice covering your area, including the many that name no retailer at all. An independent grocer can only ever appear in the second. For every recall in the country, switch the header to All US.`}
                /* With the "Recalls" heading gone this was a bare glyph
                   floating at the row's left edge, reading as debris rather
                   than a control. A disc gives it the same shape as every
                   other round icon button in the app, so it looks like
                   something to press. */
                triggerClassName="scope-info shrink-0"
                side="bottom"
              />
              {selectedStore ? (
                <>
                  <button
                    id="btn-clear-store"
                    onClick={clearStore}
                    aria-label={`Clear ${selectedStore.name} and show all nearby stores`}
                    className="chip chip-on shrink-0 max-w-[11rem]"
                  >
                    <MapPin className="size-3 shrink-0" />
                    <span className="truncate normal-case tracking-normal">{selectedStore.name}</span>
                    <X className="size-3 shrink-0" />
                  </button>
                  <div id="store-scope" className="flex shrink-0 gap-1.5" role="group" aria-label="Which recalls to show for this store">
                    {[
                      ["named", `That name it · ${namedCount}`, namedCount === 0
                        ? "No active notice names this store's chain."
                        : "Notices that name this store's chain, so its warehouses received the recalled lot."],
                      ["area", `All in ${loc?.stateAbbr || "your area"} · ${recalls.length}`,
                        "Every active notice covering your area. Most name no retailer at all, so any of them could be on this shelf."],
                    ].map(([k, lbl, title]) => (
                      <Tooltip key={k} content={title}><button type="button"
                              disabled={k === "named" && namedCount === 0}
                              onClick={() => { setStoreScope(k); setLimit(25); }}
                              aria-pressed={storeScope === k}
                              className={"chip shrink-0 " + (storeScope === k ? "chip-on" : "chip-off")}>
                        <span className="normal-case tracking-normal">{lbl}</span>
                      </button></Tooltip>
                    ))}
                  </div>
                </>
              ) : (
                <div id="scope-bar" role="group" aria-labelledby="scope-row-label" className="flex items-center gap-1.5">
                  {SCOPES.map((sc) => {
                    const n = sc.id === "named" ? scopeCounts.named : scopeCounts.area;
                    const label = sc.id === "area" && loc?.stateAbbr
                      ? `All in ${loc.stateAbbr}` : sc.label;
                    return (
                      <Tooltip key={sc.id} content={sc.hint}>
                        <button
                          type="button"
                          aria-pressed={scope === sc.id}
                          onClick={() => setScopePref(sc.id)}
                          className={"chip shrink-0 " + (scope === sc.id ? "chip-on" : "chip-off")}
                        >
                          <span className="normal-case tracking-normal">{label}</span>
                          {!scanning && <span className="tnum opacity-70">{n}</span>}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              )}
              {selectedStore && usMode && (
                <span className="shrink-0 whitespace-nowrap text-[11px] text-subtle">
                  recalls reaching {loc?.stateAbbr || "your state"} that name this chain
                </span>
              )}
            </div>
            )}

            {/* The answer, before either list. It stands down on a phone once a
                store is selected — the scope row above is the more specific
                answer, and two context bands over a short list is one too many. */}
            {headline && (
              <p id="headline"
                 className={"flex shrink-0 flex-wrap items-center gap-x-2 border-b border-line px-4 py-2 text-[12px] font-semibold leading-snug lg:py-2.5 lg:text-[13px] " +
                   (selectedStore ? "max-lg:hidden " : "") +
                   "bg-panel text-fog"}>
                {/* Only the two cases nothing else on screen says. The
                    Class I count that used to ride here is the high-risk
                    filter beside the search box now — a control instead of a
                    number, in the same pixels. */}
                <span>{headline.text}</span>
              </p>
            )}

            {/* Both lists live in one measured box so the divider can size them. */}
            <div ref={splitRef}
                 className={"flex min-h-0 flex-1 " + (sideBySide ? "flex-col lg:flex-row" : "flex-col")}>
            {/* ---- stores ---- */}
            <section className={showStores + "min-h-0 flex-1 flex-col overflow-hidden"}
                     style={storesStyle}>
              <PanelHeader
                label="Stores" countId="stat-stores" count={scanning ? "…" : stores.length}
                className="max-lg:hidden"
              >
                {/* Nothing else. The radius chips that used to sit here are
                    on the map at every size now — a question about the map,
                    answered on the map — and the fold that sat beside them is
                    the Stores switch in the top bar, which takes the list away
                    rather than collapsing it to a header for a list you
                    cannot see. What is left is the section's name and how many
                    things are in it, which is all a section header owes. */}
              </PanelHeader>

              <div id="stores-list-scroll"
                   className="tabbar-space sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {/* Stores are local whatever the header says: in All US they
                    are still matched to the recalls that reach this state. */}
                {usMode && loc && !storesNoteHidden && (
                  <p id="stores-scope-note" className="mb-2 flex items-start gap-2 text-[12px] leading-snug text-subtle">
                    <span className="min-w-0 flex-1">
                      Stores are matched to recalls that reach {loc.stateAbbr || "your state"}.{" "}
                      <button type="button" onClick={() => changeScope("near", "stores_note")}
                              className="font-semibold text-mint hover:underline">Switch to Near me</button>
                    </span>
                    <button type="button" aria-label="Dismiss this note"
                            onClick={() => { setStoresNoteHidden(true); try { sessionStorage.setItem("rr-stores-note", "1"); } catch (_) { /* memory only */ } }}
                            className="-m-1 grid size-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-panel-3 hover:text-paper">
                      <X className="size-3.5" />
                    </button>
                  </p>
                )}
                {storesStatus && !storesStatus.empty && (
                  <div id="stores-status" role="status" aria-live="polite"
                       className={"mb-2 flex items-start gap-2 text-xs " + (storesStatus.error ? "text-alert" : "text-fog")}>
                    {storesStatus.busy && <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />}
                    <span className="min-w-0 flex-1">{storesStatus.msg}</span>
                    {storesStatus.retry && (
                      <Button id="btn-retry-stores" variant="outline" size="sm" onClick={storesStatus.retry}>Retry</Button>
                    )}
                  </div>
                )}
                {storesStatus?.empty && (
                  <div id="stores-status" role="status">
                    <EmptyState icon={MapPinOff} title={storesStatus.title} compact>{storesStatus.msg}</EmptyState>
                  </div>
                )}
                {scanning && !stores.length && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2, 3, 4].map((i) => <StoreSkeleton key={i} delay={i * stagger * 2} />)}</ul>
                )}

                <ul id="stores-list" className="flex flex-col gap-2">
                  {rankedStores.map(({ s, i, n }, pos) => {
                    const isActive = activeStore === i;
                    const isSibling = !isActive && selectedStore && sameChain(s);
                    return (
                    <li
                      key={`${s.name}-${s.lat}-${s.lon}`}
                      ref={(el) => (storeItemRefs.current[i] = el)}
                      data-index={i}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => selectStore(i)}
                      className={"store-item lift fade-item cursor-pointer rounded-xl border bg-panel-2 py-3 pl-4 pr-3 " +
                        (isActive ? "active elev-2 border-mint bg-mint-soft ring-2 ring-mint"
                          : isSibling ? "same-chain elev-1 border-mint-line bg-panel-3"
                            : "elev-1 " + (activeStore >= 0 ? "receded " : "") +
                              (n > 0 ? "border-line-strong" : "border-line hover:border-line-strong"))}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="store-name truncate text-sm font-semibold">
                          <span className="store-num tnum text-mint">{pos + 1}.</span> {s.name}
                        </span>
                        <span className="tnum ml-auto shrink-0 text-[11px] text-fog">{s.distanceMiles.toFixed(1)} mi</span>
                      </div>
                      {s.address && <p className="mt-0.5 truncate text-[11px] text-fog">{s.address}</p>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {isActive && (
                          <span className="rounded-full border border-mint bg-mint px-1.5 py-px tnum text-[10px] font-bold uppercase tracking-wider text-mint-ink">
                            Selected
                          </span>
                        )}
                        {s.independent && (
                          /* This was a hover tooltip on a list whose primary
                             audience is holding a phone, which meant the one
                             caveat that keeps "Local" from reading as "clear"
                             was unreachable for most readers. */
                          <InfoTip
                            title="Local — an independent store"
                            body="No recall notice will ever name an independent by name, so it can never show a match here. That is a gap in the data, not a clean bill of health — pick it and switch to “All in your state” to see what it is actually exposed to."
                            label="Local: what this means"
                            variant="badge"
                            triggerClassName="text-fog"
                            side="top"
                          >
                            <span className="store-local rounded-full border border-line px-1.5 py-px tnum text-[10px] uppercase tracking-wider text-fog">
                              Local
                            </span>
                          </InfoTip>
                        )}
                        {/* Deliberately unalarmed language and colour. A store
                            appearing here is a name match on a notice, not a
                            verdict on the store — and most independents can
                            never match at all, which is a gap in the data
                            rather than a clean bill of health. */}
                        {/* Green is the interface saying "you did this", so it
                            cannot also be the data saying "a notice names this
                            store" — side by side those read as two selected
                            cards. A named store is carried by weight and by the
                            count itself at full text contrast, which is the
                            emphasis it always deserved and never actually had:
                            it was tinted, not prioritised. */}
                        <p className={"flex min-w-0 items-center gap-1 tnum text-[11px] " +
                          (isActive ? "text-mint"
                            : n > 0 ? "font-semibold text-paper"
                              : "text-subtle")}>
                          <span className="truncate">
                            {isActive
                              ? recallsHere
                              : isSibling
                                ? "Same chain — included above"
                                : n > 0
                                  ? `Named in ${plural(n, "recall notice", "recall notices")} — tap to see them`
                                  : s.independent
                                    ? "Independent — tap for area notices"
                                    : "No notice names this chain"}
                          </span>
                          {/* A chevron is how a phone list says "this goes
                              somewhere". Only on the rows that do. */}
                          {!isActive && !isSibling && (
                            <ChevronRight className="size-3 shrink-0 opacity-70 lg:hidden" />
                          )}
                        </p>
                      </div>
                    </li>
                    );
                  })}
                </ul>
                {/* The cap, said out loud. Without this a truncated list is
                    indistinguishable from a complete one, and widening the
                    radius looks broken: you ask for 25 miles, the nearest
                    N are already inside 5, and nothing changes. */}
                {storesTrimmed > 0 && !scanning && (
                  <p className="mt-2 px-1 pb-1 text-center text-[11px] text-subtle">
                    Showing the {stores.length} nearest of {storesTrimmed} within{" "}
                    {RADII.find((r) => r.value === radius)?.label || "?"} mi.
                  </p>
                )}
              </div>
            </section>

            {/* ---- drag divider between the two lists (desktop only) ----
                Only when there are two. A handle that resizes one list against
                nothing is furniture. */}
            {isWide && bothLists && loc && (
              <div
                id="split-handle"
                role="separator"
                aria-orientation={sideBySide ? "vertical" : "horizontal"}
                aria-label="Resize the lists"
                aria-valuenow={Math.round(splitPct)} aria-valuemin={MIN_SPLIT} aria-valuemax={MAX_SPLIT}
                tabIndex={0}
                {...listSplit}
                className={"split-handle group flex shrink-0 items-center justify-center border-line bg-panel transition-colors hover:bg-mint-soft " +
                  (sideBySide ? "w-2 cursor-col-resize border-x" : "h-2 cursor-row-resize border-y")}
              >
                <span className={"split-grip " + (sideBySide ? "h-8 w-0.5" : "h-0.5 w-8")} />
              </div>
            )}

            {/* ---- products ---- */}
            <section className={showProducts + "min-h-0 flex-1 flex-col overflow-hidden " + (isWide ? "" : "border-t border-line")}>
              {isWide && filterBar}

              {/* The active-filter bar is gone.
                  It existed because filters were invisible once set — chosen
                  in a sheet, then only summarised here. They are not: severity
                  and product type are chips in the row above, showing their own
                  state; the search text sits in its own box; and the Filters
                  badge counts what is left, meaning exactly the things still
                  hidden inside the sheet. A whole band restating four visible
                  controls is the redundancy this pass keeps finding. Clearing
                  is where setting is — tap the chip again, or Clear inside the
                  sheet that holds the rest. */}

              {/* Product type, on the surface instead of two taps inside a
                  sheet.
                  Categories are the filter people actually reach for — "show
                  me the food ones" — and they were the one facet you had to
                  go looking for. A scrolling row of icons says what is in
                  this list before you read a single card, and the counts
                  come from the same facet maths the sheet uses, so the two
                  can never disagree.
                  It was phone-only, on the argument that the sheet can show
                  every facet at once on a wide screen. That argument is about
                  the sheet: this row's job is to say what is in the list
                  before you read a card, and a control you have to open a
                  sheet to find cannot do that at any width. Both drive the
                  same state, so they cannot disagree — and it sits directly
                  under the search box, which is where the rest of the
                  narrowing happens. */}
              {categoryOptions.length > 1 && (
                <div className="catrow" role="group" aria-label="Quick filters">
                  {/* Tinted, not filled — see `.catchip-soft`. "All" is where
                      you are when you have not filtered, so it must not look
                      like something you pressed; the full fill is reserved for
                      a facet you actually chose, and there is only ever one of
                      those in the row. */}
                  <button
                    type="button"
                    onClick={() => { setCategoryKeys([]); setLimit(25); }}
                    aria-pressed={categoryKeys.length === 0}
                    className={"catchip " + (categoryKeys.length === 0 ? "catchip-soft" : "")}
                  >
                    <span className="catchip-icon"><Rows2 className="size-4" /></span>
                    <span>All</span>
                    {/* Every other chip in this row carries a count, so the
                        one that means "no filter" has to as well — a blank
                        where a number belongs reads as a missing number
                        rather than as "all of them". Each recall has exactly
                        one type, so the sum of the parts is the whole. */}
                    <span className="catchip-count tnum">
                      {categoryOptions.reduce((a, c) => a + c.count, 0)}
                    </span>
                  </button>
                  {/* Severity sits after All, and is built as a `catchip` like
                      everything else in the row — same height, same icon disc,
                      same count on the right. It was a different shape from
                      its neighbours, which made a row of equals look like a
                      control and then a list. Only the colour differs, because
                      it is the one filter about danger rather than about kind. */}
                  {(highCount > 0 || highOnly) && (
                    <button
                      id="stat-high"
                      type="button"
                      aria-pressed={highOnly}
                      onClick={() => { setHighOnly(!highOnly); setLimit(25); }}
                      className={"catchip catchip-risk " + (highOnly ? "catchip-risk-on" : "")}
                    >
                      <span className="catchip-icon"><AlertCircle className="size-4" /></span>
                      <span>high-risk</span>
                      <span className="catchip-count tnum">{highCount}</span>
                    </button>
                  )}
                  {categoryOptions.map((c) => {
                    const CatIcon = CATEGORY_ICONS[c.value] || Package;
                    const on = categoryKeys.includes(c.value);
                    return (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => {
                          setCategoryKeys(on ? categoryKeys.filter((k) => k !== c.value) : [...categoryKeys, c.value]);
                          setLimit(25);
                        }}
                        aria-pressed={on}
                        disabled={!on && !c.count}
                        className={"catchip " + (on ? "catchip-on" : "")}
                      >
                        <span className="catchip-icon"><CatIcon className="size-4" /></span>
                        <span>{c.label}</span>
                        <span className="catchip-count tnum">{c.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div id="recalls-list-scroll" ref={productsScrollRef}
                   className="tabbar-space sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {!listBusy && <SourceNotice sources={listSources} />}
                {!listBusy && listFrom === "index" && listRecalls.length > 0 && (
                  <p className="mb-2 text-[12px] leading-snug text-subtle">
                    {national.status === "failed"
                      ? "The live national list didn't load, so this is our recall index."
                      : "Showing our recall index while the live national list loads."}
                  </p>
                )}
                {listFdaGap && !usMode && <FdaGapNote className="mb-2" />}
                {listBusy && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <RecallSkeleton key={i} delay={i * stagger * 2} />)}</ul>
                )}
                {!listBusy && listRecalls.length === 0 && (
                  /* Grey words, never "all clear": this is a statement about the
                     notices we read, dated by the line under it. */
                  <EmptyState icon={SearchX} title="No active recalls listed">
                    {listFrom === "area"
                      ? `No active recall notice we read covers ${loc?.stateAbbr || "this area"} in the past year — that we know of.`
                      : "No active recall in the notices we read right now — that we know of."}
                  </EmptyState>
                )}
                {!listBusy && listRecalls.length > 0 && sorted.length === 0 && (
                  <EmptyState icon={selectedStore && !activeFilters.length ? ShieldCheck : SearchX}
                              title={selectedStore && !activeFilters.length ? "Nothing names this store" : "No matches"}>
                    {selectedStore && !activeFilters.length
                      ? `No active recall names ${selectedStore.name}. Most notices list only a state or "nationwide" and never name a retailer, so this is normal — switch to "All in ${loc?.stateAbbr || "your area"}" above to see all ${recalls.length} recalls that could reach this shelf.`
                      : "Nothing matches the current filters. Remove one of the chips above, or clear them all."}
                  </EmptyState>
                )}

                <ul id="products-list" className="flex flex-col gap-2">
                  {sorted.slice(0, limit).map((r, i) => {
                    const cat = categoryFor(r);
                    const why = reasonFor(r);
                    const CatIcon = CATEGORY_ICONS[cat.key] || Package;
                    /* Store chips only for a recall that reaches this state:
                       in All US a Texas-only notice naming Target must not
                       point at the Target down the road. */
                    const reachesHere = !usMode || (loc && isInArea(r, loc));
                    const nearby = reachesHere ? nearbyStoresFor(r) : [];
                    const linked = new Set(nearby.flatMap((si) => stores[si].chainIds));
                    const unlinked = (r.retailerIds || []).filter((id) => !linked.has(id));
                    return (
                      <li key={r.id} style={{ animationDelay: `${Math.min(i, 8) * stagger}ms` }}
                          className="recall-item fade-item elev-1 rounded-xl border border-line bg-panel-2 p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {isAnnounced(r) ? <AnnouncedBadge /> : <SeverityBadge recall={r} />}
                          {/* USDA closes a notice when the recalling firm has
                              finished recovering the product. Closed notices
                              are listed — recalled food outlives the paperwork
                              by months in a freezer — but never silently: a
                              closed recall shown as a live one is worse than
                              not showing it. Only an explicit false earns the
                              chip; a feed that did not say stays unlabelled. */}
                          {r.active === false && <ClosedBadge />}
                          {/* The hazard, on the card and not only in the filter
                              menu — it is the thing that decides whether this
                              notice is about you. */}
                          <Badge variant="neutral">{why.label}</Badge>
                          <span className="tnum ml-auto text-[11px] text-fog"
                            title={r.posted && r.date ? `Recall started ${fmtDate(r.date)}` : undefined}>
                            {r.posted ? `Posted ${fmtDate(new Date(`${r.posted}T12:00:00Z`))}` : fmtDate(r.date)}
                          </span>
                        </div>
                        <div className="mt-2 flex items-start gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-mint-line bg-mint-soft"
                                title={cat.label} aria-label={cat.label}>
                            <CatIcon className="size-4 text-mint" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="recall-product text-sm font-semibold [overflow-wrap:anywhere]">{truncate(r.product, 150)}</p>
                          </div>
                          <RecallImage recall={r} />
                        </div>
                        {r.reason && <p className="recall-reason mt-2 text-[13px] leading-relaxed text-paper [overflow-wrap:anywhere]">{truncate(r.reason, 160)}</p>}
                        {/* Where it went, on every card in All US — the
                            list is the country, so the line is the point.
                            With a place, a neutral tag says whether it
                            includes it: grey either way, never green/red. */}
                        {usMode && !selectedStore && (
                          <p className="coverage-line mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fog">
                            <span>{coverageLine(r)}</span>
                            {ownAbbr && (
                              <span className="rounded-md border border-line bg-panel-3 px-1.5 py-px text-[11px] font-semibold text-fog">
                                {isInArea(r, loc) ? `Includes ${ownAbbr}` : `Not listed for ${ownAbbr}`}
                              </span>
                            )}
                          </p>
                        )}

                        {(nearby.length > 0 || unlinked.length > 0) && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {nearby.map((si) => (
                              <button key={si} type="button" onClick={() => selectStore(si)}
                                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-mint-line bg-mint-soft px-2.5 py-0.5 text-[11px] font-semibold text-mint hover:border-mint">
                                <MapPin className="size-3" /> {truncate(stores[si].name, 18)} · {stores[si].distanceMiles.toFixed(1)} mi
                              </button>
                            ))}
                            {unlinked.map((id) => byId(id)).filter(Boolean).map((c) => (
                              <Badge key={c.id} variant="chain">Sold at {c.label}</Badge>
                            ))}
                          </div>
                        )}
                        {selectedStore && storeScope === "area" && !(r.retailerIds || []).length && (
                          <p className="mt-2 tnum text-[11px] text-subtle">
                            Names no retailer — could be stocked anywhere in {regionLabel(r)}
                          </p>
                        )}

                        <div className="mt-2.5 flex items-center gap-3">
                          <a className="inline-flex min-h-8 items-center gap-1 text-[13px] font-semibold text-mint underline-offset-2 hover:underline"
                             href={r.url} target="_blank" rel="noopener noreferrer">
                            Official Notice <ExternalLink className="size-3" />
                          </a>
                          <details className="recall-details min-w-0 flex-1">
                            <summary className="inline-flex min-h-8 items-center tnum text-[11px] text-fog hover:text-mint">Details</summary>
                            <dl className="mt-1.5 flex flex-col gap-1 text-[11px] text-fog">
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">Source</dt>
                                <dd>{r.source}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">Type</dt>
                                <dd>{cat.label}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">Region</dt>
                                <dd>
                                  <Tooltip content={r.distribution || undefined}>
                                    <span>{regionLabel(r)}</span>
                                  </Tooltip>
                                </dd>
                              </div>
                              {r.firm && (
                                <div className="flex gap-2">
                                  <dt className="microlabel shrink-0">Firm</dt>
                                  <dd className="[overflow-wrap:anywhere]">{r.firm}</dd>
                                </div>
                              )}
                              {r.codeInfo && (
                                <div className="flex gap-2">
                                  <dt className="microlabel shrink-0">Lots</dt>
                                  <dd className="[overflow-wrap:anywhere]">{truncate(r.codeInfo, 400)}</dd>
                                </div>
                              )}
                            </dl>
                          </details>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {remaining > 0 && (
                  <Button id="btn-more-recalls" variant="outline" size="sm" className="mx-auto mt-3 flex h-10" onClick={() => setLimit(limit + 25)}>
                    <Plus /> Show {Math.min(remaining, 25)} More · {fmtCount(remaining)} Left
                  </Button>
                )}
                {/* How fresh the list is, and how far back a cut list goes. */}
                {!listBusy && listFreshness.length > 0 && (
                  <div className="mt-3 space-y-0.5 px-1 pb-1 text-center">
                    <FreshnessLine entries={listFreshness} />
                    {listSources.some((x) => x.truncated) && (
                      <p className="text-[11px] text-subtle">
                        FDA: the newest notices only
                        {(() => {
                          const o = listSources.filter((x) => x.truncated && x.oldest).map((x) => x.oldest).sort().pop();
                          return o ? `, back to ${new Date(`${o}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "";
                        })()}.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
            </div>
          </aside>
        )}
      </main>
      )}

      {/* ================= footer ================= */}
      <footer
        className="safe-b z-20 hidden shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 pt-1.5 lg:flex"
        style={{ "--safe-b-pad": "0.375rem" }}
      >
        <p className="min-w-0 flex-1 truncate text-[11px] text-fog">
          <span className="font-semibold text-paper">Beta — no warranty.</span> Informational only, provided
          &ldquo;as is&rdquo;; verify every notice with the official source before acting on it.
        </p>
        <div className="flex items-center gap-2">
          {listSources.map((s) => (
            <Tooltip key={s.name} content={s.ok ? `${s.name} — ${s.count} ${listFrom === "us" ? "in the US list" : "matching your area"}` : `${s.name} — unavailable (${s.error || "error"})`}>
              <span tabIndex={0} aria-label={s.ok ? `${s.name}: ${s.count} matching` : `${s.name}: unavailable`}
                    className={"size-1.5 rounded-full " + (s.ok ? "bg-mint" : "bg-amber")} />
            </Tooltip>
          ))}
          <button onClick={() => setAboutOpen(true)}
                  className="inline-flex min-h-8 items-center gap-1 tnum text-[11px] uppercase tracking-wider text-fog hover:text-mint">
            <Info className="size-3" /> About
          </button>
        </div>
      </footer>

      {/* ================= bottom navigation (phone) =================
          Three destinations, in the half of the screen a thumb reaches.
          This replaces a tab strip that sat two-thirds of the way up the
          panel, under five other bands — and it absorbs the footer, whose
          only unique content was a disclaimer already written out in full
          inside About. Two rows of chrome removed, one added, and everything
          you press most is now where your hand already is. */}
      {/* Four now: Home leads, and what was "Near me" is "Stores", named for
          what it holds now that it is no longer where the app starts. Shown
          without a location too — Home works without one, and the other two
          answer with the location prompt they always had. */}
      <nav
          aria-label="Main"
          /* Floating, not welded on.
           *
           * It was a flush white strip with a hairline on top, in the flow
           * below a white scrolling list — so it shared an edge and a fill
           * with the thing it sits over, and disappeared. It was missed
           * entirely, which for the app's primary navigation is the whole
           * ballgame.
           *
           * Now it detaches: inset from all three edges, fully rounded,
           * lifted on the app's deepest shadow, over a blurred translucent
           * ground so the list visibly passes underneath. Depth is doing the
           * separating rather than a 1px line — which is the same argument
           * ui/button.jsx already makes about bevels, applied to a surface.
           * The blur is a saturated backdrop over a 78%-opaque panel, not a
           * clear pane: legibility first, glass second. */
          className="tabbar lg:hidden"
        >
          {[
            { id: "home", label: "Home", icon: House },
            { id: "near", label: "Stores", icon: Store, count: loc && storesWanted ? stores.length : null },
            /* A clipboard, not the sliders glyph. `ListFilter` is what half
               the platforms on a phone draw for "filter" — so the app's second
               destination wore the icon of a control, two rows above an actual
               Filters button wearing very nearly the same one. */
            { id: "recalls", label: "Recalls", icon: ClipboardList, count: loc || usMode ? filtered.length : null },
            { id: "scan", label: "Scan", icon: ScanLine },
          ].map(({ id, label, icon: Icon, count }) => {
            const on = id !== "scan" && tab === id;
            const busyCount = id === "recalls" ? listBusy : scanning;
            const shown = count != null && !busyCount ? fmtCount(count) : null;
            const spoken = id === "recalls" && shown != null
              ? `Recalls, ${shown} ${usMode && !selectedStore ? "across the US" : `in ${loc?.stateAbbr || "your area"}`}`
              : id === "near" && shown != null ? `Stores, ${shown}` : undefined;
            return (
              <button
                key={id}
                type="button"
                aria-current={on ? "page" : undefined}
                aria-label={spoken}
                onClick={() => {
                  if (id === "scan") { setScanOpen(true); return; }
                  setTab(id);
                  if (id !== "home" && view === "map") setView("split"); // don't land on a hidden list
                }}
                className={"tabbar-item " + (on ? "tabbar-item-on" : "")}
              >
                <span className="relative">
                  <Icon className="size-5" strokeWidth={on ? 2.4 : 2} />
                  {/* The dot says the recall list is scoped to a store — the
                      one thing you cannot see from the other screen. */}
                  {id === "recalls" && selectedStore && (
                    <span className="absolute -right-1.5 -top-0.5 size-1.5 rounded-full bg-mint" />
                  )}
                </span>
                <span className="text-[10px] font-semibold tracking-wide">
                  {label}{shown != null ? ` ${shown}` : ""}
                </span>
              </button>
            );
          })}
        </nav>

      {/* ---- location: the one picker, every size ---- */}
      <LocationPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        loc={loc}
        recents={recents.filter((r) => !loc || locLabel(r) !== locLabel(loc)).slice(0, 3)}
        reason={pickerReason}
        onSubmitText={locateText}
        onUseCurrent={locateDevice}
        onPickRecent={pickRecent}
        onForget={forgetLocation}
      />

      {/* ---- one recall, opened from the digest ----
          The digest's headline, a follow match and a story's "Open the full
          notice" all land here: the same card search answers with, open, in
          a sheet over wherever the reader was — so the answer never costs
          them their place in the digest. */}
      <Sheet open={Boolean(sheetRecall)} onClose={() => setSheetRecall(null)} title="Recall">
        {sheetRecall && (
          <div className="px-4 py-4">
            <VerdictCard
              recall={sheetRecall}
              loc={verdictLoc}
              expanded
              freshness={searchFreshness}
              onRequestLocation={() => openLocationPicker("to check your state", "search_card")}
            />
          </div>
        )}
      </Sheet>

      {/* ---- alerts ----
          Every outcome of asking is said here in words, including the ones
          that are not failures of ours: an iPhone that needs the Home Screen
          step first, a browser that cannot do it, a permission that was
          refused. And the privacy line is said before the button, not after
          it: what leaves this browser is the state and the follow terms. */}
      <Sheet open={alertsOpen} onClose={() => setAlertsOpen(false)} title="Recall alerts">
        <div className="flex flex-col gap-3 px-4 py-4 text-[13px] leading-relaxed text-fog">
          <p>
            <span className="font-semibold text-paper">Once a week</span>, the new recalls for{" "}
            {loc?.stateAbbr || "your state"}. <span className="font-semibold text-paper">Straight away</span>, a
            serious (Class I) recall there, or one matching a product you follow.
          </p>
          {usMode && loc?.stateAbbr && (
            <p className="text-[12px] text-subtle">
              Alerts are for your state ({loc.stateAbbr}), whichever view you're browsing.
            </p>
          )}
          <p className="text-[12px] text-subtle">
            Only your state and the products you follow are sent to our server — never your address or
            coordinates. Turning alerts off deletes them.
          </p>
          {push.state === "needs-install" ? (
            <div className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              <p className="font-semibold text-paper">On iPhone and iPad, one step first</p>
              <p className="mt-1">
                Apple only delivers alerts to sites added to the Home Screen. Tap{" "}
                <span className="font-semibold text-paper">Share</span>, then{" "}
                <span className="font-semibold text-paper">Add to Home Screen</span>, open Yanked from
                there, and turn alerts on.
              </p>
            </div>
          ) : !loc?.stateAbbr ? (
            <Button className="h-11 w-full" onClick={() => { setAlertsOpen(false); openLocationPicker("for alerts", "alerts"); }}>
              <MapPin /> Set a location first
            </Button>
          ) : push.state === "subscribed" ? (
            <>
              <p className="flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-3.5 py-3 font-semibold text-paper">
                <Check className="size-4 shrink-0 text-mint" /> Alerts are on for {loc.stateAbbr}.
              </p>
              <Button variant="outline" className="h-11 w-full" disabled={push.busy} onClick={disablePush}>
                {push.busy ? <Loader2 className="animate-spin" /> : <BellOff />} Turn off alerts
              </Button>
            </>
          ) : push.state === "unsupported" ? (
            <p className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              This browser can't receive notifications from websites.
            </p>
          ) : push.state === "denied" ? (
            <p className="rounded-xl border border-line bg-panel-2 px-3.5 py-3">
              Notifications are blocked for this site. You can allow them in your browser's site settings,
              then come back here.
            </p>
          ) : (
            <Button className="h-11 w-full" disabled={push.busy || push.state === "unknown"} onClick={enablePush}>
              {push.busy ? <Loader2 className="animate-spin" /> : <Bell />} Turn on alerts
            </Button>
          )}
          {push.msg && <p role="alert" className="text-[12px] font-semibold text-alert">{push.msg}</p>}
          {push.dropped.length > 0 && (
            <p className="text-[12px] text-subtle">
              Alerts can watch up to 20 products of 40 characters each, so these aren't included:{" "}
              {push.dropped.map((t) => `“${t}”`).join(", ")}.
            </p>
          )}
        </div>
      </Sheet>

      {/* ---- theme, sources, about ---- */}
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Yanked">
        <div className="flex flex-col divide-y divide-line">
          <div className="px-4 py-3">
            <p className="microlabel">Appearance</p>
            <div className="mt-2 flex gap-1.5" role="group" aria-label="Theme">
              {[["light", "Light", Sun], ["dark", "Dark", Moon], ["system", "System", MonitorSmartphone]].map(([k, lbl, Icon]) => (
                <button key={k} type="button" aria-pressed={theme === k} onClick={() => setTheme(k)}
                        className={"chip flex-1 " + (theme === k ? "chip-on" : "chip-off")}>
                  <Icon className="size-3.5" />
                  <span className="normal-case tracking-normal">{lbl}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 py-3">
            <p className="microlabel">Data sources</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {listSources.map((src) => (
                <li key={src.name} className="flex items-center gap-2 text-[13px]">
                  <span className={"size-1.5 shrink-0 rounded-full " + (src.ok ? "bg-mint" : "bg-amber")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{src.name}</span>
                  <span className="tnum shrink-0 text-[11px] text-fog">
                    {src.ok ? `${fmtCount(src.count)} ${listFrom === "us" ? "in the US" : "matching"}` : "unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="px-4 py-3">
            {pushOffered && (
              <Button variant="secondary" className="mb-2 h-11 w-full"
                      onClick={() => { setMoreOpen(false); openAlerts(); }}>
                <Bell /> Recall alerts
              </Button>
            )}
            <Button variant="secondary" className="h-11 w-full"
                    onClick={() => { setMoreOpen(false); setAboutOpen(true); }}>
              <Info /> About this data
            </Button>
            <p className="mt-3 text-[12px] leading-relaxed text-subtle">
              <span className="font-semibold text-paper">Beta — no warranty.</span> Informational only,
              provided &ldquo;as is&rdquo;; verify every notice with the official source before acting on it.
            </p>
          </div>
        </div>
      </Sheet>

      <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} recalls={usMode ? listRecalls : recalls} />

      {/* DialKit authoring panel — renders null in production builds. */}
      {/* Authoring tool, so: on in dev and on preview deploys, off in
          production. Its default is dev-only, which meant the one place the
          motion is worth tuning — a real phone, on a real network, holding a
          preview build — was the one place the panel would not appear. */}
      {/* Never in production; in dev, or on a preview with ?dialkit=1.
          Bottom-right, lifted above the footer (index.css), and wide screens
          only unless asked for: bottom-left it covered the phone's Home tab
          (and swallowed taps on it), the location row in the sheet, the
          footer and the map's radius control; top-right, the header's
          theme and More buttons. */}
      {DIALKIT_ON && (isWide || DIALKIT_ASKED) && (
        <DialRoot position="bottom-right" theme="dark" defaultOpen={false} productionEnabled />
      )}

      {/* ================= about =================
          A sheet on a phone and a centred dialog above sm, both arriving the
          same way the rest of them do now — up from the bottom edge where
          there is one, growing in place where there isn't. It used to be
          `fade-item`, an entrance with no matching exit, so the longest
          surface in the app vanished mid-scroll. */}
      {aboutMounted && (
        <div className={"fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4 " +
               (aboutShown ? "" : "pointer-events-none")}
             role="dialog" aria-modal="true" aria-label="About this data">
          {/* The ground is its own element rather than the box that lays the
              dialog out, so the two can move independently: the dim fades
              while the surface travels. It is `absolute`, so it is out of the
              flow and the panel is still the only flex item. */}
          <div className={"sheet-scrim absolute inset-0 bg-ink/70 " + (aboutShown ? "is-shown" : "")}
               onClick={() => setAboutOpen(false)} />
          <div className={"sheet-panel sheet-centered relative max-h-[85dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-line bg-panel p-5 text-sm text-fog sm:rounded-2xl sm:border-b " +
                 (aboutShown ? "is-shown" : "")}
               style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))" }}>
            <div className="flex items-center justify-between">
              <p className="microlabel text-paper">About this data</p>
              <button onClick={() => setAboutOpen(false)} aria-label="Close" className="grid size-8 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper"><X className="size-4" /></button>
            </div>
            <p className="mt-3">
              Yanked aggregates public recall data from{" "}
              <a className="text-mint hover:underline" href="https://open.fda.gov/apis/food/enforcement/" target="_blank" rel="noopener noreferrer">openFDA enforcement reports</a>{" "}
              (food, drugs, medical devices), the{" "}
              <a className="text-mint hover:underline" href="https://www.fsis.usda.gov/science-data/developer-resources/recall-api" target="_blank" rel="noopener noreferrer">USDA FSIS recall API</a>{" "}
              (meat, poultry, egg products) and the{" "}
              <a className="text-mint hover:underline" href="https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information" target="_blank" rel="noopener noreferrer">CPSC recall API</a>{" "}
              (consumer products). Store locations come from{" "}
              <a className="text-mint hover:underline" href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">Mapbox Search</a>;
              the map is © <a className="text-mint hover:underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors and CARTO.
            </p>
            <p className="mt-3">
              <span className="text-paper">This is an informational tool, not an official source.</span>{" "}
              Recall notices name the chains that received recalled lots, but no public feed tracks store-level
              inventory — a listed store may never have stocked the recalled lot. Always verify against the linked
              official notice; when in doubt, don't consume or use the product.
            </p>
            <p className="mt-3">
              <span className="text-paper">Chains vs. independents.</span>{" "}
              A notice can only be tied to a storefront when it names the chain, so independent groceries — marked{" "}
              <span className="tnum text-[11px] uppercase tracking-wider">Local</span> — never show a match.
              That is a limit of the data, not a clean bill of health: pick a store and switch to
              &ldquo;All in your state&rdquo; to see every notice covering your state, which is what an
              independent is actually exposed to.
            </p>
            <p className="mt-3">
              <span className="text-paper">Why the region matters.</span>{" "}
              Recalls are usually regional — one supplier ships one lot to one of a chain's distribution centers, so
              the notice covers the states that DC serves. Each recall shows its states; a chain named in a recall
              that never reached your state is a different risk from one that did.
            </p>
            <p className="mt-3">
              <span className="text-paper">What the classes mean.</span>{" "}
              FDA and USDA rank recalls on the same three-step scale, and the words are not
              self-explanatory. <span className="text-paper">Class I</span> is the most serious: the agency
              believes the product could cause serious harm or death. <span className="text-paper">Class II</span>{" "}
              means a temporary or reversible health problem is possible. <span className="text-paper">Class III</span>{" "}
              is unlikely to make anyone ill — usually a labelling or manufacturing violation. CPSC does not
              rank consumer product recalls at all, so those cards read &ldquo;not classified&rdquo; rather than
              guessing at a severity nobody assigned. Every badge on a card explains itself on tap.
            </p>
            <p className="mt-3">
              <span className="text-paper">When a source is down.</span>{" "}
              USDA sits behind a bot filter that refuses our servers much of the time, and CPSC&rsquo;s feed is
              often slower than a page load will wait for. Every successful fetch is saved, so an outage
              usually degrades to a copy a few hours old rather than a missing agency — the recall list says
              which, at the top. When neither is possible the source is marked unavailable, and the recalls it
              alone carries are genuinely not in the list.
            </p>
            <p className="mt-3">
              <span className="text-paper">Reasons are inferred.</span>{" "}
              The &ldquo;reason for recall&rdquo; label on each card — and the filter built on it — is read out of the
              notice's own free text, because no feed publishes a hazard code we can compare across all three
              agencies. It is a reading aid, not a classification: the notice itself is the authority.
            </p>
            <p className="mt-3">
              <span className="text-paper">Where your location goes.</span>{" "}
              It is used to query the sources above, and remembered in this browser (not on our server) so
              the app opens on it next time — &ldquo;Forget this location&rdquo; in the location picker clears
              it. Forget this location also clears recent places. If you turn on alerts, only your state and
              the products you follow are stored with them.
            </p>
            <p className="mt-3">
              <span className="text-paper">&ldquo;Not reported in your state&rdquo; is not &ldquo;doesn&rsquo;t affect you&rdquo;.</span>{" "}
              A search answer says what the notice says: where it was sent, quoted. Distribution lists can be
              incomplete — distributors re-ship, and people travel — so an answer that your state isn&rsquo;t
              listed is grey, never green, and the evidence is always one tap away.
            </p>
            <div className="mt-4 rounded-xl border border-amber/40 bg-amber-soft p-3.5">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-amber">
                Beta — no warranty, no liability
              </p>
              <p className="mt-1.5 text-xs leading-relaxed">
                Yanked is an early release provided <span className="text-paper">&ldquo;as is&rdquo;, without
                warranty of any kind</span>, express or implied, including fitness for a particular purpose. It is
                not affiliated with the FDA, USDA, CPSC, or any retailer named here, and it is not medical, legal,
                or safety advice.
              </p>
              <p className="mt-2 text-xs leading-relaxed">
                Matching is automated and imperfect: notices are tied to stores by chain name, coverage is inferred
                from free-text distribution fields, and feeds can be stale or unavailable. A store may be listed
                that never stocked the lot, and a recall affecting you may be missing entirely.
                <span className="text-paper"> The authors accept no liability for any loss, injury, or damages
                arising from use of this tool.</span> Always confirm against the linked official notice.
              </p>
            </div>
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {sources.map((s) => (
                <li key={s.name} className="flex flex-wrap items-center gap-x-2 py-1.5 text-xs">
                  <span className={"size-1.5 shrink-0 rounded-full " + (s.ok ? "bg-mint" : "bg-amber")} aria-hidden="true" />
                  <span>{s.name}</span>
                  <span className="ml-auto tnum text-[11px]">
                    {s.ok ? `${s.count} matching` : `unavailable (${s.error || "error"})`}
                  </span>
                  {s.note && <p className="w-full pl-3.5 text-[11px] text-amber">{s.note}</p>}
                </li>
              ))}
            </ul>

            {/* USDA and CPSC both refuse us intermittently; this says which one
                is refusing today, and whether a saved copy is covering for it,
                without leaving the app. It used to test USDA alone, which left
                "CPSC is missing too" with nowhere to be answered. */}
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button id="btn-check-sources" variant="outline" size="sm"
                        disabled={diag?.busy}
                        onClick={runSourceCheck}>
                  {diag?.busy ? <Loader2 className="animate-spin" /> : <Stethoscope />} Check The Feeds
                </Button>
                <span className="text-[11px]">asks USDA, CPSC and openFDA directly, right now</span>
              </div>
              {diag && !diag.busy && (
                <div id="diag-result" className="mt-2">
                  <p className={"text-xs leading-relaxed " + (diag.error ? "text-alert" : "text-paper")}>
                    {diag.error || diag.verdict}
                  </p>
                  {/* The header experiment's own conclusion. It is the answer to
                      "why is USDA down", and it is not something anyone should
                      have to derive from four status codes. */}
                  {diag.fsisVerdict && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-fog">{diag.fsisVerdict}</p>
                  )}
                  {diag.rows && (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {diag.rows.map((row, i) => (
                        <li key={i} className="flex flex-wrap items-center gap-x-2 tnum text-[10px] text-fog">
                          <span className={"size-1.5 shrink-0 rounded-full " + (row.ok ? "bg-mint" : "bg-amber")} aria-hidden="true" />
                          <span className="truncate text-paper">{String(row.url).replace("https://", "")}</span>
                          <span>{row.headers}</span>
                          <span className="ml-auto">{row.status ?? row.error}</span>
                          {row.cached && <span className="w-full pl-3.5 text-[10px]">cache: {row.cached}</span>}
                          {row.snapshot && <span className="w-full pl-3.5 text-[10px]">snapshot: {row.snapshot}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
