# 📡 Yanked

**Find out which stores near you sold recalled products — and which products to avoid.**

Live at [yanked.app](https://yanked.app). Yanked is a responsive, single-page web app. Give it your location (browser geolocation, a ZIP code, or an address) and it:

1. **Pulls active recall notices** affecting your area — nationwide recalls plus recalls distributed specifically to your state — from official government feeds:
   - [openFDA enforcement reports](https://open.fda.gov/apis/food/enforcement/) — FDA food, drug, and medical-device recalls
   - [USDA FSIS recall API](https://www.fsis.usda.gov/science-data/developer-resources/recall-api) — meat, poultry, and egg-product recalls
   - [CPSC recall API](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information) — consumer-product recalls
2. **Detects retail chains named in those notices** (Walmart, Costco, Trader Joe's, CVS, Home Depot, … ~90 chains) by scanning the recall text, distribution pattern, and CPSC "sold at" data.
3. **Finds real store locations of those chains near you** via Mapbox Search (proxied through `/api/stores`, which holds the token and caches results), and shows them on a dynamic [MapLibre GL](https://maplibre.org/) vector map with CARTO's keyless basemap — numbered pins synced two-way with a store list that sits beside the map on desktop and under it on a phone. Both dividers drag: the one between the two lists on desktop, and the one between the map and the panel on a phone. The lists can be hidden for a full-screen map at any size.
4. **Lists every recalled product to avoid**, newest first (or by risk), with a free-text search and one **Filters** control covering reason for recall, product type, source and sort. Reason for recall — undeclared allergen, Listeria, fire hazard, and so on — is inferred from the notice's own text, since no feed publishes a hazard code comparable across all three agencies. Filter counts are computed against every other filter already on, including a selected store, so a chip never promises results it cannot deliver. Cards carry lot/code details and a link to the official notice.

   On a phone the two lists are tabs, and picking a store takes you to its recalls rather than silently re-scoping a list you cannot see. The selected store gets its own bar above the tabs — visible from both of them — a rail down the side of its card, and an enlarged, labelled map pin while the rest dim.

Everything runs client-side against free, key-less public APIs. There is no server, no build step, no tracking — your location never leaves your browser except as query parameters to the public APIs above.

## Running it

A Vite app with Vercel serverless functions under `api/`:

```bash
npm install
npm run dev      # http://localhost:5173 (the /api routes need `vercel dev`)
npm run build    # → dist/
```

> **Note:** browser geolocation requires a secure context (HTTPS or `localhost`). The ZIP/address search works everywhere. `vercel.json` sets `Strict-Transport-Security`, so once a browser has loaded the site over HTTPS it will not try plain HTTP again.

## How the store matching works (and its limits)

Government recall data is product-centric, not store-centric. Recall notices name the **chains** that received recalled lots (e.g. "distributed to Costco stores in CA, OR, WA"), but no public feed tracks store-level inventory. Yanked therefore:

- treats a chain named in an active recall affecting your area as a signal, and
- shows that chain's locations within your chosen radius (5/10/25 miles) with the linked recalls,
- while being explicit in the UI that a specific store may never have stocked the recalled lot.

For USDA FSIS recalls, store-level *retail distribution lists* are often published as PDFs — the "Official notice" link on each recall card takes you there.

Recalls that don't name any known chain still appear in the **products to avoid** list, filtered to your state or nationwide distribution.

## Architecture

```
index.html                      — shell; applies the stored theme before first paint
src/index.css                   — design tokens, light/dark, chips, map pins, motion
src/App.jsx                     — layout, state, filtering, both draggable dividers
src/components/MapView.jsx      — MapLibre map, markers, selection painting
src/components/FilterSheet.jsx  — the one filter surface: sheet on a phone, popover at md+
src/components/ui/              — button, badge, input
src/lib/states.js               — US state name/abbreviation tables
src/lib/retailers.js            — chain dictionary + recall-text matcher (regex, word-bounded)
src/lib/geo.js                  — browser geolocation, Zippopotam ZIP + Nominatim geocoding, haversine
src/lib/sources.js              — openFDA / FSIS / CPSC fetchers → one normalized recall shape
src/lib/stores.js               — store lookup + dedupe against the chain dictionary
src/lib/category.js             — what kind of product it is (icon + type filter)
src/lib/reason.js               — why it was recalled (hazard label + reason filter)
src/lib/theme.js, tuning.js     — light/dark, and the DialKit-tunable motion constants
api/                            — Vercel functions: recalls, stores, per-feed proxies, diagnostics
```

Design notes:

- **Per-source resilience:** each feed is fetched with `Promise.allSettled`; a failed or CORS-blocked feed shows as "unavailable" in the Data sources panel instead of breaking the page. openFDA's "no results" 404 is treated as an empty set.
- **Politeness:** responses are cached in `sessionStorage` for 30 minutes; Nominatim is only called once per search.
- **Touch targets:** every small toggle shares one `.chip` class that is 36px tall on touch and 26px where a mouse is pointing. The type in them stays at 11px — a chip is a label; the box around it is what a thumb has to hit.
- **Severity model:** FDA Class I / FSIS High Risk → red, Class II / default → amber, Class III / low → gray. The classification badge is the *only* place warm colour appears — a store is never coloured as a hazard.
- **Neutral stance on stores:** a store shows up because a notice names its chain, which is a name match and not a verdict on the store. Most independents can never match at all, so a store with no match gets neutral grey rather than an all-clear. Matched stores and pins are green (the highlight colour), never red.
- **Palette:** Shopify's grey/black ramp for structure, a green ramp for actions and highlights. Accent tints are solid tokens (`--rr-accent-soft`) rather than alpha washes, which bleach out on a white ground in light mode.
- **The map is optional:** if the vector style fails to load, the map falls back to raster CARTO tiles; the store list works either way. The basemap follows the app theme — see `MAP_STYLE` in `src/components/MapView.jsx`.

## Disclaimer

Yanked is an informational aggregator, **not an official source** and not affiliated with the FDA, USDA, CPSC, or any retailer. Always verify against the linked official notice. When in doubt, don't consume or use the product.

## License

MIT — see [LICENSE](LICENSE).
