import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, Armchair, Baby, Beef, Bike, Candy, Carrot, Check, ChevronDown, ChevronRight, ChevronUp,
  Crosshair, CupSoda,
  ExternalLink, Fish, Info, Loader2, MapPin, MapPinOff, Milk, Package, PanelRightClose,
  PanelRightOpen, PawPrint, Pill, Plug, Plus, Radar, Rows2, Columns2, Search, SearchX,
  ShieldCheck, Soup, Stethoscope, Sun, Moon, MonitorSmartphone, UtensilsCrossed, Wheat, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { FilterButton, FilterSheet, FilterGroup, FilterChoice } from "@/components/FilterSheet";
import MapView from "@/components/MapView";
import { browserPosition, reverseGeocode, geocodeInput } from "@/lib/geo";
import { fetchAll, retryBlockedFsis, sortRecalls } from "@/lib/sources";
import { findStores } from "@/lib/stores";
import { byId, DEFAULT_NEARBY_CHAINS } from "@/lib/retailers";
import { categoryFor } from "@/lib/category";
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

const RADII = [
  { value: 8047, label: "5" },
  { value: 16093, label: "10" },
  { value: 40234, label: "25" },
];

/* ─────────────────────────────────────────────────────────────────────────
 * THE THREE MODES
 *
 * One dimension — how wide a net — stated once at the top of the panel
 * instead of inferred from four scattered controls.
 *
 *   named   the stores a notice actually names, and only the notices that
 *           name them. The app's precise claim, and its smallest answer.
 *   stores  every store near you, chains and independents alike, against
 *           every notice covering your area. An independent can only ever be
 *           exposed at the area level, so this is the only mode in which one
 *           can honestly appear.
 *   recalls no store scoping at all — every active notice for your state.
 *           The store list steps aside; the map stays for context.
 *
 * Independents were the thing this fixes. They were being fetched and
 * rendered the whole time, then sorted below every named chain — on a phone
 * the first one started roughly 300px below the fold with up to 24 chains
 * ahead of it. That is not a filter anyone chose; it was a ranking rule
 * quietly deciding a whole category did not exist.
 * ───────────────────────────────────────────────────────────────────────── */
const MODES = [
  { id: "named", label: "Named",
    hint: "Only stores whose chain a recall notice names, and only the notices that name them." },
  { id: "stores", label: "All stores",
    hint: "Every store nearby, chains and independents — against every notice covering your area." },
  { id: "recalls", label: "All recalls",
    hint: "Every active notice for your area, with no store filtering at all." },
];

/* The phone's three layouts. The split is draggable between them; these are
 * the two ends it cannot be dragged to. */
const VIEWS = ["map", "split", "list"];

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "risk", label: "Highest risk first" },
];

function sevLabel(r) {
  return r.classification || { high: "High risk", med: "Medium risk", low: "Lower risk" }[r.severity];
}

function fmtDate(d) {
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* Recalls are regional far more often than they are national: a supplier
 * ships one lot to one of a chain's distribution centers, so the notice
 * covers the states that DC serves. Show that scope on every card. */
function regionLabel(r) {
  const st = r.states || [];
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
 *  that has about four to give. `mobileHidden` drops the row entirely for a
 *  header whose only remaining content is optional. */
function PanelHeader({ label, countId, count, note, children, mobileHidden }) {
  return (
    <div className={(mobileHidden ? "max-md:hidden " : "") +
      "flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel px-4 py-2"}>
      <span className="flex items-center gap-2 max-md:hidden">
        <span className="microlabel">{label}</span>
        <span id={countId} className="tnum text-xs font-semibold text-mint">{count}</span>
      </span>
      {note}
      <div className="ml-auto flex items-center gap-1.5">{children}</div>
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
  if (f.chainScope && !(r.retailerIds || []).some((id) => f.chainScope.has(id))) return false;
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
  const [mode, setMode] = useState(() => loadPref("rr-mode", "stores"));
  const [view, setView] = useState("split"); // phone only: map | split | list
  const [mobileTab, setMobileTab] = useState("stores");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sideBySide, setSideBySide] = useState(() => loadPref("rr-side-by-side", false));
  const [splitPct, setSplitPct] = useState(() => loadPref("rr-split", DEFAULT_SPLIT));
  const [mapPct, setMapPct] = useState(() => loadPref("rr-map-pct", DEFAULT_MAP_PCT));
  const [isWide, setIsWide] = useState(false); // md+ : two lists at once, no tabs

  const [filterText, setFilterText] = useState("");
  const [categoryKeys, setCategoryKeys] = useState([]); // empty = every type
  const [reasonKeys, setReasonKeys] = useState([]);     // empty = every reason
  const [sortBy, setSortBy] = useState("newest"); // newest | risk
  const [storeScope, setStoreScope] = useState("named"); // named | area
  const [diag, setDiag] = useState(null);
  const [activeSources, setActiveSources] = useState(new Set());
  const [limit, setLimit] = useState(25);

  // Live-tunable motion (DialKit panel in dev; shipped defaults in production).
  const { theme, resolved: resolvedTheme, cycle: cycleTheme } = useTheme();
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
      retryBlockedFsis(locArg, srcs).then((late) => {
        if (!late) return;
        setRecalls((prev) => sortRecalls([...prev, ...late.recalls]));
        setSources(late.sources);
        // Source chips are seeded from the first payload, so a source that
        // arrives late has to opt itself in or its notices stay filtered out.
        setActiveSources((prev) => new Set(prev).add("USDA FSIS"));
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
    if (!isWide) setMobileTab("products");
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
  }, [view, stores, mobileTab, sideBySide, splitPct, mapPct]);

  const stepView = useCallback((dir) => {
    setView((v) => VIEWS[Math.min(VIEWS.length - 1, Math.max(0, VIEWS.indexOf(v) + dir))]);
  }, []);

  const setModePref = useCallback((next) => {
    setMode(next);
    savePref("rr-mode", next);
    setLimit(25);
    // "All recalls" has no store column, so a selection made in another mode
    // would keep scoping a list that no longer shows you what it is scoped to.
    if (next === "recalls") setActiveStore(-1);
    if (next === "recalls" && !isWide) setMobileTab("products");
  }, [isWide]);

  // The columns layout and the list-vs-list divider only exist at md+.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const listSplit = useSplitDrag({
    boxRef: splitRef, axis: sideBySide ? "x" : "y", value: splitPct, setValue: setSplitPct,
    storageKey: "rr-split", min: MIN_SPLIT, max: MAX_SPLIT, reset: DEFAULT_SPLIT,
  });
  const mapSplit = useSplitDrag({
    boxRef: mainRef, axis: "y", value: mapPct, setValue: setMapPct,
    storageKey: "rr-map-pct", min: MIN_MAP_PCT, max: MAX_MAP_PCT, reset: DEFAULT_MAP_PCT,
  });

  async function runSourceCheck() {
    setDiag({ busy: true });
    try {
      const res = await fetch("/api/diag?probe=fsis", { headers: { Accept: "application/json" } });
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
  const mapStyle = isWide ? undefined : { flexBasis: panelShowing ? `${mapPct}%` : "100%" };

  const selectedStore = activeStore >= 0 ? stores[activeStore] : null;

  /* Every chain with a storefront near you. "Named stores" mode is exactly
   * this set applied to the recall list: notices that name a chain you could
   * actually walk into, rather than notices that name any chain anywhere. */
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
     * Otherwise the mode decides: "named" narrows to chains near you, the
     * other two do not narrow by store at all. */
    chainScope: selectedStore
      ? (storeScope === "named" ? new Set(selectedStore.chainIds) : null)
      : (mode === "named" ? nearbyChainIds : null),
  }), [filterText, activeSources, categoryKeys, reasonKeys, selectedStore, storeScope, mode, nearbyChainIds]);

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
   * the mode's job — a control you can see — and the list is free to answer
   * the question it is actually labelled with, which is what is near me. */
  const rankedStores = useMemo(() => {
    const withCounts = stores.map((s, i) => ({ s, i, n: namedRecallsFor(s).length }));
    const list = mode === "named" ? withCounts.filter((x) => x.n > 0) : withCounts;
    return [...list].sort((a, b) => a.s.distanceMiles - b.s.distanceMiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, byChain, mode]);

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

  /* The one line that answers why anyone opened the app. */
  const headline = useMemo(() => {
    if (storesStatus?.busy || productsBusy) return null;
    if (!recalls.length) return { tone: "calm", text: "No active recalls match your area." };
    const chains = new Set();
    const named = new Set();
    let high = 0;
    for (const st of stores) {
      for (const r of namedRecallsFor(st)) {
        if (!named.has(r.id)) { named.add(r.id); if (r.severity === "high") high++; }
      }
      if (namedRecallsFor(st).length) for (const id of st.chainIds) chains.add(id);
    }
    if (!named.size) {
      return { tone: "calm",
        text: `No notice names a store near you — ${recalls.length} recall${recalls.length === 1 ? "" : "s"} cover ${loc?.stateAbbr || "your area"}.` };
    }
    return { tone: "match",
      text: `${chains.size} chain${chains.size === 1 ? "" : "s"} near you ${chains.size === 1 ? "is" : "are"} named in ` +
            `${named.size} recall notice${named.size === 1 ? "" : "s"}${high ? `, ${high} class I` : ""}.` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, recalls, byChain, loc, storesStatus, productsBusy]);

  const namedStoreCount = useMemo(
    () => stores.reduce((n, s) => n + (namedRecallsFor(s).length > 0 ? 1 : 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stores, byChain]
  );

  // Both lookups roll up into one "the app is working" flag.
  const scanning = productsBusy || Boolean(storesStatus?.busy);

  const showStores = "flex " + (mobileTab === "stores" ? "" : "max-md:hidden ");
  const showProducts = "flex " + (mode === "recalls" || mobileTab === "products" ? "" : "max-md:hidden ");

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
            <span className="text-base font-bold tracking-tight">Yanked</span>
            <Tooltip content="Early release — data and matching are still being refined">
              <Badge variant="beta">beta</Badge>
            </Tooltip>
          </span>

          {loc && (
            <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-mint-line bg-mint-soft px-3 py-1 text-[13px] font-semibold text-mint sm:max-w-[14rem] sm:flex-none">
              <MapPin className="size-3.5 shrink-0" />
              <span id="location-label" className="truncate">{loc.label}</span>
            </span>
          )}

          {/* Five controls do not fit across 390px, and squeezing them was not
              a near miss: the ZIP field's own submit button ended up underneath
              the locate button, unclickable. Below sm the location controls
              take their own row — which is also the right emphasis, since on
              the landing screen entering a ZIP is the whole task. */}
          <div className="order-last flex w-full min-w-0 items-center gap-1.5 sm:order-none sm:w-auto sm:flex-1 sm:justify-end">
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
                className={"h-9 min-w-0 flex-1 text-[13px] sm:w-36 sm:flex-none lg:w-44 " +
                  (queryError ? "border-alert focus-visible:border-alert" : "")}
              />
              <Tooltip content="Find recalls around a ZIP code or address">
                <Button type="submit" variant="outline" size="sm" className="h-9 shrink-0 px-3" aria-label="Search location">
                  <Search />
                </Button>
              </Tooltip>
            </form>
            <Tooltip content="Use this device's location instead of typing one">
              <Button id="btn-geolocate" size="sm" className="h-9 shrink-0 px-3" onClick={useGeolocation} aria-label="Use my location">
                <Crosshair /><span className="hidden xl:inline">My Location</span>
              </Button>
            </Tooltip>
          </div>

          <Tooltip content={theme === "system" ? "Following your system theme — click for light" : `${theme[0].toUpperCase()}${theme.slice(1)} theme — click to change`}>
            <Button
              id="btn-theme" variant="secondary" size="icon" className="ml-auto h-9 w-9 shrink-0 sm:ml-0"
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
      <main ref={mainRef} className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* -------- map -------- */}
        <div
          className={"relative min-h-0 shrink-0 md:min-w-0 md:flex-1 md:basis-auto " +
            (mapHidden ? "hidden md:block " : "") +
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
                <p className="microlabel mt-3">Or enter a ZIP above</p>
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
                className="bg-panel/90 backdrop-blur"
              >
                {listHidden ? <><PanelRightOpen /> Show Lists</> : <><PanelRightClose /> Hide Lists</>}
              </Button>
              {!listHidden && (
                <Tooltip content={sideBySide ? "Stack the two lists vertically" : "Put the two lists side by side"}>
                  <Button
                    id="btn-toggle-layout" variant="secondary" size="sm"
                    aria-pressed={sideBySide}
                    onClick={toggleLayout}
                    className="hidden bg-panel/90 px-3 backdrop-blur md:inline-flex"
                  >
                    {sideBySide ? <Rows2 /> : <Columns2 />}
                    <span className="hidden lg:inline">{sideBySide ? "Stacked" : "Side by Side"}</span>
                  </Button>
                </Tooltip>
              )}
            </div>
          )}
        </div>

        {/* -------- right panel: stores over products -------- */}
        {loc && !listHidden && (
          <aside id="stores-panel"
                 className={"relative z-10 flex min-h-0 flex-1 flex-col border-t border-line bg-ink shadow-[var(--rr-shadow-2)] md:flex-none md:border-l md:border-t-0 " +
                   (sideBySide ? "md:w-[38rem] xl:w-[46rem]" : "md:w-[26rem]")}>
            {/* ---- phone divider: map vs. panel ---- */}
            <div className="relative flex shrink-0 items-center border-b border-line bg-panel md:hidden">
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
                        className="grid size-7 place-items-center rounded-md text-fog disabled:opacity-30 active:bg-panel-3">
                  <ChevronDown className="size-4" />
                </button>
                <button type="button" onClick={() => stepView(1)} disabled={view === "list"}
                        aria-label="Show more list"
                        className="grid size-7 place-items-center rounded-md text-fog disabled:opacity-30 active:bg-panel-3">
                  <ChevronUp className="size-4" />
                </button>
              </div>
            </div>

            {/* ---- the mode bar ----
                The one control that says how wide a net this whole panel is
                casting. It replaces a hidden binary (the "N Named" chip) and
                a ranking rule, neither of which named the concept. */}
            <div id="mode-bar" role="group" aria-label="How much to include"
                 className="flex shrink-0 gap-1 border-b border-line bg-panel px-3 py-2">
              {MODES.map((m) => {
                const n = m.id === "named" ? namedStoreCount
                  : m.id === "stores" ? stores.length
                    : recalls.length;
                return (
                  <Tooltip key={m.id} content={m.hint}>
                    <button
                      type="button"
                      aria-pressed={mode === m.id}
                      onClick={() => setModePref(m.id)}
                      className={"chip min-w-0 flex-1 px-2 " + (mode === m.id ? "chip-on" : "chip-off")}
                    >
                      <span className="truncate normal-case tracking-normal">{m.label}</span>
                      {!scanning && <span className="tnum opacity-70">{n}</span>}
                    </button>
                  </Tooltip>
                );
              })}
            </div>

            {/* The answer, before either list. On a phone it stands down once
                you pick a store: two tinted context bars stacked above a list
                with room for two cards is one bar too many, and the selected
                store is the more specific answer of the two. */}
            {headline && (
              <p id="headline"
                 className={"shrink-0 border-b border-line px-4 py-2 text-[12px] font-semibold leading-snug md:py-2.5 md:text-[13px] " +
                   (selectedStore ? "max-md:hidden " : "") +
                   (headline.tone === "match" ? "bg-mint-soft text-paper" : "bg-panel text-fog")}>
                {headline.text}
              </p>
            )}

            {/* ---- the selected store ----
                One bar, above the tabs, visible from both of them. The
                selection used to be carried by a tinted card in one list and a
                small chip buried in the other list's toolbar between a scope
                toggle and the source filters — so on a phone, where you only
                ever see one of those, "which store am I looking at" had no
                answer at all. This is the answer, and it is also where you
                clear it and where you switch what "its recalls" means. */}
            {selectedStore && (
              <div id="store-selection" className="shrink-0 border-b border-line bg-panel px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-mint bg-mint text-mint-ink">
                    <MapPin className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="microlabel leading-none text-mint">Showing recalls for</p>
                    <p className="truncate text-[13px] font-bold text-paper">{selectedStore.name}</p>
                  </div>
                  <span className="tnum hidden shrink-0 text-[11px] text-fog sm:inline">
                    {selectedStore.distanceMiles.toFixed(1)} mi
                    {activeChainStores.length > 1 && ` · ${activeChainStores.length} locations`}
                  </span>
                  <button
                    id="btn-clear-store"
                    onClick={clearStore}
                    aria-label={`Clear ${selectedStore.name} and show all nearby stores`}
                    className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel-2 text-fog hover:border-mint-line hover:text-mint"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div id="store-scope" className="mt-2 flex gap-1.5" role="group" aria-label="How this store relates to the recalls">
                  {[
                    ["named", `Names it · ${namedCount}`, namedCount === 0
                      ? "No notice names this store's chain"
                      : "Notices that name this chain by name"],
                    ["area", `In ${loc?.stateAbbr || "your area"} · ${recalls.length}`,
                      "Every notice covering your area — it names no retailer, so it could be on any shelf here"],
                  ].map(([k, lbl, title]) => (
                    <Tooltip key={k} content={title}><button type="button"
                            disabled={k === "named" && namedCount === 0}
                            onClick={() => { setStoreScope(k); setLimit(25); }}
                            aria-pressed={storeScope === k}
                            className={"chip flex-1 " + (storeScope === k ? "chip-on" : "chip-off")}>
                      <span className="truncate normal-case tracking-normal">{lbl}</span>
                    </button></Tooltip>
                  ))}
                </div>
              </div>
            )}

            {/* mobile tab switch */}
            <div className="flex shrink-0 border-b border-line md:hidden" role="tablist">
              {[
                ["stores", "Stores", stores.length, false],
                ["products", "Recalls", filtered.length, Boolean(selectedStore)],
              ].filter(([k]) => !(mode === "recalls" && k === "stores")).map(([k, lbl, n, dot]) => (
                <button key={k} role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}
                        className={"flex flex-1 items-center justify-center gap-1.5 py-3 text-[12px] font-semibold uppercase tracking-wider transition-colors " +
                          (mobileTab === k ? "border-b-2 border-mint text-mint" : "border-b-2 border-transparent text-fog")}>
                  {lbl} <span className="tnum opacity-70">{n}</span>
                  {/* A dot on the tab you are not looking at is the only way to
                      know, from the Stores tab, that the Recalls list is
                      currently scoped to a store. */}
                  {dot && <span aria-label="filtered to the selected store" className="size-1.5 rounded-full bg-mint" />}
                </button>
              ))}
            </div>

            {/* Both lists live in one measured box so the divider can size them. */}
            <div ref={splitRef}
                 className={"flex min-h-0 flex-1 " + (sideBySide ? "flex-col md:flex-row" : "flex-col")}>
            {/* ---- stores ---- */}
            <section className={(mode === "recalls" ? "hidden " : showStores) + "min-h-0 flex-1 flex-col overflow-hidden"}
                     style={mode === "recalls" ? undefined : storesStyle}>
              <PanelHeader
                label="Stores" countId="stat-stores" count={scanning ? "…" : stores.length}
                note={namedStoreCount > 0 && mode !== "named" && (
                  <span className="tnum text-[11px] text-mint">{namedStoreCount} named</span>
                )}
              >
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
              </PanelHeader>

              <div className="sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
                          <Tooltip content="An independent — no recall notice will ever name it, so this is a gap in the data rather than a clean bill of health">
                            <span className="store-local rounded-full border border-line px-1.5 py-px tnum text-[10px] uppercase tracking-wider text-fog">
                              Local
                            </span>
                          </Tooltip>
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
                                  ? `Named in ${plural(n, "notice", "notices")} — tap to see them`
                                  : s.independent
                                    ? "Independent — tap for area notices"
                                    : "No notice names this chain"}
                          </span>
                          {/* A chevron is how a phone list says "this goes
                              somewhere". Only on the rows that do. */}
                          {!isActive && !isSibling && (
                            <ChevronRight className="size-3 shrink-0 opacity-70 md:hidden" />
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
            {isWide && mode !== "recalls" && (
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
              <PanelHeader
                label="Recalls" countId="stat-recalls" count={productsBusy ? "…" : sorted.length}
                mobileHidden={highCount === 0}
                note={highCount > 0 && (
                  <span id="stat-high" className="tnum text-[11px] text-amber">{highCount} high-risk</span>
                )}
              />

              {/* ---- the filter bar ----
                  Search and one Filters control, in the panel they filter. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
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
                      ? `No active recall names ${selectedStore.name}. Most notices list only a state or "nationwide" and never name a retailer, so this is normal — switch to "in ${loc?.stateAbbr || "your area"}" above to see all ${recalls.length} recalls that could reach this shelf.`
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
                          <Badge variant={r.severity}>{sevLabel(r)}</Badge>
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
                          {r.image && (
                            <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer"
                                 className="size-14 shrink-0 rounded-lg border border-line bg-panel object-cover"
                                 onError={(e) => { e.currentTarget.style.display = "none"; }} />
                          )}
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
        className="safe-b z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 pt-1.5"
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
              That is a limit of the data, not a clean bill of health: pick a store and switch to the
              &ldquo;in your area&rdquo; view to see every notice covering your state, which is what an independent
              is actually exposed to.
            </p>
            <p className="mt-3">
              <span className="text-paper">Why the region matters.</span>{" "}
              Recalls are usually regional — one supplier ships one lot to one of a chain's distribution centers, so
              the notice covers the states that DC serves. Each recall shows its states; a chain named in a recall
              that never reached your state is a different risk from one that did.
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

            {/* USDA sits behind a bot filter that blocks us intermittently; this
                says which endpoint it is refusing today without leaving the app. */}
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-center gap-2">
                <Button id="btn-check-sources" variant="outline" size="sm"
                        disabled={diag?.busy}
                        onClick={runSourceCheck}>
                  {diag?.busy ? <Loader2 className="animate-spin" /> : <Stethoscope />} Check USDA Now
                </Button>
                <span className="text-[11px]">tests every USDA endpoint we know of, live</span>
              </div>
              {diag && !diag.busy && (
                <div id="diag-result" className="mt-2">
                  <p className={"text-xs " + (diag.error ? "text-alert" : "text-paper")}>
                    {diag.error || diag.verdict}
                  </p>
                  {diag.rows && (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {diag.rows.map((row, i) => (
                        <li key={i} className="flex flex-wrap items-center gap-x-2 tnum text-[10px] text-fog">
                          <span className={"size-1.5 shrink-0 rounded-full " + (row.ok ? "bg-mint" : "bg-amber")} aria-hidden="true" />
                          <span className="truncate">{row.url.replace("https://", "")}</span>
                          <span className="text-paper">{row.headers}</span>
                          <span className="ml-auto">{row.status ?? row.error}</span>
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
