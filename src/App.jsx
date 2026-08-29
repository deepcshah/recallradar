import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Armchair, Baby, Beef, Bike, Candy, Carrot, ChevronDown, Crosshair, CupSoda, ExternalLink,
  Fish, Info, Loader2, MapPin, MapPinOff, Milk, Package, PanelRightClose, PanelRightOpen,
  PawPrint, Pill, Plug, Plus, Radar, Rows2, Columns2, Search, SearchX, ShieldCheck, Soup,
  Stethoscope, Sun, Moon, MonitorSmartphone, UtensilsCrossed, Wheat, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import MapView from "@/components/MapView";
import { browserPosition, reverseGeocode, geocodeInput } from "@/lib/geo";
import { fetchAll, retryBlockedFsis, sortRecalls } from "@/lib/sources";
import { findStores } from "@/lib/stores";
import { byId, DEFAULT_NEARBY_CHAINS } from "@/lib/retailers";
import { categoryFor } from "@/lib/category";
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

const RADII = [
  { value: 8047, label: "5" },
  { value: 16093, label: "10" },
  { value: 40234, label: "25" },
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

function EmptyState({ icon: Icon, title, children, compact }) {
  return (
    <div className={"fade-item flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line bg-panel-2/40 px-5 text-center " + (compact ? "py-6" : "py-9")}>
      <span className="flex size-9 items-center justify-center rounded-full border border-mint/30 bg-mint/10">
        <Icon className="size-4 text-mint" />
      </span>
      <p className="mt-0.5 text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-xs leading-relaxed text-fog">{children}</p>
    </div>
  );
}

/** Section header shared by both panels: label, live count, optional trailing controls. */
function PanelHeader({ label, countId, count, note, children }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel px-4 py-2.5">
      <span className="microlabel">{label}</span>
      <span id={countId} className="tnum text-xs font-semibold text-mint">{count}</span>
      {note}
      <div className="ml-auto flex items-center gap-1.5">{children}</div>
    </div>
  );
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
  const [radius, setRadius] = useState(16093);

  const [recalls, setRecalls] = useState([]);
  const [sources, setSources] = useState([]);
  const [productsBusy, setProductsBusy] = useState(false);

  const [stores, setStores] = useState([]);
  const [storesStatus, setStoresStatus] = useState(null);
  const [activeStore, setActiveStore] = useState(-1); // drives map focus AND product filtering
  const [listHidden, setListHidden] = useState(false);
  const [mobileTab, setMobileTab] = useState("stores");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sideBySide, setSideBySide] = useState(() => loadPref("rr-side-by-side", false));
  const [splitPct, setSplitPct] = useState(() => loadPref("rr-split", DEFAULT_SPLIT));
  const [isWide, setIsWide] = useState(false); // md+ : the only place resizing applies

  const [filterText, setFilterText] = useState("");
  const [category, setCategory] = useState("all");
  const [sortBy, setSortBy] = useState("newest"); // newest | risk
  const [flaggedOnly, setFlaggedOnly] = useState(false);
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
  const draggingRef = useRef(false);

  const { byChain } = useMemo(() => chainsFor(recalls), [recalls]);

  const loadStores = useCallback(async (recallList, locArg, radiusArg, attempt = 0) => {
    const chainList = chainsToSearch(recallList);
    setActiveStore(-1);
    setStoresStatus({
      msg: attempt === 0
        ? `Finding grocery stores near you — chains and independents…`
        : "First attempt failed — retrying…",
      busy: true,
    });
    try {
      const found = await findStores(chainList, locArg, radiusArg);
      setStores(found);
      setStoresStatus(found.length ? null : {
        empty: true,
        title: "nothing in range",
        msg: "No stores found within this radius — try a wider one.",
      });
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 3000));
        return loadStores(recallList, locArg, radiusArg, 1);
      }
      setStores([]);
      setStoresStatus({
        msg: `Store lookup failed (${err.message}). The product list is unaffected.`,
        error: true,
        retry: () => loadStores(recallList, locArg, radiusArg),
      });
    }
  }, []);

  const loadAll = useCallback(async (locArg, radiusArg) => {
    setProductsBusy(true);
    setRecalls([]);
    setStores([]);
    setLimit(25);
    const { recalls: fetched, sources: srcs } = await fetchAll(locArg);
    setRecalls(fetched);
    setSources(srcs);
    setActiveSources(new Set(fetched.map((r) => r.source)));
    setProductsBusy(false);

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

    await loadStores(fetched, locArg, radiusArg);
  }, [loadStores]);

  const setLocation = useCallback(async (newLoc) => {
    setLoc(newLoc);
    setLocStatus(newLoc.state ? null : { msg: "Couldn't determine your state — showing nationwide recalls only." });
    await loadAll(newLoc, radius);
  }, [loadAll, radius]);

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
    if (!query.trim()) return;
    setLocStatus({ msg: "Finding that place…", busy: true });
    try {
      await setLocation(await geocodeInput(query));
    } catch (err) {
      setLocStatus({ msg: err.message, error: true });
    }
  }

  function onRadiusChange(v) {
    setRadius(v);
    if (loc) loadStores(recalls, loc, v);
  }

  /** Selecting a store is one action: focus its pin and scope the product list.
   *  Open on the bucket that has something in it — "names this store" when a
   *  notice names its chain, otherwise everything distributed in the area. */
  const scopeForStore = useCallback((i) => (i >= 0 && namedRecallsFor(stores[i]).length > 0 ? "named" : "area"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stores, byChain]);

  const selectStore = useCallback((i) => {
    setActiveStore((prev) => {
      const next = prev === i ? -1 : i;
      if (next >= 0) mapRef.current && mapRef.current.focusStore(next);
      setStoreScope(scopeForStore(next));
      return next;
    });
    setLimit(25);
  }, [scopeForStore]);

  const onMarkerClick = useCallback((i) => {
    setActiveStore((prev) => {
      const next = prev === i ? -1 : i;
      setStoreScope(scopeForStore(next));
      return next;
    });
    setLimit(25);
    setMobileTab("products");
    const el = storeItemRefs.current[i];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [scopeForStore]);

  useEffect(() => {
    mapRef.current && mapRef.current.resize();
  }, [listHidden, stores, mobileTab, sideBySide, splitPct]);

  // Resizing and the columns layout only exist at md+, where both lists show.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const commitSplit = useCallback((pct) => {
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pct));
    setSplitPct(clamped);
    return clamped;
  }, []);

  function onSplitPointerDown(e) {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onSplitPointerMove(e) {
    if (!draggingRef.current || !splitRef.current) return;
    const r = splitRef.current.getBoundingClientRect();
    commitSplit(sideBySide
      ? ((e.clientX - r.left) / r.width) * 100
      : ((e.clientY - r.top) / r.height) * 100);
  }
  function onSplitPointerUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    savePref("rr-split", splitPct);
  }
  function onSplitKeyDown(e) {
    const back = sideBySide ? "ArrowLeft" : "ArrowUp";
    const fwd = sideBySide ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd && e.key !== "Home") return;
    e.preventDefault();
    savePref("rr-split", e.key === "Home" ? commitSplit(DEFAULT_SPLIT)
      : commitSplit(splitPct + (e.key === fwd ? 4 : -4)));
  }
  function resetSplit() { savePref("rr-split", commitSplit(DEFAULT_SPLIT)); }

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

  // Inline basis drives both axes; on phones the tabs own the sizing instead.
  const storesStyle = isWide ? { flexBasis: `${splitPct}%`, flexGrow: 0, flexShrink: 0 } : undefined;

  const categories = useMemo(() => {
    const m = new Map();
    for (const r of recalls) {
      const c = categoryFor(r);
      m.set(c.key, c.label);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [recalls]);

  const selectedStore = activeStore >= 0 ? stores[activeStore] : null;

  /* Two ways a recall can matter at a store, and they are not the same claim:
   *   named — the notice names this chain, so its warehouses got the lot;
   *   area  — the notice covers your state but names no retailer, so it could
   *           be on any shelf here, this one included.
   * Independents only ever have the second kind. */
  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const chainScope =
      selectedStore && storeScope === "named" ? new Set(selectedStore.chainIds) : null;
    return recalls.filter((r) => {
      if (!activeSources.has(r.source)) return false;
      if (category !== "all" && categoryFor(r).key !== category) return false;
      if (chainScope && !(r.retailerIds || []).some((id) => chainScope.has(id))) return false;
      if (!q) return true;
      return [r.product, r.firm, r.reason, r.distribution, r.source].join(" ").toLowerCase().includes(q);
    });
  }, [recalls, filterText, activeSources, category, selectedStore, storeScope]);

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

  /* Stores a recall actually names come first; everything else stays in
   * distance order so the list still reads as "what is near me". */
  const rankedStores = useMemo(() => {
    const withCounts = stores.map((s, i) => ({ s, i, n: namedRecallsFor(s).length }));
    const list = flaggedOnly ? withCounts.filter((x) => x.n > 0) : withCounts;
    return [...list].sort((a, b) => (b.n > 0) - (a.n > 0) || a.s.distanceMiles - b.s.distanceMiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, byChain, flaggedOnly]);

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
  const { pinLabels, pinFlagged } = useMemo(() => {
    const labels = stores.map(() => "");
    const flags = stores.map((st) => namedRecallsFor(st).length > 0);
    rankedStores.forEach(({ i }, pos) => { labels[i] = String(pos + 1); });
    return { pinLabels: labels, pinFlagged: flags };
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
        text: `No recall names a store near you — ${recalls.length} notice${recalls.length === 1 ? "" : "s"} cover ${loc?.stateAbbr || "your area"}.` };
    }
    return { tone: "alert",
      text: `${chains.size} chain${chains.size === 1 ? "" : "s"} near you ${chains.size === 1 ? "is" : "are"} named in ` +
            `${named.size} recall${named.size === 1 ? "" : "s"}${high ? `, ${high} high-risk` : ""}.` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores, recalls, byChain, loc, storesStatus, productsBusy]);

  const flaggedCount = useMemo(
    () => stores.reduce((n, s) => n + (namedRecallsFor(s).length > 0 ? 1 : 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stores, byChain]
  );

  const showStores = "flex " + (mobileTab === "stores" ? "" : "max-md:hidden ");
  const showProducts = "flex " + (mobileTab === "products" ? "" : "max-md:hidden ");

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink" style={motionStyle}>
      {/* ================= top bar ================= */}
      <header className="z-20 shrink-0 border-b border-line bg-panel elev-1">
        <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4 md:flex-row md:flex-wrap md:items-center md:gap-x-4">
          {/* -- left: identity + product search / type filter -- */}
          <div className="flex min-w-0 items-center gap-2.5 md:flex-1">
            <span className="flex shrink-0 items-center gap-2">
              <Radar className="size-5 text-mint" />
              <span className="hidden text-base font-bold tracking-tight sm:inline">
                Recall<span className="text-mint">Radar</span>
              </span>
              <Badge variant="beta" title="Early release — data and matching are still being refined">beta</Badge>
            </span>
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fog" />
              <Input
                id="filter-text"
                type="search"
                value={filterText}
                onChange={(e) => { setFilterText(e.target.value); setLimit(25); }}
                placeholder="search recalls…"
                aria-label="Search recalled products"
                className="h-9 pl-9 text-[13px]"
              />
            </div>
            <div className="relative shrink-0">
              <select
                id="filter-category"
                value={category}
                onChange={(e) => { setCategory(e.target.value); setLimit(25); }}
                aria-label="Filter by product type"
                className="h-9 appearance-none rounded-full border border-line bg-panel-2 pl-3.5 pr-8 tnum text-[11px] uppercase tracking-wider text-fog focus-visible:border-mint/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
              >
                <option value="all">all types</option>
                {categories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fog" />
            </div>
          </div>

          {/* -- right: location -- */}
          <div className="flex min-w-0 items-center gap-2">
            {loc && (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-[13px] font-semibold text-mint md:max-w-[15rem] md:flex-none">
                <MapPin className="size-3.5 shrink-0" />
                <span id="location-label" className="truncate">{loc.label}</span>
              </span>
            )}
            <form id="form-search" onSubmit={onSearch} className="flex min-w-0 items-center gap-1.5">
              <Input
                id="input-location"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ZIP or address"
                aria-label="ZIP code or address"
                required
                className="h-9 w-24 text-[13px] sm:w-32 lg:w-44"
              />
              <Button type="submit" variant="outline" size="sm" className="h-9 px-3" aria-label="Search location">
                <Search />
              </Button>
            </form>
            <Button id="btn-geolocate" size="sm" className="h-9 px-3" onClick={useGeolocation} aria-label="Use my location">
              <Crosshair /><span className="hidden xl:inline">my location</span>
            </Button>
            <Button
              id="btn-theme" variant="secondary" size="icon" className="h-9 w-9 shrink-0"
              onClick={cycleTheme}
              title={`Theme: ${theme} — click to change`}
              aria-label={`Theme: ${theme}. Click to change.`}
            >
              {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <MonitorSmartphone />}
            </Button>
          </div>
        </div>

        {(productsBusy || storesStatus?.busy) && <div id="progress" className="progress-track" />}

        {locStatus && (
          <p id="locator-status" role="status" aria-live="polite"
             className={"flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs " + (locStatus.error ? "text-alert" : "text-fog")}>
            {locStatus.busy && <Loader2 className="size-3 animate-spin" />}{locStatus.msg}
          </p>
        )}
      </header>

      {/* ================= body: map + panel ================= */}
      <main className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* -------- map -------- */}
        <div className="relative min-h-0 shrink-0 basis-[42%] md:min-w-0 md:flex-1 md:basis-auto">
          {loc ? (
            <MapView ref={mapRef} loc={loc} stores={stores}
                     labels={pinLabels} flagged={pinFlagged} activeIndex={activeStore}
                     theme={resolvedTheme}
                     onMarkerClick={onMarkerClick} />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="fade-item max-w-sm text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-full border border-mint/30 bg-mint/10">
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
                  <Crosshair /> use my location
                </Button>
                <p className="microlabel mt-3">or enter a ZIP above</p>
                <p className="mt-5 text-xs leading-relaxed text-subtle">
                  Beta. Recall data comes from public government feeds and is matched to stores by name —
                  expect gaps and false matches. Not a substitute for the official notice.
                </p>
              </div>
            </div>
          )}

          {storesStatus?.busy && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-ink/55 backdrop-blur-[2px]">
              <span className="radar-sweep" />
              {[0, 1, 2].map((i) => (
                <span key={i} className="radar-ring"
                      style={{ animationDelay: `calc(var(--rr-radar-stagger) * ${i})` }} />
              ))}
              <span className="radar-dot" />
              <div className="absolute bottom-8 flex flex-col items-center gap-1">
                <p className="text-sm font-semibold text-paper">Scanning {loc?.label || "your area"}</p>
                <p className="text-xs text-fog">
                  {recalls.length
                    ? `${recalls.length} recalls loaded · finding nearby stores`
                    : "loading recall notices…"}
                </p>
              </div>
            </div>
          )}

          {loc && (
            <div className="absolute left-3 top-3 z-10 hidden items-center gap-1.5 md:flex">
              <Button
                id="btn-toggle-list" variant="secondary" size="sm"
                aria-pressed={!listHidden}
                onClick={() => setListHidden(!listHidden)}
                className="bg-panel/90 backdrop-blur"
              >
                {listHidden ? <><PanelRightOpen /> show lists</> : <><PanelRightClose /> hide lists</>}
              </Button>
              {!listHidden && (
                <Button
                  id="btn-toggle-layout" variant="secondary" size="sm"
                  aria-pressed={sideBySide}
                  onClick={toggleLayout}
                  title={sideBySide ? "Stack the lists" : "Put the lists side by side"}
                  className="bg-panel/90 px-3 backdrop-blur"
                >
                  {sideBySide ? <Rows2 /> : <Columns2 />}
                  <span className="hidden lg:inline">{sideBySide ? "stacked" : "side by side"}</span>
                </Button>
              )}
            </div>
          )}
        </div>

        {/* -------- right panel: stores over products -------- */}
        {loc && !listHidden && (
          <aside id="stores-panel"
                 className={"relative z-10 flex min-h-0 flex-1 flex-col border-t border-line bg-ink shadow-[var(--rr-shadow-2)] md:flex-none md:border-l md:border-t-0 " +
                   (sideBySide ? "md:w-[38rem] xl:w-[46rem]" : "md:w-[26rem]")}>
            {/* The answer, before either list. */}
            {headline && (
              <p id="headline"
                 className={"shrink-0 border-b border-line px-4 py-2.5 text-[13px] font-semibold " +
                   (headline.tone === "alert" ? "bg-alert/[0.07] text-alert" : "bg-panel text-fog")}>
                {headline.text}
              </p>
            )}

            {/* mobile tab switch */}
            <div className="flex shrink-0 border-b border-line md:hidden" role="tablist">
              {[["stores", `stores · ${stores.length}`], ["products", `products · ${filtered.length}`]].map(([k, lbl]) => (
                <button key={k} role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}
                        className={"flex-1 py-2.5 tnum text-[11px] uppercase tracking-wider transition-colors " +
                          (mobileTab === k ? "border-b-2 border-mint text-mint" : "text-fog")}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* Both lists live in one measured box so the divider can size them. */}
            <div ref={splitRef}
                 className={"flex min-h-0 flex-1 " + (sideBySide ? "flex-col md:flex-row" : "flex-col")}>
            {/* ---- stores ---- */}
            <section className={showStores + "min-h-0 flex-1 flex-col overflow-hidden"} style={storesStyle}>
              <PanelHeader
                label="stores" countId="stat-stores" count={storesStatus?.busy ? "…" : stores.length}
                note={flaggedCount > 0 && (
                  <button id="btn-flagged-only" onClick={() => setFlaggedOnly(!flaggedOnly)}
                          aria-pressed={flaggedOnly}
                          title="Show only stores a recall names"
                          className={"rounded-full border px-2 py-0.5 tnum text-[10px] uppercase tracking-wider transition-colors " +
                            (flaggedOnly ? "border-alert bg-alert/15 text-alert" : "border-alert/40 text-alert hover:bg-alert/10")}>
                    {flaggedCount} flagged
                  </button>
                )}
              >
                <span className="microlabel">within</span>
                <div className="flex gap-1" role="group" aria-label="Store search radius">
                  {RADII.map((r) => (
                    <button key={r.value} type="button" onClick={() => onRadiusChange(r.value)}
                            aria-pressed={radius === r.value}
                            className={"rounded-full border px-2 py-0.5 tnum text-[11px] transition-colors " +
                              (radius === r.value ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                      {r.label}
                    </button>
                  ))}
                  <span className="microlabel self-center">mi</span>
                </div>
              </PanelHeader>

              <div className="sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {storesStatus && !storesStatus.empty && (
                  <div id="stores-status" role="status" aria-live="polite"
                       className={"mb-2 flex flex-wrap items-center gap-2 text-xs " + (storesStatus.error ? "text-alert" : "text-fog")}>
                    {storesStatus.busy && <Loader2 className="size-3 animate-spin" />}
                    <span>{storesStatus.msg}</span>
                    {storesStatus.retry && (
                      <Button id="btn-retry-stores" variant="outline" size="sm" onClick={storesStatus.retry}>retry</Button>
                    )}
                  </div>
                )}
                {storesStatus?.empty && (
                  <div id="stores-status" role="status">
                    <EmptyState icon={MapPinOff} title={storesStatus.title} compact>{storesStatus.msg}</EmptyState>
                  </div>
                )}
                {storesStatus?.busy && !stores.length && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2, 3, 4].map((i) => <StoreSkeleton key={i} delay={i * stagger * 2} />)}</ul>
                )}

                <ul id="stores-list" className="flex flex-col gap-2">
                  {rankedStores.map(({ s, i, n }, pos) => (
                    <li
                      key={`${s.name}-${s.lat}-${s.lon}`}
                      ref={(el) => (storeItemRefs.current[i] = el)}
                      data-index={i}
                      onClick={() => selectStore(i)}
                      className={"store-item lift fade-item elev-1 cursor-pointer rounded-xl border bg-panel-2 p-3 " +
                        (activeStore === i ? "active border-mint bg-mint/[0.07]"
                          : selectedStore && sameChain(s) ? "same-chain border-mint/50 bg-mint/[0.03]"
                            : n > 0 ? "border-alert/40 hover:border-alert/70" : "border-line hover:border-mint/40")}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="store-name truncate text-sm font-semibold">
                          <span className="store-num tnum text-mint">{pos + 1}.</span> {s.name}
                        </span>
                        <span className="tnum ml-auto shrink-0 text-[11px] text-fog">{s.distanceMiles.toFixed(1)} mi</span>
                      </div>
                      {s.address && <p className="mt-0.5 truncate text-[11px] text-fog">{s.address}</p>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {s.independent && (
                          <span className="store-local rounded-full border border-line px-1.5 py-px tnum text-[10px] uppercase tracking-wider text-fog"
                                title="Not part of a chain we can match against recall notices">
                            local
                          </span>
                        )}
                        <p className={"tnum text-[11px] " +
                          (activeStore === i || (selectedStore && sameChain(s)) ? "text-mint"
                            : n > 0 ? "text-alert" : "text-subtle")}>
                          {activeStore === i
                            ? (sideBySide && isWide ? "showing its recalls →" : "showing its recalls below ↓")
                            : selectedStore && sameChain(s)
                              ? "same chain — included above"
                              : n > 0
                                ? `${n === 1 ? "1 recall names" : `${n} recalls name`} this chain → tap`
                                : s.independent
                                  ? "independent — tap for area recalls"
                                  : "no recall names this chain"}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* ---- drag divider (desktop only) ---- */}
            {isWide && (
              <div
                id="split-handle"
                role="separator"
                aria-orientation={sideBySide ? "vertical" : "horizontal"}
                aria-label="Resize the lists"
                aria-valuenow={Math.round(splitPct)} aria-valuemin={MIN_SPLIT} aria-valuemax={MAX_SPLIT}
                tabIndex={0}
                onPointerDown={onSplitPointerDown}
                onPointerMove={onSplitPointerMove}
                onPointerUp={onSplitPointerUp}
                onPointerCancel={onSplitPointerUp}
                onDoubleClick={resetSplit}
                onKeyDown={onSplitKeyDown}
                className={"group flex shrink-0 items-center justify-center border-line bg-panel transition-colors hover:bg-mint/10 focus-visible:bg-mint/15 focus-visible:outline-none " +
                  (sideBySide ? "w-2 cursor-col-resize border-x" : "h-2 cursor-row-resize border-y")}
              >
                <span className={"rounded-full bg-line transition-colors group-hover:bg-mint/60 " +
                  (sideBySide ? "h-8 w-0.5" : "h-0.5 w-8")} />
              </div>
            )}

            {/* ---- products ---- */}
            <section className={showProducts + "min-h-0 flex-1 flex-col overflow-hidden " + (isWide ? "" : "border-t border-line")}>
              <PanelHeader
                label="recalls" countId="stat-recalls" count={productsBusy ? "…" : sorted.length}
                note={highCount > 0 && (
                  <span id="stat-high" className="tnum text-[11px] text-alert">{highCount} high-risk</span>
                )}
              >
                <span className="microlabel">sort</span>
                {[["newest", "newest"], ["risk", "risk"]].map(([k, lbl]) => (
                  <button key={k} type="button" onClick={() => { setSortBy(k); setLimit(25); }}
                          aria-pressed={sortBy === k}
                          className={"rounded-full border px-2 py-0.5 tnum text-[10px] uppercase tracking-wider transition-colors " +
                            (sortBy === k ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                    {lbl}
                  </button>
                ))}
              </PanelHeader>

              {/* scope + source filters */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
                {selectedStore ? (
                  <>
                    <button
                      id="btn-clear-store"
                      onClick={() => setActiveStore(-1)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-mint bg-mint/15 px-2.5 py-0.5 text-[11px] font-semibold text-mint hover:bg-mint/25"
                    >
                      <MapPin className="size-3" /> {truncate(selectedStore.name, 22)}
                      {activeChainStores.length > 1 && (
                        <span className="tnum text-[10px] opacity-80">
                          · {activeChainStores.length} locations
                        </span>
                      )}
                      <X className="size-3" />
                    </button>
                    <div id="store-scope" className="flex gap-1" role="group" aria-label="How this store relates to the recall">
                      {[
                        ["named", `names it · ${namedCount}`, namedCount === 0
                          ? "No notice names this store's chain"
                          : "Notices that name this chain by name"],
                        ["area", `in ${loc?.stateAbbr || "your area"} · ${recalls.length}`,
                          "Every notice covering your area — it names no retailer, so it could be on any shelf here"],
                      ].map(([k, lbl, title]) => (
                        <button key={k} type="button" title={title}
                                disabled={k === "named" && namedCount === 0}
                                onClick={() => { setStoreScope(k); setLimit(25); }}
                                aria-pressed={storeScope === k}
                                className={"rounded-full border px-2 py-0.5 tnum text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
                                  (storeScope === k ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="microlabel">all nearby stores</span>
                )}
                <div id="source-chips" className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Filter by source">
                  {sourceNames.map((name) => {
                    const on = activeSources.has(name);
                    return (
                      <button key={name} type="button" aria-pressed={on}
                        onClick={() => {
                          const next = new Set(activeSources);
                          on ? next.delete(name) : next.add(name);
                          setActiveSources(next); setLimit(25);
                        }}
                        className={"rounded-full border px-2 py-0.5 tnum text-[10px] uppercase tracking-wider transition-colors " +
                          (on ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="sunken min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {productsBusy && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <RecallSkeleton key={i} delay={i * stagger * 2} />)}</ul>
                )}
                {!productsBusy && recalls.length === 0 && (
                  <EmptyState icon={ShieldCheck} title="all clear — for now">
                    No active recalls matched this area in the past year.
                  </EmptyState>
                )}
                {!productsBusy && recalls.length > 0 && sorted.length === 0 && (
                  <EmptyState icon={selectedStore ? ShieldCheck : SearchX}
                              title={selectedStore ? "nothing names this store" : "no matches"}>
                    {selectedStore
                      ? `No active recall names ${selectedStore.name}. Most notices list only a state or "nationwide" and never name a retailer, so this is normal — switch to "in ${loc?.stateAbbr || "your area"}" to see all ${recalls.length} recalls that could reach this shelf.`
                      : "Nothing matches the current filters — clear the search box or re-enable a source."}
                  </EmptyState>
                )}

                <ul id="products-list" className="flex flex-col gap-2">
                  {sorted.slice(0, limit).map((r, i) => {
                    const cat = categoryFor(r);
                    const CatIcon = CATEGORY_ICONS[cat.key] || Package;
                    const nearby = nearbyStoresFor(r);
                    const linked = new Set(nearby.flatMap((si) => stores[si].chainIds));
                    const unlinked = (r.retailerIds || []).filter((id) => !linked.has(id));
                    return (
                      <li key={r.id} style={{ animationDelay: `${Math.min(i, 8) * stagger}ms` }}
                          className="recall-item fade-item elev-1 rounded-xl border border-line bg-panel-2 p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={r.severity}>{sevLabel(r)}</Badge>
                          <span className="tnum ml-auto text-[11px] text-fog">{fmtDate(r.date)}</span>
                        </div>
                        <div className="mt-2 flex items-start gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-mint/25 bg-mint/10"
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
                                className="inline-flex items-center gap-1 rounded-full border border-mint/40 bg-mint/10 px-2 py-0.5 text-[11px] font-semibold text-mint hover:bg-mint/20">
                                <MapPin className="size-3" /> {truncate(stores[si].name, 18)} · {stores[si].distanceMiles.toFixed(1)} mi
                              </button>
                            ))}
                            {unlinked.map((id) => byId(id)).filter(Boolean).map((c) => (
                              <Badge key={c.id} variant="chain">sold at {c.label}</Badge>
                            ))}
                          </div>
                        )}
                        {selectedStore && storeScope === "area" && !(r.retailerIds || []).length && (
                          <p className="mt-2 tnum text-[11px] text-subtle">
                            names no retailer — could be stocked anywhere in {regionLabel(r)}
                          </p>
                        )}

                        <div className="mt-2.5 flex items-center gap-3">
                          <a className="inline-flex items-center gap-1 text-[13px] font-semibold text-mint underline-offset-2 hover:underline"
                             href={r.url} target="_blank" rel="noopener noreferrer">
                            official notice <ExternalLink className="size-3" />
                          </a>
                          <details className="recall-details min-w-0 flex-1">
                            <summary className="cursor-pointer tnum text-[11px] text-fog hover:text-mint">details</summary>
                            <dl className="mt-1.5 flex flex-col gap-1 text-[11px] text-fog">
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">source</dt>
                                <dd>{r.source}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">type</dt>
                                <dd>{cat.label}</dd>
                              </div>
                              <div className="flex gap-2">
                                <dt className="microlabel shrink-0">region</dt>
                                <dd title={r.distribution || undefined}>{regionLabel(r)}</dd>
                              </div>
                              {r.firm && (
                                <div className="flex gap-2">
                                  <dt className="microlabel shrink-0">firm</dt>
                                  <dd className="[overflow-wrap:anywhere]">{r.firm}</dd>
                                </div>
                              )}
                              {r.codeInfo && (
                                <div className="flex gap-2">
                                  <dt className="microlabel shrink-0">lots</dt>
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
                  <Button id="btn-more" variant="outline" size="sm" className="mx-auto mt-3 flex" onClick={() => setLimit(limit + 25)}>
                    <Plus /> {Math.min(remaining, 25)} more ({remaining} left)
                  </Button>
                )}
              </div>
            </section>
            </div>
          </aside>
        )}
      </main>

      {/* ================= footer ================= */}
      <footer className="z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[11px] text-fog">
          <span className="font-semibold text-paper">Beta — no warranty.</span> Informational only, provided
          &ldquo;as is&rdquo;; verify every notice with the official source before acting on it.
        </p>
        <div className="flex items-center gap-2">
          {sources.map((s) => (
            <span key={s.name} title={s.ok ? `${s.name}: ${s.count} matching` : `${s.name}: ${s.error || "unavailable"}`}
                  className={"size-1.5 rounded-full " + (s.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
          ))}
          <button onClick={() => setAboutOpen(true)}
                  className="inline-flex items-center gap-1 tnum text-[11px] uppercase tracking-wider text-fog hover:text-mint">
            <Info className="size-3" /> about
          </button>
        </div>
      </footer>

      {/* DialKit authoring panel — renders null in production builds. */}
      <DialRoot position="bottom-left" theme="dark" defaultOpen={false} />

      {/* ================= about modal ================= */}
      {aboutOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 p-4 sm:items-center"
             onClick={() => setAboutOpen(false)} role="dialog" aria-modal="true" aria-label="About this data">
          <div className="fade-item max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-panel p-5 text-sm text-fog"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="microlabel text-paper">about this data</p>
              <button onClick={() => setAboutOpen(false)} aria-label="Close" className="text-fog hover:text-paper"><X className="size-4" /></button>
            </div>
            <p className="mt-3">
              RecallRadar aggregates public recall data from{" "}
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
              <span className="tnum text-[11px] uppercase tracking-wider">local</span> — never show a match.
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
            <p className="mt-3">Your location is only used to query the sources above — nothing is stored.</p>
            <div className="mt-4 rounded-xl border border-amber/40 bg-amber/[0.07] p-3.5">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-amber">
                Beta — no warranty, no liability
              </p>
              <p className="mt-1.5 text-xs leading-relaxed">
                RecallRadar is an early release provided <span className="text-paper">&ldquo;as is&rdquo;, without
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
                  <span className={"size-1.5 shrink-0 rounded-full " + (s.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
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
                  {diag?.busy ? <Loader2 className="animate-spin" /> : <Stethoscope />} check USDA now
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
                          <span className={"size-1.5 shrink-0 rounded-full " + (row.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
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
