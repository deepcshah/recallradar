import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Armchair, Baby, Beef, Bike, Candy, Carrot, Crosshair, CupSoda, ExternalLink, Fish,
  Loader2, MapPin, MapPinOff, Milk, Package, PawPrint, Pill, Plug, Plus, Radar,
  Search, SearchX, ShieldCheck, Soup, Stethoscope, UtensilsCrossed, Wheat, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  { value: 8047, label: "5 mi" },
  { value: 16093, label: "10 mi" },
  { value: 40234, label: "25 mi" },
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
    <li className="fade-item rounded-xl border border-line bg-panel-2 p-4" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-full bg-mint/10" />
        <div className="h-5 w-14 animate-pulse rounded-full bg-white/[0.07]" />
        <div className="ml-auto h-4 w-16 animate-pulse rounded bg-white/[0.05]" />
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <Bar w="72%" /><Bar w="45%" /><Bar w="58%" />
      </div>
    </li>
  );
}

function StoreSkeleton({ delay = 0 }) {
  return (
    <li className="fade-item rounded-xl border border-line bg-panel-2 p-3.5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2">
        <Bar w="55%" />
        <div className="ml-auto h-3 w-10 animate-pulse rounded bg-white/[0.05]" />
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-full bg-mint/10" />
        <div className="h-5 w-12 animate-pulse rounded-full bg-mint/10" />
      </div>
    </li>
  );
}

function EmptyState({ icon: Icon, label, title, children }) {
  return (
    <div className="fade-item flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-panel-2/50 px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-mint/30 bg-mint/10">
        <Icon className="size-5 text-mint" />
      </span>
      {label && <p className="microlabel mt-1">{label}</p>}
      <p className="font-semibold">{title}</p>
      <p className="max-w-md text-sm text-fog">{children}</p>
    </div>
  );
}

/** Top chains named in the given recalls, newest recall first (Overpass cap: 24). */
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
  const [activeStore, setActiveStore] = useState(-1);
  const [listHidden, setListHidden] = useState(false);

  const [filterText, setFilterText] = useState("");
  const [activeSources, setActiveSources] = useState(new Set());
  const [limit, setLimit] = useState(25);

  const mapRef = useRef(null);
  const storeItemRefs = useRef([]);

  const { chains, byChain } = useMemo(() => chainsFor(recalls), [recalls]);

  const loadStores = useCallback(async (recallList, locArg, radiusArg, attempt = 0) => {
    const { chains: chainList } = chainsFor(recallList);
    setActiveStore(-1);
    if (!chainList.length) {
      setStores([]);
      setStoresStatus(recallList.length
        ? { empty: true, title: "no chains named", msg: "None of the active recalls for your area name a major retail chain — check the product list below." }
        : null);
      return;
    }
    setStoresStatus({
      msg: attempt === 0
        ? `Searching for nearby locations of ${chainList.length} recalled-product chain${chainList.length === 1 ? "" : "s"}… first search can take ~15s`
        : "First attempt failed — retrying the store search…",
      busy: true,
    });
    try {
      const found = await findStores(chainList, locArg, radiusArg);
      setStores(found);
      setStoresStatus(found.length ? null : {
        empty: true,
        title: "nothing in range",
        msg: "No locations of the affected chains were found within this radius — try a larger one, and still check the product list below.",
      });
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 3000));
        return loadStores(recallList, locArg, radiusArg, 1);
      }
      setStores([]);
      setStoresStatus({
        msg: `Store lookup failed (${err.message}). The recalled-product list below is unaffected.`,
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
    setLocStatus(newLoc.state ? null : { msg: "Could not determine your US state — showing nationwide recalls only." });
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
      setLocStatus({ msg: `${err.message} — enter a ZIP code or address instead.`, error: true });
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

  function focusFromList(i) {
    setActiveStore(i);
    mapRef.current && mapRef.current.focusStore(i);
  }

  const onMarkerClick = useCallback((i) => {
    setActiveStore(i);
    const el = storeItemRefs.current[i];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  useEffect(() => {
    mapRef.current && mapRef.current.resize();
  }, [listHidden, stores]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return recalls.filter((r) => {
      if (!activeSources.has(r.source)) return false;
      if (!q) return true;
      return [r.product, r.firm, r.reason, r.distribution, r.source].join(" ").toLowerCase().includes(q);
    });
  }, [recalls, filterText, activeSources]);

  const highCount = recalls.filter((r) => r.severity === "high").length;
  const sourceNames = useMemo(() => [...new Set(recalls.map((r) => r.source))], [recalls]);
  const remaining = filtered.length - limit;

  // Nearest found store per chain (stores arrive sorted by distance), so each
  // recall can link straight to the closest place its chain has around you.
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

  function goToStore(i) {
    focusFromList(i);
    const el = document.getElementById("map");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function storeRecalls(store) {
    const seen = new Set();
    const list = [];
    for (const id of store.chainIds) {
      for (const r of byChain.get(id) || []) {
        if (!seen.has(r.id)) { seen.add(r.id); list.push(r); }
      }
    }
    return list;
  }

  return (
    <div className="min-h-screen">
      {/* ---------- header ---------- */}
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5">
          <div className="flex items-center gap-2.5">
            <Radar className="size-6 text-mint" />
            <span className="text-xl font-bold tracking-tight">
              Recall<span className="text-mint">Radar</span>
            </span>
          </div>
          <span className="microlabel hidden sm:block">recalled products near you</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-16">
        {/* ---------- locator ---------- */}
        <Card className="mt-8 border-mint/25">
          <CardContent className="p-6">
            <p className="microlabel mb-1.5">where should we check</p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Find recalled products <span className="text-mint">around you</span>.
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-fog">
              Active recall notices from FDA, USDA&nbsp;FSIS and CPSC, matched to your area — plus the
              nearby stores of the chains those notices name.
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button id="btn-geolocate" onClick={useGeolocation}>
                <Crosshair /> use my location
              </Button>
              <span className="microlabel text-center">or</span>
              <form id="form-search" onSubmit={onSearch} className="flex flex-1 gap-2">
                <Input
                  id="input-location"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ZIP code or address (e.g. 94103)"
                  aria-label="ZIP code or address"
                  required
                />
                <Button type="submit" variant="outline"><Search /> search</Button>
              </form>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {loc ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3.5 py-1 text-sm font-semibold text-mint">
                  <MapPin className="size-3.5" /> <span id="location-label">{loc.label}</span>
                </span>
              ) : <span />}
              <div className="flex items-center gap-2">
                <span className="microlabel">radius</span>
                <div className="flex gap-1.5" role="group" aria-label="Store search radius">
                  {RADII.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => onRadiusChange(r.value)}
                      aria-pressed={radius === r.value}
                      className={
                        "rounded-full border px-3 py-1 font-mono text-xs transition-colors " +
                        (radius === r.value
                          ? "border-mint bg-mint/15 text-mint"
                          : "border-line text-fog hover:border-mint/40 hover:text-paper")
                      }
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {locStatus && (
              <p id="locator-status" role="status" aria-live="polite"
                 className={"mt-3 flex items-center gap-2 text-sm " + (locStatus.error ? "text-alert" : "text-fog")}>
                {locStatus.busy && <Loader2 className="size-3.5 animate-spin" />}
                {locStatus.msg}
              </p>
            )}
          </CardContent>
        </Card>

        {loc && (
          <>
            {/* ---------- stats ---------- */}
            <div className="mt-4 grid grid-cols-3 gap-3">
              {[
                { id: "stat-recalls", n: productsBusy ? "…" : recalls.length, label: "active recalls in your area" },
                { id: "stat-high", n: productsBusy ? "…" : highCount, label: "high-risk (class I)", danger: highCount > 0 },
                { id: "stat-stores", n: storesStatus?.busy ? "…" : stores.length, label: "nearby stores flagged" },
              ].map((s) => (
                <Card key={s.id}>
                  <CardContent className="p-4 text-center sm:p-5">
                    <span id={s.id} className={"block text-3xl font-bold tracking-tight sm:text-4xl " + (s.danger ? "text-alert" : "text-paper")}>
                      {s.n}
                    </span>
                    <span className="microlabel mt-1 block normal-case tracking-normal sm:uppercase sm:tracking-[0.18em]">{s.label}</span>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* ---------- map + stores ---------- */}
            <Card className="mt-4">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="microlabel mb-1">store radar</p>
                    <h2 className="text-lg font-semibold tracking-tight">Stores linked to active recalls</h2>
                  </div>
                  <Button
                    id="btn-toggle-list" variant="secondary" size="sm"
                    aria-pressed={!listHidden}
                    onClick={() => setListHidden(!listHidden)}
                    className={stores.length ? "" : "invisible"}
                  >
                    {listHidden ? "show list" : "hide list"}
                  </Button>
                </div>
                <p className="mt-1 text-sm text-fog">
                  Chains named in recall notices for your area. A named chain received recalled lots —{" "}
                  <span className="text-paper">not necessarily this specific store</span>.
                </p>

                {storesStatus && !storesStatus.empty && (
                  <div id="stores-status" role="status" aria-live="polite"
                       className={"mt-3 flex flex-wrap items-center gap-2 text-sm " + (storesStatus.error ? "text-alert" : "text-fog")}>
                    {storesStatus.busy && <Loader2 className="size-3.5 animate-spin" />}
                    <span>{storesStatus.msg}</span>
                    {storesStatus.retry && (
                      <Button id="btn-retry-stores" variant="outline" size="sm" onClick={storesStatus.retry}>
                        retry
                      </Button>
                    )}
                  </div>
                )}

                {storesStatus?.empty && (
                  <div id="stores-status" role="status" className="mt-4">
                    <EmptyState icon={MapPinOff} label="store radar" title={storesStatus.title}>
                      {storesStatus.msg}
                    </EmptyState>
                  </div>
                )}

                <div id="map-layout" className="mt-4 flex flex-col gap-4 md:flex-row md:items-stretch">
                  <div className="relative min-w-0 flex-1">
                    <MapView ref={mapRef} loc={loc} stores={stores} onMarkerClick={onMarkerClick} />
                    {storesStatus?.busy && (
                      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-xl bg-ink/45">
                        <span className="radar-ring" />
                        <span className="radar-ring" style={{ animationDelay: "0.66s" }} />
                        <span className="radar-ring" style={{ animationDelay: "1.33s" }} />
                        <span className="radar-dot" />
                        <p className="microlabel absolute bottom-5 text-mint">scanning area…</p>
                      </div>
                    )}
                  </div>
                  {!listHidden && (
                    <div id="stores-panel" className="min-w-0 md:max-h-[520px] md:w-[340px] md:shrink-0 md:overflow-y-auto md:pr-0.5">
                      {storesStatus?.busy && !stores.length && (
                        <ul className="flex flex-col gap-2.5">
                          {[0, 1, 2, 3].map((i) => <StoreSkeleton key={i} delay={i * 90} />)}
                        </ul>
                      )}
                      <ul id="stores-list" className="flex flex-col gap-2.5">
                        {stores.map((s, i) => {
                          const rs = storeRecalls(s);
                          return (
                            <li
                              key={`${s.name}-${s.lat}-${s.lon}`}
                              ref={(el) => (storeItemRefs.current[i] = el)}
                              data-index={i}
                              style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                              onClick={(e) => { if (!e.target.closest("a, summary")) focusFromList(i); }}
                              className={
                                "store-item fade-item cursor-pointer rounded-xl border bg-panel-2 p-3.5 transition-colors " +
                                (activeStore === i ? "active border-mint" : "border-line hover:border-mint/40")
                              }
                            >
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <span className="store-name font-semibold">
                                  <span className="font-mono text-mint">{i + 1}.</span> {s.name}
                                </span>
                                <span className="ml-auto font-mono text-xs text-fog">{s.distanceMiles.toFixed(1)} mi</span>
                              </div>
                              {s.address && <p className="mt-0.5 text-xs text-fog">{s.address}</p>}
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {s.chainIds.map((id) => byId(id)).filter(Boolean).map((c) => (
                                  <Badge key={c.id} variant="chain">{c.label}</Badge>
                                ))}
                              </div>
                              <details className="mt-2 text-sm" onClick={(e) => e.stopPropagation()}>
                                <summary className="cursor-pointer font-mono text-xs text-mint">
                                  {rs.length} active recall{rs.length === 1 ? "" : "s"} → this chain
                                </summary>
                                <ul className="mt-1.5 flex flex-col gap-1 pl-1 text-xs text-fog">
                                  {rs.slice(0, 8).map((r) => (
                                    <li key={r.id} className="flex items-start gap-1.5">
                                      <Badge variant={r.severity}>{sevLabel(r)}</Badge>
                                      <span className="min-w-0">{truncate(r.product, 110)}{" "}
                                        <a className="text-mint underline-offset-2 hover:underline" href={r.url} target="_blank" rel="noopener noreferrer">notice</a>
                                      </span>
                                    </li>
                                  ))}
                                  {rs.length > 8 && <li>…and {rs.length - 8} more in the product list below.</li>}
                                </ul>
                              </details>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* ---------- products ---------- */}
            <Card className="mt-4">
              <CardContent className="p-5">
                <p className="microlabel mb-1">avoid list</p>
                <h2 className="text-lg font-semibold tracking-tight">Recalled products to avoid</h2>
                <p className="mt-1 text-sm text-fog">Distributed nationwide or specifically to your state · highest risk first.</p>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Input
                    id="filter-text"
                    type="search"
                    value={filterText}
                    onChange={(e) => { setFilterText(e.target.value); setLimit(25); }}
                    placeholder="filter (e.g. lettuce, listeria, batteries)…"
                    aria-label="Filter recalled products"
                    className="sm:max-w-xs"
                  />
                  <div id="source-chips" className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by source">
                    {sourceNames.map((name) => {
                      const on = activeSources.has(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            const next = new Set(activeSources);
                            on ? next.delete(name) : next.add(name);
                            setActiveSources(next);
                            setLimit(25);
                          }}
                          className={
                            "rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors " +
                            (on ? "border-mint bg-mint/15 text-mint" : "border-line text-fog hover:border-mint/40")
                          }
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {productsBusy && (
                  <div className="mt-4">
                    <p id="products-status" role="status" className="mb-3 flex items-center gap-2 text-sm text-fog">
                      <Loader2 className="size-3.5 animate-spin" /> Fetching active recalls from FDA, USDA and CPSC…
                    </p>
                    <ul className="flex flex-col gap-3">
                      {[0, 1, 2].map((i) => <RecallSkeleton key={i} delay={i * 90} />)}
                    </ul>
                  </div>
                )}

                {!productsBusy && recalls.length === 0 && (
                  <div className="mt-4">
                    <EmptyState icon={ShieldCheck} label="avoid list" title="all clear — for now">
                      No active recalls matched your area in the past year. If the data sources panel below shows a feed as
                      unavailable, some recalls may not be visible — check back shortly.
                    </EmptyState>
                  </div>
                )}

                {!productsBusy && recalls.length > 0 && filtered.length === 0 && (
                  <div className="mt-4">
                    <EmptyState icon={SearchX} label="avoid list" title="no matches">
                      Nothing matches the current filter — clear the search or re-enable a source chip above.
                    </EmptyState>
                  </div>
                )}

                <ul id="products-list" className="mt-4 flex flex-col gap-3">
                  {filtered.slice(0, limit).map((r, i) => {
                    const cat = categoryFor(r);
                    const CatIcon = CATEGORY_ICONS[cat.key] || Package;
                    const nearby = nearbyStoresFor(r);
                    const linkedStores = new Set(nearby.flatMap((si) => stores[si].chainIds));
                    const unlinkedChains = (r.retailerIds || []).filter((id) => !linkedStores.has(id));
                    return (
                    <li
                      key={r.id}
                      style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                      className="recall-item fade-item rounded-xl border border-line bg-panel-2 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="source">{r.source}</Badge>
                        <Badge variant={r.severity}>{sevLabel(r)}</Badge>
                        <Badge variant="scope">{r.scope === "nationwide" ? "nationwide" : "your state"}</Badge>
                        <span className="ml-auto font-mono text-xs text-fog">{fmtDate(r.date)}</span>
                      </div>
                      <div className="mt-2.5 flex items-start gap-3">
                        <span
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-mint/25 bg-mint/10"
                          title={cat.label} aria-label={cat.label}
                        >
                          <CatIcon className="size-4 text-mint" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="microlabel">{cat.label}</p>
                          <p className="recall-product mt-0.5 font-semibold [overflow-wrap:anywhere]">{truncate(r.product, 220)}</p>
                          {r.firm && <p className="mt-0.5 text-xs text-fog">recalled by {r.firm}</p>}
                          {r.reason && <p className="mt-1.5 text-sm text-paper/90 [overflow-wrap:anywhere]">{truncate(r.reason, 300)}</p>}
                        </div>
                        {r.image && (
                          <img
                            src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer"
                            className="hidden size-20 shrink-0 rounded-lg border border-line bg-panel object-cover sm:block"
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        )}
                      </div>
                      {(nearby.length > 0 || unlinkedChains.length > 0) && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {nearby.length > 0 && <span className="microlabel mr-0.5">near you →</span>}
                          {nearby.map((si) => (
                            <button
                              key={si} type="button" onClick={() => goToStore(si)}
                              className="inline-flex items-center gap-1 rounded-full border border-mint/40 bg-mint/10 px-2.5 py-0.5 text-[11px] font-semibold text-mint transition-colors hover:bg-mint/20"
                            >
                              <MapPin className="size-3" /> {stores[si].name} · {stores[si].distanceMiles.toFixed(1)} mi
                            </button>
                          ))}
                          {unlinkedChains.map((id) => byId(id)).filter(Boolean).map((c) => (
                            <Badge key={c.id} variant="chain">sold at {c.label}</Badge>
                          ))}
                        </div>
                      )}
                      {r.distribution && (
                        <p className="mt-2 font-mono text-[11px] text-fog [overflow-wrap:anywhere]">
                          DISTRIBUTION → {truncate(r.distribution, 240)}
                        </p>
                      )}
                      {r.codeInfo && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer font-mono text-xs text-mint">lot / code details</summary>
                          <p className="mt-1 text-xs text-fog [overflow-wrap:anywhere]">{truncate(r.codeInfo, 600)}</p>
                        </details>
                      )}
                      <p className="mt-2.5 text-sm">
                        <a className="inline-flex items-center gap-1 font-semibold text-mint underline-offset-2 hover:underline"
                           href={r.url} target="_blank" rel="noopener noreferrer">
                          official notice <ExternalLink className="size-3.5" />
                        </a>
                        {r.searchHint && <span className="ml-2 font-mono text-[11px] text-fog">recall # {r.searchHint}</span>}
                      </p>
                    </li>
                    );
                  })}
                </ul>

                {remaining > 0 && (
                  <Button id="btn-more" variant="outline" className="mx-auto mt-4 flex" onClick={() => setLimit(limit + 25)}>
                    <Plus /> show {Math.min(remaining, 25)} more ({remaining} remaining)
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* ---------- sources ---------- */}
            <Card className="mt-4">
              <CardContent className="p-5">
                <p className="microlabel mb-2">data sources</p>
                <ul id="sources-list" className="divide-y divide-line">
                  {sources.map((s) => (
                    <li key={s.name} className="flex items-center gap-2.5 py-2 text-sm">
                      <span className={"size-2 shrink-0 rounded-full " + (s.ok ? "bg-mint" : "bg-alert")} aria-hidden="true" />
                      <span>{s.name}</span>
                      <span className="ml-auto text-right font-mono text-xs text-fog">
                        {s.ok ? `${s.count} matching recall${s.count === 1 ? "" : "s"}` : `unavailable (${s.error || "error"})`}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </>
        )}

        {/* ---------- about ---------- */}
        <Card className="mt-4">
          <CardContent className="p-5 text-sm text-fog">
            <p className="microlabel mb-2 text-paper">about this data</p>
            <p>
              RecallRadar aggregates public recall data from{" "}
              <a className="text-mint hover:underline" href="https://open.fda.gov/apis/food/enforcement/" target="_blank" rel="noopener noreferrer">openFDA enforcement reports</a>{" "}
              (food, drugs, medical devices), the{" "}
              <a className="text-mint hover:underline" href="https://www.fsis.usda.gov/science-data/developer-resources/recall-api" target="_blank" rel="noopener noreferrer">USDA FSIS recall API</a>{" "}
              (meat, poultry, egg products) and the{" "}
              <a className="text-mint hover:underline" href="https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information" target="_blank" rel="noopener noreferrer">CPSC recall API</a>{" "}
              (consumer products). Store locations © <a className="text-mint hover:underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors.
            </p>
            <p className="mt-2.5">
              <span className="text-paper">This is an informational tool, not an official source.</span>{" "}
              Recall notices name the chains that received recalled lots, but no public feed tracks store-level inventory —
              a listed store may never have stocked the recalled lot. Always verify against the linked official notice; when
              in doubt, don't consume or use the product. For USDA recalls, store-level retail distribution lists are often
              published as PDFs from the official notice.
            </p>
            <p className="mt-2.5">Your location is only used to query the public APIs above — nothing is stored.</p>
          </CardContent>
        </Card>

        <p className="microlabel mt-8 text-center">
          recallradar · openFDA · USDA FSIS · CPSC · © openstreetmap © carto
        </p>
      </main>
    </div>
  );
}
