import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Armchair, Baby, Beef, Bike, Candy, Carrot, Check, ChevronDown, ChevronRight, ChevronUp,
  Crosshair, CupSoda,
  ExternalLink, Fish, Info, Loader2, MapPin, MapPinOff, Milk, Package, PanelRightClose,
  PanelRightOpen, PawPrint, Pill, Plug, Plus, Radar, Rows2, Columns2, Search, SearchX,
  ScanLine, ShieldCheck, Soup, Stethoscope, Sun, Moon, MonitorSmartphone, MoreHorizontal, Store,
  ListFilter, UtensilsCrossed, Wheat, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip, InfoTip } from "@/components/ui/tooltip";
import { FilterButton, FilterSheet, FilterGroup, FilterChoice } from "@/components/FilterSheet";
import MapView from "@/components/MapView";
import ScanSheet from "@/components/ScanSheet";
import { Sheet } from "@/components/ui/sheet";
import { recallUpcs, lookupProduct } from "@/lib/upc";
import { browserPosition, reverseGeocode, geocodeInput } from "@/lib/geo";
import { fetchAll, recoverBlockedSources, sortRecalls } from "@/lib/sources";
import { findStores } from "@/lib/stores";
import { byId, DEFAULT_NEARBY_CHAINS } from "@/lib/retailers";
import { categoryFor } from "@/lib/category";
import { classInfo, severityLabel, severityVariant } from "@/lib/classification";
import { reasonFor, REASON_ORDER } from "@/lib/reason";
import { DialRoot } from "dialkit";
import "dialkit/styles.css";
import { useMotionTuning, cardStagger } from "@/lib/tuning";
import { useTheme } from "@/lib/theme";

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
 *   Recalls  [ At a store near you · 12 ]  [ Anywhere in CA · 137 ]
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
    label: "Anywhere in your area",
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
  const st = r.states || [];
  /* "Unstated" is its own answer and must never be flattened into
   * "Nationwide". The notice named a retailer and no geography; saying
   * nationwide would be inventing a claim the FDA did not make. */
  if (r.scope === "unstated") return "Region not stated";
  if (r.scope === "nationwide" || !st.length) return "Nationwide";
  if (st.length <= 3) return st.join(" · ");
  return `${st.slice(0, 3).join(" · ")} +${st.length - 3}`;
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

/* A source that is down, or serving a saved copy, said in the list it is
 * missing from.
 *
 * "USDA data still never shows" was true and the app was close to silent
 * about it: one amber dot in a desktop footer, one line inside About, and
 * nothing at all in the list where the gap actually lives. A missing agency is
 * not a status indicator, it is a hole in the answer, and it belongs in the
 * answer. */
function SourceNotice({ sources }) {
  const down = sources.filter((s) => !s.ok);
  const stale = sources.filter((s) => s.ok && s.note);
  if (!down.length && !stale.length) return null;
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
      {stale.map((s) => (
        <p key={s.name} className="flex items-start gap-2 text-[12px] leading-relaxed">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span><span className="font-semibold text-paper">{shortSourceName(s.name)}:</span> {s.note}</span>
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

function EmptyState({ icon: Icon, title, children, compact }) {
  return (
    <div className={"fade-item flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line bg-panel-2/40 px-5 text-center " + (compact ? "py-6" : "py-9")}>
      <span className="flex size-9 items-center justify-center rounded-full border border-mint-line bg-mint-soft">
        <Icon className="size-4 text-mint" />
      </span>
      <p className="mt-0.5 text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-fog">{children}</p>
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
function PanelHeader({ label, countId, count, children }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel px-4 py-2">
      <span className="flex items-center gap-2 max-lg:hidden">
        <span className="microlabel">{label}</span>
        <span id={countId} className="tnum text-xs font-semibold text-mint">{count}</span>
      </span>
      <div className="flex items-center gap-1.5 max-lg:mr-auto lg:ml-auto">{children}</div>
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
  if (except !== "source" && !f.sources.has(r.source)) return false;
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
  const [locStatus, setLocStatus] = useState(null); // {msg, error, busy}
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState("");
  const [radius, setRadius] = useState(16093);

  const [recalls, setRecalls] = useState([]);
  const [sources, setSources] = useState([]);
  const [productsBusy, setProductsBusy] = useState(false);

  const [stores, setStores] = useState([]);
  const [storesStatus, setStoresStatus] = useState(null);
  const [activeStore, setActiveStore] = useState(-1); // drives map focus AND product filtering
  const [scope, setScope] = useState(() => normalizeScope(loadPref("rr-mode", "area")));
  // Wide screens only: fold the store list down to its header. This is the
  // capability the old "All recalls" mode provided, moved out of the scope
  // control and onto the thing it actually acts on.
  const [storesCollapsed, setStoresCollapsed] = useState(() => loadPref("rr-stores-collapsed", false));
  const [view, setView] = useState("split"); // phone only: map | split | list
  const [tab, setTab] = useState("near"); // phone destinations: near | recalls
  const [locOpen, setLocOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [sideBySide, setSideBySide] = useState(() => loadPref("rr-side-by-side", false));
  const [splitPct, setSplitPct] = useState(() => loadPref("rr-split", DEFAULT_SPLIT));
  const [mapPct, setMapPct] = useState(() => loadPref("rr-map-pct", DEFAULT_MAP_PCT));
  const [mapWidthPct, setMapWidthPct] = useState(() => loadPref("rr-map-width", DEFAULT_MAP_WIDTH));
  const [locEditing, setLocEditing] = useState(false);
  const [isWide, setIsWide] = useState(false); // lg+ : two lists at once, no bottom nav

  const [filterText, setFilterText] = useState("");
  const [categoryKeys, setCategoryKeys] = useState([]); // empty = every type
  const [reasonKeys, setReasonKeys] = useState([]);     // empty = every reason
  const [sortBy, setSortBy] = useState("newest"); // newest | risk
  const [storeScope, setStoreScope] = useState("named"); // named | area
  const [diag, setDiag] = useState(null);
  const [activeSources, setActiveSources] = useState(new Set());
  const [limit, setLimit] = useState(25);

  // Live-tunable motion (DialKit panel in dev; shipped defaults in production).
  const { theme, setTheme, resolved: resolvedTheme, cycle: cycleTheme } = useTheme();
  const motionStyle = useMotionTuning();
  const stagger = cardStagger(motionStyle);

  const mapRef = useRef(null);
  const storeItemRefs = useRef([]);
  const splitRef = useRef(null);
  const mainRef = useRef(null);
  const productsScrollRef = useRef(null);
  const locInputRef = useRef(null);

  const { byChain } = useMemo(() => chainsFor(recalls), [recalls]);

  /* The chains the store lookup should search for, plus a stable key for them.
   * Recalls land in two waves — the API payload, then USDA fetched directly by
   * the browser — so this set can grow after the first scan. */
  const searchChains = useMemo(() => chainsToSearch(recalls), [recalls]);
  const chainKey = useMemo(() => searchChains.map((c) => c.id).sort().join(","), [searchChains]);
  const searchChainsRef = useRef(searchChains);
  searchChainsRef.current = searchChains;

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
        const found = await findStores(searchChainsRef.current, locArg, radiusArg);
        if (stale()) return;
        setStores(found);
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
        setStoresStatus({
          msg: `Store lookup failed (${err.message}). The recall list is unaffected.`,
          error: true,
          retry: () => loadStores(locArg, radiusArg),
        });
      }
    }
  }, []);

  const loadRecalls = useCallback(async (locArg) => {
    setProductsBusy(true);
    setRecalls([]);
    setSources([]);
    setLimit(25);
    try {
      const { recalls: fetched, sources: srcs } = await fetchAll(locArg);
      setRecalls(fetched);
      setSources(srcs);
      setActiveSources(new Set(fetched.map((r) => r.source)));

      /* USDA blocks our server but usually not the browser, so retry it here and
       * fold the result in when it lands. Deliberately not awaited: the stores
       * lookup is the slow part of the page and must not wait on a source that
       * may well be blocked here too. */
      // Deliberately not awaited: the store lookup is the slow part of this
      // page and must not wait on sources that may be unreachable from here
      // too. Whatever comes back is folded in and re-sorted.
      recoverBlockedSources(locArg, srcs).then((late) => {
        if (!late) return;
        setRecalls((prev) => sortRecalls([...prev, ...late.recalls]));
        setSources(late.sources);
        // Source chips are seeded from the first payload, so a source that
        // arrives late has to opt itself in or its notices stay filtered out.
        setActiveSources((prev) => {
          const next = new Set(prev);
          for (const r of late.recalls) next.add(r.source);
          return next;
        });
      });
    } finally {
      setProductsBusy(false);
    }
  }, []);

  /* Store loading has exactly one trigger: this effect. The first load, a new
   * location and a radius change all take the same path — previously the first
   * load was an imperative tail-call inside the recall fetch and the radius
   * buttons were their own call, which is why nudging the radius could make
   * stores appear that had never loaded on their own. */
  const lastScanRef = useRef("");
  useEffect(() => {
    if (!loc || productsBusy) return;
    const place = `${loc.lat},${loc.lon}|${radius}`;
    const key = `${place}|${chainKey}`;
    if (key === lastScanRef.current) return;
    // Only the chain list changed (USDA landed late): refresh in place instead
    // of dropping the user's selection and replaying the whole scan overlay.
    const quiet = lastScanRef.current.startsWith(`${place}|`);
    lastScanRef.current = key;
    loadStores(loc, radius, { quiet });
  }, [loc, radius, chainKey, productsBusy, loadStores]);

  const setLocation = useCallback(async (newLoc) => {
    setLoc(newLoc);
    setLocStatus(newLoc.state ? null : { msg: "Couldn't determine your state — showing nationwide recalls only." });
    await loadRecalls(newLoc);
  }, [loadRecalls]);

  async function useGeolocation() {
    setLocStatus({ msg: "Locating you…", busy: true });
    try {
      const pos = await browserPosition();
      setLocStatus({ msg: "Looking up your area…", busy: true });
      let resolved;
      try {
        resolved = await reverseGeocode(pos.lat, pos.lon);
      } catch (_) {
        resolved = { ...pos, label: "Your location", state: null, stateAbbr: null };
      }
      await setLocation(resolved);
    } catch (err) {
      setLocStatus({ msg: `${err.message} — enter a ZIP instead.`, error: true });
    }
  }

  async function onSearch(e) {
    e.preventDefault();
    if (!query.trim()) {
      setQueryError("Enter a ZIP code, or a city and state.");
      locInputRef.current && locInputRef.current.focus();
      return;
    }
    setQueryError("");
    setLocEditing(false);
    setLocStatus({ msg: "Finding that place…", busy: true });
    try {
      await setLocation(await geocodeInput(query));
    } catch (err) {
      setLocStatus({ msg: err.message, error: true });
    }
  }

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
      /* The popup says the store's name, address and distance — which is
       * exactly what the selection bar now says, in a place that does not sit
       * on top of a map only a third of a phone tall. So the map centres on
       * the pin either way, and only opens the bubble where there is room. */
      if (next >= 0 && fly && mapRef.current) mapRef.current.focusStore(next, { popup: isWide });
      setStoreScope(scopeForStore(next));
      return next;
    });
    setLimit(25);
    if (!isWide) setTab("recalls");
    // A re-scoped list read from wherever the last one was left off.
    if (productsScrollRef.current) productsScrollRef.current.scrollTop = 0;
  }, [scopeForStore, isWide]);

  const selectStore = useCallback((i) => applySelection(i, { fly: true }), [applySelection]);

  const onMarkerClick = useCallback((i) => {
    applySelection(i, { fly: false });
    const el = storeItemRefs.current[i];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [applySelection]);

  const clearStore = useCallback(() => {
    setActiveStore(-1);
    setStoreScope("named");
    setLimit(25);
  }, []);

  const listHidden = view === "map";
  const mapHidden = view === "list" && !isWide;

  useEffect(() => {
    mapRef.current && mapRef.current.resize();
  }, [view, stores, tab, sideBySide, splitPct, mapPct]);

  const stepView = useCallback((dir) => {
    setView((v) => VIEWS[Math.min(VIEWS.length - 1, Math.max(0, VIEWS.indexOf(v) + dir))]);
  }, []);

  const setScopePref = useCallback((next) => {
    setScope(next);
    savePref("rr-mode", next);
    setLimit(25);
  }, []);

  const toggleStoresCollapsed = useCallback(() => {
    setStoresCollapsed((prev) => {
      savePref("rr-stores-collapsed", !prev);
      return !prev;
    });
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
  const storesStyle = isWide ? { flexBasis: `${splitPct}%`, flexGrow: 0, flexShrink: 0 } : undefined;
  /* The map only gives up its share when there is a panel to give it to. With
   * no location yet there is no panel, and the old hard-coded 42% left the
   * landing screen's headline and its one button squeezed into the top of the
   * phone with half the viewport blank underneath. */
  const panelShowing = Boolean(loc) && !listHidden;
  const mapStyle = isWide
    ? { flexBasis: `${mapWidthPct}%`, flexGrow: 0, flexShrink: 0 }
    : { flexBasis: panelShowing ? `${mapPct}%` : "100%" };

  const selectedStore = activeStore >= 0 ? stores[activeStore] : null;

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
    sources: activeSources,
    cats: categoryKeys.length ? new Set(categoryKeys) : null,
    whys: reasonKeys.length ? new Set(reasonKeys) : null,
    /* A selected store is the most specific claim available, so it wins.
     * Otherwise the scope decides: "named" narrows to the chains standing near
     * you; "area" does not narrow by store at all. */
    chainScope: selectedStore
      ? (storeScope === "named" ? new Set(selectedStore.chainIds) : null)
      : (scope === "named" ? nearbyChainIds : null),
  }), [filterText, activeSources, categoryKeys, reasonKeys, selectedStore, storeScope, scope, nearbyChainIds]);

  /* The option LIST comes from every recall, so a chip never disappears
   * mid-session; the COUNT on it comes from the current filters, so it never
   * over-promises. A chip that would land on nothing is disabled rather than
   * hidden — a menu that reshuffles as you use it is a menu you have to
   * re-read every time. */
  function facetOptions(keyFn) {
    const m = new Map();
    for (const r of recalls) {
      const c = keyFn(r);
      if (!m.has(c.key)) m.set(c.key, { value: c.key, label: c.label, count: 0 });
    }
    return m;
  }

  const categoryOptions = useMemo(() => {
    const m = facetOptions(categoryFor);
    for (const r of recalls) if (passesFilters(r, filterState, "cat")) m.get(categoryFor(r).key).count += 1;
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalls, filterState]);

  /* Why a thing was recalled, counted the same way its type is. Ordered by
   * hazard family rather than alphabetically or by count — someone scanning
   * for "the pathogens" should find them together, and a list that reorders
   * itself as the counts change is a list you have to re-read every time. */
  const reasonOptions = useMemo(() => {
    const m = facetOptions(reasonFor);
    for (const r of recalls) if (passesFilters(r, filterState, "why")) m.get(reasonFor(r).key).count += 1;
    return [...m.values()].sort((a, b) => REASON_ORDER.indexOf(a.value) - REASON_ORDER.indexOf(b.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalls, filterState]);

  const sourceOptions = useMemo(() => {
    const m = new Map();
    for (const r of recalls) if (!m.has(r.source)) m.set(r.source, { value: r.source, label: r.source, count: 0 });
    for (const r of recalls) if (passesFilters(r, filterState, "source")) m.get(r.source).count += 1;
    return [...m.values()];
  }, [recalls, filterState]);

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
    () => recalls.filter((r) => passesFilters(r, filterState)),
    [recalls, filterState]
  );

  // Severity-first ordering pushed months-old class I notices above this
  // week's, which reads as stale data. Newest is the default; risk is a choice.
  const sorted = useMemo(() => {
    const sev = { high: 0, med: 1, low: 2 };
    const t = (d) => (d ? new Date(d).getTime() : 0);
    return [...filtered].sort((a, b) =>
      sortBy === "risk"
        ? ((sev[a.severity] ?? 1) - (sev[b.severity] ?? 1)) || t(b.date) - t(a.date)
        : t(b.date) - t(a.date) || ((sev[a.severity] ?? 1) - (sev[b.severity] ?? 1)));
  }, [filtered, sortBy]);

  const highCount = filtered.filter((r) => r.severity === "high").length;
  const sourceNames = useMemo(() => [...new Set(recalls.map((r) => r.source))], [recalls]);
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
    for (const k of categoryKeys) {
      const o = categoryOptions.find((x) => x.value === k);
      if (o) out.push({ key: `cat:${k}`, label: o.label, clear: () => setCategoryKeys(categoryKeys.filter((x) => x !== k)) });
    }
    for (const k of reasonKeys) {
      const o = reasonOptions.find((x) => x.value === k);
      if (o) out.push({ key: `why:${k}`, label: o.label, clear: () => setReasonKeys(reasonKeys.filter((x) => x !== k)) });
    }
    for (const name of sourceNames) {
      if (activeSources.has(name)) continue;
      out.push({
        key: `src:${name}`, label: `${name} hidden`,
        clear: () => setActiveSources((prev) => new Set(prev).add(name)),
      });
    }
    return out;
  }, [filterText, categoryKeys, categoryOptions, reasonKeys, reasonOptions, sourceNames, activeSources]);

  const clearFilters = useCallback(() => {
    setFilterText("");
    setCategoryKeys([]);
    setReasonKeys([]);
    setActiveSources(new Set(sourceNames));
    setLimit(25);
  }, [sourceNames]);

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
  const { pinLabels, pinNamed } = useMemo(() => {
    const labels = stores.map(() => "");
    const flags = stores.map((st) => namedRecallsFor(st).length > 0);
    rankedStores.forEach(({ i }, pos) => { labels[i] = String(pos + 1); });
    return { pinLabels: labels, pinNamed: flags };
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

  /* The one line that answers why anyone opened the app.
   *
   * It states the RELATIONSHIP — which chains, how bad — and deliberately no
   * longer restates the recall count, because the scope row directly above it
   * is now two chips whose whole content is that count. The same number in two
   * adjacent bands is how a screen starts feeling like a dashboard nobody
   * asked for. */
  const headline = useMemo(() => {
    if (storesStatus?.busy || productsBusy) return null;
    if (!recalls.length) return { tone: "calm", text: "No active recalls match your area." };
    const chains = new Set();
    const named = new Set();
    let high = 0;
    for (const st of stores) {
      const mine = namedRecallsFor(st);
      for (const r of mine) {
        if (!named.has(r.id)) { named.add(r.id); if (r.severity === "high") high++; }
      }
      if (mine.length) for (const id of st.chainIds) chains.add(id);
    }
    if (!named.size) {
      return { tone: "calm",
        text: `No recall notice names a store near you. Everything below covers ${loc?.stateAbbr || "your area"} without naming a retailer.` };
    }
    return { tone: "match", high,
      text: `${plural(chains.size, "chain", "chains")} near you ${chains.size === 1 ? "is" : "are"} named in a recall notice` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, recalls, byChain, loc, storesStatus, productsBusy]);

  // Both lookups roll up into one "the app is working" flag.
  const scanning = productsBusy || Boolean(storesStatus?.busy);

  const showStores = "flex " + (tab === "near" ? "" : "max-lg:hidden ");
  // Collapsing is a wide-screen affordance; a phone folds the list by leaving
  // the tab, so the stored preference must not follow it there.
  const storesFolded = isWide && storesCollapsed;
  const showProducts = "flex " + (tab === "recalls" ? "" : "max-lg:hidden ");

  /* Where a selected store's recalls actually appear depends on the layout,
   * and getting this wrong is how the card came to say "Showing its recalls
   * below ↓" on a phone, where "below" is a tab you have to go to. */
  const recallsHere = isWide
    ? (sideBySide ? "Showing its recalls →" : "Showing its recalls below ↓")
    : "Showing its recalls — Recalls tab";

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink" style={motionStyle}>
      {/* ================= top bar =================
          Identity and location only. The recall search box and the product
          type menu used to live here too, which put the controls that filter
          the recall list an entire layout away from the recall list — and on
          a phone squeezed all four into one 360px row. They now sit in the
          Recalls panel, next to the thing they act on. */}
      <header className="z-20 shrink-0 border-b border-line bg-panel elev-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
          <span className="flex shrink-0 items-center gap-2">
            <Radar className="size-5 text-mint" />
            <span className="hidden text-base font-bold tracking-tight sm:inline">Yanked</span>
            <Tooltip content="Early release — data and matching are still being refined">
              <Badge variant="beta" className="hidden sm:inline-flex">beta</Badge>
            </Tooltip>
          </span>

          {loc && (
            <>
              <button
                type="button"
                onClick={() => setLocOpen(true)}
                className="tap inline-flex min-w-0 max-w-[22rem] flex-1 items-center gap-1.5 rounded-full border border-mint-line bg-mint-soft px-3 py-1.5 text-[13px] font-semibold text-mint lg:hidden"
              >
                <MapPin className="size-3.5 shrink-0" />
                <span className="truncate">{loc.label}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </button>
              {/* One control, not two. The chip and the ZIP field were showing
                  the same place at the same time — "San Francisco, CA 94103"
                  beside a box reading "94103" — and the field was standing
                  permanently for a task performed once. The chip is the
                  control now, on every size; the field is what it opens. */}
              <button
                type="button"
                onClick={() => { setLocEditing(true); setTimeout(() => locInputRef.current?.select(), 0); }}
                className="tap hidden min-w-0 items-center gap-1.5 rounded-full border border-mint-line bg-mint-soft px-3 py-1 text-[13px] font-semibold text-mint hover:border-mint lg:inline-flex lg:max-w-[18rem]"
              >
                <MapPin className="size-3.5 shrink-0" />
                <span id="location-label" className="truncate">{loc.label}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </button>
            </>
          )}

          {/* A phone gets none of this. Where a desktop has room for a standing
              form, a phone gets a chip that opens a sheet — a location is set
              once and then read, so a permanent text field is a row of chrome
              paying rent on a task nobody repeats. */}
          <div className={"order-last hidden w-full min-w-0 items-center gap-1.5 lg:order-none lg:w-auto lg:flex-1 lg:justify-end " +
            (loc && !locEditing ? "" : "lg:flex")}>
            {/* `noValidate`, and no `required`. The browser's own bubble —
                "Please fill out this field" — renders in the OS font at the OS
                size in the OS colours, ignores the app's theme entirely, and
                is the one piece of UI here nobody designed. Ours says what to
                type instead of that something is missing. */}
            <form id="form-search" onSubmit={onSearch} noValidate className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
              <Input
                id="input-location"
                ref={locInputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); if (queryError) setQueryError(""); }}
                placeholder="ZIP or address"
                aria-label="ZIP code or address"
                aria-invalid={queryError ? "true" : undefined}
                aria-describedby={queryError ? "input-location-error" : undefined}
                onKeyDown={(e) => { if (e.key === "Escape" && loc) { setLocEditing(false); setQueryError(""); } }}
                className={"h-9 w-44 min-w-0 shrink-0 text-[13px] " +
                  (queryError ? "border-alert focus-visible:border-alert" : "")}
              />
              <Tooltip content="Find recalls around a ZIP code or address">
                <Button type="submit" variant="outline" size="sm" className="h-9 shrink-0 px-3" aria-label="Search location">
                  <Search />
                </Button>
              </Tooltip>
            </form>
            <Tooltip content="Use this device's location instead of typing one">
              <Button id="btn-geolocate" variant="secondary" size="sm" className="h-9 shrink-0 px-3" onClick={useGeolocation} aria-label="Use my location">
                <Crosshair /><span className="hidden xl:inline">My Location</span>
              </Button>
            </Tooltip>
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
        </div>

        {(productsBusy || storesStatus?.busy) && <div id="progress" className="progress-track" />}

        {queryError && (
          <p id="input-location-error" role="alert"
             className="flex items-center gap-2 border-t border-alert-line bg-alert-soft px-4 py-1.5 text-xs font-semibold text-alert">
            <AlertCircle className="size-3.5 shrink-0" />{queryError}
          </p>
        )}

        {locStatus && (
          <p id="locator-status" role="status" aria-live="polite"
             className={"flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs " + (locStatus.error ? "text-alert" : "text-fog")}>
            {locStatus.busy && <Loader2 className="size-3 animate-spin" />}{locStatus.msg}
          </p>
        )}
      </header>

      {/* ================= body: map + panel ================= */}
      <main ref={mainRef} className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* -------- map -------- */}
        <div
          className={"relative min-h-0 shrink-0 lg:min-w-0 lg:flex-1 lg:basis-auto " +
            (mapHidden || tab === "recalls" ? "hidden lg:block " : "") +
            (selectedStore ? "map-has-selection" : "")}
          style={mapStyle}
        >
          {loc ? (
            <MapView ref={mapRef} loc={loc} stores={stores}
                     labels={pinLabels} named={pinNamed} activeIndex={activeStore}
                     theme={resolvedTheme}
                     onMarkerClick={onMarkerClick} />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="fade-item max-w-sm text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-mint-line bg-mint-soft">
                  <Radar className="size-6 text-mint" />
                </span>
                <h1 className="mt-4 text-xl font-bold tracking-tight sm:text-2xl">
                  Find recalled products <span className="text-mint">around you</span>.
                </h1>
                <p className="mt-2 text-sm text-fog">
                  Active FDA, USDA&nbsp;FSIS and CPSC recalls for your area — mapped onto the grocery
                  stores near you, chains and independents alike.
                </p>
                <Button className="mx-auto mt-4" onClick={useGeolocation}>
                  <Crosshair /> Use My Location
                </Button>

                {/* The header's location form is desktop-only now, so the
                    landing screen has to carry it on a phone — which is the
                    right place for it anyway: getting a location is this
                    screen's entire job, and afterwards it is a chip. */}
                <form onSubmit={onSearch} noValidate className="mx-auto mt-4 flex max-w-xs items-center gap-2 lg:hidden">
                  <Input
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); if (queryError) setQueryError(""); }}
                    placeholder="Or enter a ZIP"
                    aria-label="ZIP code or address"
                    className="h-11 min-w-0 flex-1"
                  />
                  <Button type="submit" variant="secondary" className="h-11 shrink-0 px-4">Go</Button>
                </form>
                <p className="microlabel mt-3 hidden lg:block">Or enter a ZIP above</p>
                <p className="mt-5 text-xs leading-relaxed text-subtle">
                  Beta. Recall data comes from public government feeds and is matched to stores by name —
                  expect gaps and false matches. Not a substitute for the official notice.
                </p>
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

          {/* The lists toggle exists at every size now. It was md-and-up only,
              so on a phone — the one place where a full-screen map is most
              worth having — there was no way to get one. */}
          {loc && (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
              <Button
                id="btn-toggle-list" variant="secondary" size="sm"
                aria-pressed={!listHidden}
                aria-controls="stores-panel"
                onClick={() => setView(listHidden ? "split" : "map")}
                className={"bg-panel/90 backdrop-blur " + (listHidden ? "" : "max-lg:hidden")}
              >
                {listHidden ? <><PanelRightOpen /> Show Lists</> : <><PanelRightClose /> Hide Lists</>}
              </Button>
              {!listHidden && (
                <Tooltip content={sideBySide ? "Stack the two lists vertically" : "Put the two lists side by side"}>
                  <Button
                    id="btn-toggle-layout" variant="secondary" size="sm"
                    aria-pressed={sideBySide}
                    onClick={toggleLayout}
                    className="hidden bg-panel/90 px-3 backdrop-blur lg:inline-flex"
                  >
                    {sideBySide ? <Rows2 /> : <Columns2 />}
                    <span className="hidden lg:inline">{sideBySide ? "Stacked" : "Side by Side"}</span>
                  </Button>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* ---- map / panel divider (wide screens) ----
            The desktop counterpart of the phone's grabber: the same gesture,
            the same hook, the same keyboard handling, on the other axis. */}
        {loc && !listHidden && isWide && (
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
        {loc && !listHidden && (
          <aside id="stores-panel"
                 className={"relative z-10 flex min-h-0 flex-1 flex-col border-t border-line bg-ink shadow-[var(--rr-shadow-2)] lg:border-t-0 " +
                   "lg:min-w-[22rem] lg:flex-1"}>
            {/* ---- phone divider: map vs. panel ---- */}
            {/* Only where there is a map to resize. On the recalls screen there
                isn't one, and a drag handle for an absent element is 32px of
                furniture. */}
            <div className={"relative flex shrink-0 items-center border-b border-line bg-panel lg:hidden " +
              (tab === "near" ? "" : "hidden")}>
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
            <div className="scope-row flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-3 py-2">
              <span className="microlabel shrink-0" id="scope-row-label">Recalls</span>
              {/* The chip tooltips are a mouse affordance and nothing else, so
                  the row carries one disclosure a thumb can open. It sits
                  beside the label rather than after the chips: this row scrolls
                  sideways, and on a 390px phone anything trailing the last chip
                  is parked off the edge, which is not an affordance at all. */}
              <InfoTip
                label="What these scopes mean"
                title="How wide a net"
                body={`“${SCOPES[0].label}” shows only notices that name a chain standing near you — the most specific answer this app can give, and the smallest. “Anywhere in ${loc?.stateAbbr || "your area"}” adds every other active notice covering your area, including the many that name no retailer at all. An independent grocer can only ever appear in the second.`}
                triggerClassName="shrink-0 text-fog"
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
                      ["area", `Anywhere in ${loc?.stateAbbr || "your area"} · ${recalls.length}`,
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
                      ? `Anywhere in ${loc.stateAbbr}` : sc.label;
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
            </div>

            {/* The answer, before either list. It stands down on a phone once a
                store is selected — the scope row above is the more specific
                answer, and two context bands over a short list is one too many. */}
            {headline && (
              <p id="headline"
                 className={"flex shrink-0 flex-wrap items-center gap-x-2 border-b border-line px-4 py-2 text-[12px] font-semibold leading-snug lg:py-2.5 lg:text-[13px] " +
                   (selectedStore ? "max-lg:hidden " : "") +
                   (headline.tone === "match" ? "bg-mint-soft text-paper" : "bg-panel text-fog")}>
                <span>{headline.text}</span>
                {/* The severity count is the one number worth carrying up here,
                    and "Class I" is the one word in it nobody can be expected
                    to know. It explains itself in place rather than sending
                    anyone to About. */}
                {headline.high > 0 && (
                  <InfoTip
                    title="Class I — the most serious class"
                    body="The agency believes eating, taking or using the product could cause serious harm or death. Read those notices first."
                    triggerClassName="text-alert"
                    side="bottom"
                  >
                    <span className="tnum">{headline.high} Class I</span>
                  </InfoTip>
                )}
              </p>
            )}

            {/* Both lists live in one measured box so the divider can size them. */}
            <div ref={splitRef}
                 className={"flex min-h-0 flex-1 " + (sideBySide ? "flex-col lg:flex-row" : "flex-col")}>
            {/* ---- stores ---- */}
            <section className={showStores + "min-h-0 flex-col overflow-hidden " +
                       (storesFolded ? "flex-none" : "flex-1")}
                     style={storesFolded ? undefined : storesStyle}>
              <PanelHeader
                label="Stores" countId="stat-stores" count={scanning ? "…" : stores.length}
              >
                {!storesFolded && (
                  <>
                    <span className="microlabel">Within</span>
                    <div className="flex gap-1" role="group" aria-label="Store search radius">
                      {RADII.map((r) => (
                        <button key={r.value} type="button" onClick={() => setRadius(r.value)}
                                aria-pressed={radius === r.value}
                                className={"chip " + (radius === r.value ? "chip-on" : "chip-off")}>
                          {r.label}
                        </button>
                      ))}
                      <span className="microlabel self-center">mi</span>
                    </div>
                  </>
                )}
                {/* Wide screens only: get the whole panel back for reading
                    recalls. On a phone the bottom bar already does this, and a
                    second way to hide a list you are looking at is one too
                    many. */}
                {isWide && (
                  <Tooltip content={storesCollapsed ? "Show the store list again" : "Fold the store list away and give the whole panel to recalls"}>
                    <button
                      id="btn-collapse-stores"
                      type="button"
                      onClick={toggleStoresCollapsed}
                      aria-expanded={!storesCollapsed}
                      aria-controls="stores-list-scroll"
                      aria-label={storesCollapsed ? "Show the store list" : "Hide the store list"}
                      className="ml-1 grid size-7 shrink-0 place-items-center rounded-md text-fog hover:bg-panel-3 hover:text-paper"
                    >
                      {storesCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
                    </button>
                  </Tooltip>
                )}
              </PanelHeader>

              <div id="stores-list-scroll"
                   className={(storesFolded ? "hidden " : "") + "sunken min-h-0 flex-1 overflow-y-auto px-3 py-3"}>
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
                      className={"store-item lift fade-item elev-1 cursor-pointer rounded-xl border bg-panel-2 py-3 pl-4 pr-3 " +
                        (isActive ? "active border-mint bg-mint-soft ring-2 ring-mint"
                          : isSibling ? "same-chain border-mint-line bg-panel-3"
                            : n > 0 ? "border-mint-line hover:border-mint" : "border-line hover:border-line-strong")}
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
                            body="No recall notice will ever name an independent by name, so it can never show a match here. That is a gap in the data, not a clean bill of health — pick it and switch to “Anywhere in your area” to see what it is actually exposed to."
                            label="Local: what this means"
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
                        <p className={"flex min-w-0 items-center gap-1 tnum text-[11px] " +
                          (isActive || isSibling || n > 0 ? "text-mint" : "text-subtle")}>
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
              </div>
            </section>

            {/* ---- drag divider between the two lists (desktop only) ---- */}
            {isWide && !storesFolded && (
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
              {/* ---- the filter bar ----
                  Search and one Filters control, in the panel they filter. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
                {/* The count and the high-risk tally used to be a band of their
                    own above this row, which is two rows for one section's
                    header. They are three words; they fit here. */}
                <span className="microlabel hidden shrink-0 lg:inline">Recalls</span>
                <span id="stat-recalls" className="tnum shrink-0 text-xs font-semibold text-mint">
                  {productsBusy ? "…" : sorted.length}
                </span>
                {highCount > 0 && (
                  <span id="stat-high" className="tnum shrink-0 text-[11px] font-semibold text-amber">{highCount} high-risk</span>
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
                    count={activeFilters.length}
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
                      selected={sourceNames.every((n) => activeSources.has(n)) ? [] : sourceNames.filter((n) => activeSources.has(n))}
                      onChange={(next) => {
                        setActiveSources(new Set(next.length ? next : sourceNames));
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

              {(activeFilters.length > 0 || sortBy !== "newest") && (
                <div id="active-filters" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-panel px-3 py-2">
                  {activeFilters.map((f) => (
                    <button key={f.key} type="button" onClick={() => { f.clear(); setLimit(25); }}
                            className="chip-active" title={`Remove filter: ${f.label}`}>
                      <span className="truncate">{f.label}</span>
                      <X className="size-3 shrink-0" />
                    </button>
                  ))}
                  {sortBy !== "newest" && (
                    <button type="button" onClick={() => setSortBy("newest")} className="chip-active" title="Back to newest first">
                      <span className="truncate">Highest risk first</span>
                      <X className="size-3 shrink-0" />
                    </button>
                  )}
                  {activeFilters.length > 1 && (
                    <button type="button" onClick={clearFilters}
                            className="ml-auto tnum text-[11px] font-semibold uppercase tracking-wider text-fog hover:text-mint">
                      Clear all
                    </button>
                  )}
                </div>
              )}

              <div ref={productsScrollRef} className="sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {!productsBusy && <SourceNotice sources={sources} />}
                {productsBusy && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <RecallSkeleton key={i} delay={i * stagger * 2} />)}</ul>
                )}
                {!productsBusy && recalls.length === 0 && (
                  <EmptyState icon={ShieldCheck} title="All clear — for now">
                    No active recalls matched this area in the past year.
                  </EmptyState>
                )}
                {!productsBusy && recalls.length > 0 && sorted.length === 0 && (
                  <EmptyState icon={selectedStore && !activeFilters.length ? ShieldCheck : SearchX}
                              title={selectedStore && !activeFilters.length ? "Nothing names this store" : "No matches"}>
                    {selectedStore && !activeFilters.length
                      ? `No active recall names ${selectedStore.name}. Most notices list only a state or "nationwide" and never name a retailer, so this is normal — switch to "Anywhere in ${loc?.stateAbbr || "your area"}" above to see all ${recalls.length} recalls that could reach this shelf.`
                      : "Nothing matches the current filters. Remove one of the chips above, or clear them all."}
                  </EmptyState>
                )}

                <ul id="products-list" className="flex flex-col gap-2">
                  {sorted.slice(0, limit).map((r, i) => {
                    const cat = categoryFor(r);
                    const why = reasonFor(r);
                    const CatIcon = CATEGORY_ICONS[cat.key] || Package;
                    const nearby = nearbyStoresFor(r);
                    const linked = new Set(nearby.flatMap((si) => stores[si].chainIds));
                    const unlinked = (r.retailerIds || []).filter((id) => !linked.has(id));
                    return (
                      <li key={r.id} style={{ animationDelay: `${Math.min(i, 8) * stagger}ms` }}
                          className="recall-item fade-item elev-1 rounded-xl border border-line bg-panel-2 p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <SeverityBadge recall={r} />
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
                          <span className="tnum ml-auto text-[11px] text-fog">{fmtDate(r.date)}</span>
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
                  <Button id="btn-more" variant="outline" size="sm" className="mx-auto mt-3 flex h-10" onClick={() => setLimit(limit + 25)}>
                    <Plus /> Show {Math.min(remaining, 25)} More · {remaining} Left
                  </Button>
                )}
              </div>
            </section>
            </div>
          </aside>
        )}
      </main>

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
          {sources.map((s) => (
            <Tooltip key={s.name} content={s.ok ? `${s.name} — ${s.count} matching your area` : `${s.name} — unavailable (${s.error || "error"})`}>
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
      {loc && (
        <nav
          aria-label="Main"
          className="z-30 flex shrink-0 items-stretch border-t border-line bg-panel lg:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        >
          {[
            { id: "near", label: "Near me", icon: Store, count: stores.length },
            { id: "recalls", label: "Recalls", icon: ListFilter, count: filtered.length },
            { id: "scan", label: "Scan", icon: ScanLine },
          ].map(({ id, label, icon: Icon, count }) => {
            const on = id !== "scan" && tab === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => {
                  if (id === "scan") { setScanOpen(true); return; }
                  setTab(id);
                  if (view === "map") setView("split"); // don't land on a hidden list
                }}
                className={"flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors " +
                  (on ? "text-mint" : "text-fog active:bg-panel-3")}
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
                  {label}{count != null && !scanning ? ` ${count}` : ""}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {/* ---- location, on a phone ---- */}
      <Sheet open={locOpen} onClose={() => setLocOpen(false)} title="Location">
        <div className="flex flex-col gap-3 px-4 py-4">
          {loc && (
            <p className="flex items-center gap-2 rounded-xl border border-mint-line bg-mint-soft px-3 py-2.5 text-[13px] font-semibold text-mint">
              <MapPin className="size-4 shrink-0" /> {loc.label}
            </p>
          )}
          <form
            onSubmit={(e) => { onSearch(e); setLocOpen(false); }}
            noValidate
            className="flex items-center gap-2"
          >
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); if (queryError) setQueryError(""); }}
              placeholder="ZIP or address"
              aria-label="ZIP code or address"
              className="h-11 flex-1"
            />
            <Button type="submit" className="h-11 shrink-0">Search</Button>
          </form>
          {queryError && <p role="alert" className="text-xs font-semibold text-alert">{queryError}</p>}
          <Button variant="secondary" className="h-11 w-full"
                  onClick={() => { setLocOpen(false); useGeolocation(); }}>
            <Crosshair /> Use my location
          </Button>
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
              {sources.map((src) => (
                <li key={src.name} className="flex items-center gap-2 text-[13px]">
                  <span className={"size-1.5 shrink-0 rounded-full " + (src.ok ? "bg-mint" : "bg-amber")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{src.name}</span>
                  <span className="tnum shrink-0 text-[11px] text-fog">
                    {src.ok ? `${src.count} matching` : "unavailable"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="px-4 py-3">
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

      <ScanSheet open={scanOpen} onClose={() => setScanOpen(false)} recalls={recalls} />

      {/* DialKit authoring panel — renders null in production builds. */}
      <DialRoot position="bottom-left" theme="dark" defaultOpen={false} />

      {/* ================= about modal ================= */}
      {aboutOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 p-4 sm:items-center"
             onClick={() => setAboutOpen(false)} role="dialog" aria-modal="true" aria-label="About this data">
          <div className="fade-item max-h-[80dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel p-5 text-sm text-fog"
               onClick={(e) => e.stopPropagation()}>
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
              &ldquo;Anywhere in your area&rdquo; to see every notice covering your state, which is what an
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
            <p className="mt-3">Your location is only used to query the sources above — nothing is stored.</p>
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
