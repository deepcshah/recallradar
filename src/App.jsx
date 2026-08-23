import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Armchair, Baby, Beef, Bike, Candy, Carrot, ChevronDown, Crosshair, CupSoda, ExternalLink,
  Fish, Info, Loader2, MapPin, MapPinOff, Milk, Package, PanelRightClose, PanelRightOpen,
  PawPrint, Pill, Plug, Plus, Radar, Search, SearchX, ShieldCheck, Soup, Stethoscope,
  UtensilsCrossed, Wheat, X, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import MapView from "@/components/MapView";
import { browserPosition, reverseGeocode, geocodeInput } from "@/lib/geo";
import { fetchAll } from "@/lib/sources";
import { findStores } from "@/lib/stores";
import { byId } from "@/lib/retailers";
import { categoryFor } from "@/lib/category";

const CATEGORY_ICONS = {
  pet: PawPrint, kids: Baby, supplement: Pill, drug: Pill, device: Stethoscope,
  electrical: Zap, appliance: Plug, home: Armchair, sports: Bike,
  meat: Beef, seafood: Fish, dairy: Milk, produce: Carrot, grains: Wheat,
  snacks: Candy, beverage: CupSoda, pantry: Soup, food: UtensilsCrossed, product: Package,
};

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

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function Bar({ w }) {
  return <div className="h-3 animate-pulse rounded-full bg-white/[0.07]" style={{ width: w }} />;
}

function RecallSkeleton({ delay = 0 }) {
  return (
    <li className="fade-item rounded-xl border border-line bg-panel-2 p-3.5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex gap-1.5">
        <div className="h-4 w-14 animate-pulse rounded-full bg-mint/10" />
        <div className="h-4 w-12 animate-pulse rounded-full bg-white/[0.07]" />
      </div>
      <div className="mt-3 flex flex-col gap-2"><Bar w="72%" /><Bar w="45%" /></div>
    </li>
  );
}

function StoreSkeleton({ delay = 0 }) {
  return (
    <li className="fade-item rounded-xl border border-line bg-panel-2 p-3" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2"><Bar w="55%" /></div>
      <div className="mt-2 flex gap-1.5"><div className="h-4 w-14 animate-pulse rounded-full bg-mint/10" /></div>
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
      <span id={countId} className="font-mono text-xs font-semibold text-mint">{count}</span>
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

  const [filterText, setFilterText] = useState("");
  const [category, setCategory] = useState("all");
  const [activeSources, setActiveSources] = useState(new Set());
  const [limit, setLimit] = useState(25);

  const mapRef = useRef(null);
  const storeItemRefs = useRef([]);

  const { byChain } = useMemo(() => chainsFor(recalls), [recalls]);

  const loadStores = useCallback(async (recallList, locArg, radiusArg, attempt = 0) => {
    const { chains: chainList } = chainsFor(recallList);
    setActiveStore(-1);
    if (!chainList.length) {
      setStores([]);
      setStoresStatus(recallList.length
        ? { empty: true, title: "no chains named", msg: "None of the active recalls here name a major retail chain — check the product list." }
        : null);
      return;
    }
    setStoresStatus({
      msg: attempt === 0
        ? `Locating ${chainList.length} affected chain${chainList.length === 1 ? "" : "s"}…`
        : "First attempt failed — retrying…",
      busy: true,
    });
    try {
      const found = await findStores(chainList, locArg, radiusArg);
      setStores(found);
      setStoresStatus(found.length ? null : {
        empty: true,
        title: "nothing in range",
        msg: "No locations of the affected chains within this radius — try a wider one.",
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

  /** Selecting a store is one action: focus its pin and scope the product list. */
  const selectStore = useCallback((i) => {
    setActiveStore((prev) => {
      const next = prev === i ? -1 : i;
      if (next >= 0) mapRef.current && mapRef.current.focusStore(next);
      return next;
    });
    setLimit(25);
  }, []);

  const onMarkerClick = useCallback((i) => {
    setActiveStore((prev) => (prev === i ? -1 : i));
    setLimit(25);
    setMobileTab("products");
    const el = storeItemRefs.current[i];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  useEffect(() => {
    mapRef.current && mapRef.current.resize();
  }, [listHidden, stores, mobileTab]);

  const categories = useMemo(() => {
    const m = new Map();
    for (const r of recalls) {
      const c = categoryFor(r);
      m.set(c.key, c.label);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [recalls]);

  const selectedStore = activeStore >= 0 ? stores[activeStore] : null;

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const chainScope = selectedStore ? new Set(selectedStore.chainIds) : null;
    return recalls.filter((r) => {
      if (!activeSources.has(r.source)) return false;
      if (category !== "all" && categoryFor(r).key !== category) return false;
      if (chainScope && !(r.retailerIds || []).some((id) => chainScope.has(id))) return false;
      if (!q) return true;
      return [r.product, r.firm, r.reason, r.distribution, r.source].join(" ").toLowerCase().includes(q);
    });
  }, [recalls, filterText, activeSources, category, selectedStore]);

  const highCount = filtered.filter((r) => r.severity === "high").length;
  const sourceNames = useMemo(() => [...new Set(recalls.map((r) => r.source))], [recalls]);
  const remaining = filtered.length - limit;

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

  function storeRecalls(store) {
    const seen = new Set();
    let n = 0;
    for (const id of store.chainIds) {
      for (const r of byChain.get(id) || []) if (!seen.has(r.id)) { seen.add(r.id); n++; }
    }
    return n;
  }

  const showStores = "flex " + (mobileTab === "stores" ? "" : "max-md:hidden ");
  const showProducts = "flex " + (mobileTab === "products" ? "" : "max-md:hidden ");

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-ink">
      {/* ================= top bar ================= */}
      <header className="z-20 shrink-0 border-b border-line bg-panel">
        <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4 md:flex-row md:flex-wrap md:items-center md:gap-x-4">
          {/* -- left: identity + product search / type filter -- */}
          <div className="flex min-w-0 items-center gap-2.5 md:flex-1">
            <span className="flex shrink-0 items-center gap-2">
              <Radar className="size-5 text-mint" />
              <span className="hidden text-base font-bold tracking-tight sm:inline">
                Recall<span className="text-mint">Radar</span>
              </span>
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
                className="h-9 appearance-none rounded-full border border-line bg-panel-2 pl-3.5 pr-8 font-mono text-[11px] uppercase tracking-wider text-fog focus-visible:border-mint/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
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
          </div>
        </div>

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
            <MapView ref={mapRef} loc={loc} stores={stores} onMarkerClick={onMarkerClick} />
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
                  Active FDA, USDA&nbsp;FSIS and CPSC recalls for your area — and the nearby stores of
                  the chains those notices name.
                </p>
                <Button className="mx-auto mt-4" onClick={useGeolocation}>
                  <Crosshair /> use my location
                </Button>
                <p className="microlabel mt-3">or enter a ZIP above</p>
              </div>
            </div>
          )}

          {storesStatus?.busy && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-ink/40">
              <span className="radar-ring" />
              <span className="radar-ring" style={{ animationDelay: "0.66s" }} />
              <span className="radar-ring" style={{ animationDelay: "1.33s" }} />
              <span className="radar-dot" />
              <p className="microlabel absolute bottom-6 text-mint">scanning area…</p>
            </div>
          )}

          {loc && (
            <Button
              id="btn-toggle-list" variant="secondary" size="sm"
              aria-pressed={!listHidden}
              onClick={() => setListHidden(!listHidden)}
              className="absolute left-3 top-3 z-10 hidden bg-panel/90 backdrop-blur md:inline-flex"
            >
              {listHidden ? <><PanelRightOpen /> show lists</> : <><PanelRightClose /> hide lists</>}
            </Button>
          )}
        </div>

        {/* -------- right panel: stores over products -------- */}
        {loc && !listHidden && (
          <aside id="stores-panel"
                 className="flex min-h-0 flex-1 flex-col border-t border-line bg-ink md:w-[26rem] md:flex-none md:border-l md:border-t-0">
            {/* mobile tab switch */}
            <div className="flex shrink-0 border-b border-line md:hidden" role="tablist">
              {[["stores", `stores · ${stores.length}`], ["products", `products · ${filtered.length}`]].map(([k, lbl]) => (
                <button key={k} role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)}
                        className={"flex-1 py-2.5 font-mono text-[11px] uppercase tracking-wider transition-colors " +
                          (mobileTab === k ? "border-b-2 border-mint text-mint" : "text-fog")}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* ---- stores ---- */}
            <section className={showStores + "min-h-0 flex-1 flex-col md:max-h-[42%] md:flex-none"}>
              <PanelHeader label="stores" countId="stat-stores" count={storesStatus?.busy ? "…" : stores.length}>
                <span className="microlabel">within</span>
                <div className="flex gap-1" role="group" aria-label="Store search radius">
                  {RADII.map((r) => (
                    <button key={r.value} type="button" onClick={() => onRadiusChange(r.value)}
                            aria-pressed={radius === r.value}
                            className={"rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors " +
                              (radius === r.value ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                      {r.label}
                    </button>
                  ))}
                  <span className="microlabel self-center">mi</span>
                </div>
              </PanelHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
                  <ul className="flex flex-col gap-2">{[0, 1, 2].map((i) => <StoreSkeleton key={i} delay={i * 90} />)}</ul>
                )}

                <ul id="stores-list" className="flex flex-col gap-2">
                  {stores.map((s, i) => (
                    <li
                      key={`${s.name}-${s.lat}-${s.lon}`}
                      ref={(el) => (storeItemRefs.current[i] = el)}
                      data-index={i}
                      style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                      onClick={() => selectStore(i)}
                      className={"store-item fade-item cursor-pointer rounded-xl border bg-panel-2 p-3 transition-colors " +
                        (activeStore === i ? "active border-mint bg-mint/[0.07]" : "border-line hover:border-mint/40")}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="store-name truncate text-sm font-semibold">
                          <span className="font-mono text-mint">{i + 1}.</span> {s.name}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-fog">{s.distanceMiles.toFixed(1)} mi</span>
                      </div>
                      {s.address && <p className="mt-0.5 truncate text-[11px] text-fog">{s.address}</p>}
                      <p className="mt-1.5 font-mono text-[11px] text-mint">
                        {activeStore === i ? "showing its recalls below ↓" : `${storeRecalls(s)} recall${storeRecalls(s) === 1 ? "" : "s"} → tap to filter`}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            {/* ---- products ---- */}
            <section className={showProducts + "min-h-0 flex-1 flex-col border-t border-line"}>
              <PanelHeader
                label="recalls" countId="stat-recalls" count={productsBusy ? "…" : filtered.length}
                note={highCount > 0 && (
                  <span id="stat-high" className="font-mono text-[11px] text-alert">{highCount} high-risk</span>
                )}
              />

              {/* scope + source filters */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
                {selectedStore ? (
                  <button
                    id="btn-clear-store"
                    onClick={() => setActiveStore(-1)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-mint bg-mint/15 px-2.5 py-0.5 text-[11px] font-semibold text-mint hover:bg-mint/25"
                  >
                    <MapPin className="size-3" /> {truncate(selectedStore.name, 22)} only <X className="size-3" />
                  </button>
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
                        className={"rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors " +
                          (on ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {productsBusy && (
                  <ul className="flex flex-col gap-2">{[0, 1, 2].map((i) => <RecallSkeleton key={i} delay={i * 90} />)}</ul>
                )}
                {!productsBusy && recalls.length === 0 && (
                  <EmptyState icon={ShieldCheck} title="all clear — for now">
                    No active recalls matched this area in the past year.
                  </EmptyState>
                )}
                {!productsBusy && recalls.length > 0 && filtered.length === 0 && (
                  <EmptyState icon={SearchX} title="no matches">
                    {selectedStore
                      ? `Nothing matches inside ${selectedStore.name} — clear the store filter or widen your search.`
                      : "Nothing matches the current filters — clear the search box or re-enable a source."}
                  </EmptyState>
                )}

                <ul id="products-list" className="flex flex-col gap-2">
                  {filtered.slice(0, limit).map((r, i) => {
                    const cat = categoryFor(r);
                    const CatIcon = CATEGORY_ICONS[cat.key] || Package;
                    const nearby = nearbyStoresFor(r);
                    const linked = new Set(nearby.flatMap((si) => stores[si].chainIds));
                    const unlinked = (r.retailerIds || []).filter((id) => !linked.has(id));
                    return (
                      <li key={r.id} style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                          className="recall-item fade-item rounded-xl border border-line bg-panel-2 p-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="source">{r.source}</Badge>
                          <Badge variant={r.severity}>{sevLabel(r)}</Badge>
                          <span className="ml-auto font-mono text-[11px] text-fog">{fmtDate(r.date)}</span>
                        </div>
                        <div className="mt-2 flex items-start gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-mint/25 bg-mint/10"
                                title={cat.label} aria-label={cat.label}>
                            <CatIcon className="size-4 text-mint" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="microlabel">{cat.label}</p>
                            <p className="recall-product mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]">{truncate(r.product, 150)}</p>
                            {r.firm && <p className="mt-0.5 text-[11px] text-fog">recalled by {r.firm}</p>}
                          </div>
                          {r.image && (
                            <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer"
                                 className="size-14 shrink-0 rounded-lg border border-line bg-panel object-cover"
                                 onError={(e) => { e.currentTarget.style.display = "none"; }} />
                          )}
                        </div>
                        {r.reason && <p className="mt-2 text-[13px] leading-relaxed text-paper/90 [overflow-wrap:anywhere]">{truncate(r.reason, 220)}</p>}

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

                        <div className="mt-2.5 flex items-center gap-3">
                          <a className="inline-flex items-center gap-1 text-[13px] font-semibold text-mint underline-offset-2 hover:underline"
                             href={r.url} target="_blank" rel="noopener noreferrer">
                            official notice <ExternalLink className="size-3" />
                          </a>
                          {r.codeInfo && (
                            <details className="min-w-0">
                              <summary className="cursor-pointer font-mono text-[11px] text-fog hover:text-mint">lot codes</summary>
                              <p className="mt-1 text-[11px] text-fog [overflow-wrap:anywhere]">{truncate(r.codeInfo, 500)}</p>
                            </details>
                          )}
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
          </aside>
        )}
      </main>

      {/* ================= footer ================= */}
      <footer className="z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 py-1.5">
        <p className="min-w-0 flex-1 truncate text-[11px] text-fog">
          Informational only — a named chain received recalled lots; this store may never have stocked them.
        </p>
        <div className="flex items-center gap-2">
          {sources.map((s) => (
            <span key={s.name} title={s.ok ? `${s.name}: ${s.count} matching` : `${s.name}: ${s.error || "unavailable"}`}
                  className={"size-1.5 rounded-full " + (s.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
          ))}
          <button onClick={() => setAboutOpen(true)}
                  className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-fog hover:text-mint">
            <Info className="size-3" /> about
          </button>
        </div>
      </footer>

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
            <p className="mt-3">Your location is only used to query the sources above — nothing is stored.</p>
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {sources.map((s) => (
                <li key={s.name} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className={"size-1.5 shrink-0 rounded-full " + (s.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
                  <span>{s.name}</span>
                  <span className="ml-auto font-mono text-[11px]">
                    {s.ok ? `${s.count} matching` : `unavailable (${s.error || "error"})`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
