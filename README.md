# 📡 RecallRadar

**Find out which stores near you sold recalled products — and which products to avoid.**

RecallRadar is a responsive, single-page web app. Give it your location (browser geolocation, a ZIP code, or an address) and it:

1. **Pulls active recall notices** affecting your area — nationwide recalls plus recalls distributed specifically to your state — from official government feeds:
   - [openFDA enforcement reports](https://open.fda.gov/apis/food/enforcement/) — FDA food, drug, and medical-device recalls
   - [USDA FSIS recall API](https://www.fsis.usda.gov/science-data/developer-resources/recall-api) — meat, poultry, and egg-product recalls
   - [CPSC recall API](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information) — consumer-product recalls
2. **Detects retail chains named in those notices** (Walmart, Costco, Trader Joe's, CVS, Home Depot, … ~90 chains) by scanning the recall text, distribution pattern, and CPSC "sold at" data.
3. **Finds real store locations of those chains near you** via the OpenStreetMap [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API), shows them on a Leaflet map with distances, and links each store to the recalls that name its chain.
4. **Lists every recalled product to avoid**, sorted by severity (FDA Class I / FSIS high-risk first), with search and per-source filtering, lot/code details, and links to the official notices.

Everything runs client-side against free, key-less public APIs. There is no server, no build step, no tracking — your location never leaves your browser except as query parameters to the public APIs above.

## Running it

It's a static site — serve the repo root with anything:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Or deploy the repo as-is to GitHub Pages, Netlify, Cloudflare Pages, etc.

> **Note:** browser geolocation requires a secure context (HTTPS or `localhost`). The ZIP/address search works everywhere.

## How the store matching works (and its limits)

Government recall data is product-centric, not store-centric. Recall notices name the **chains** that received recalled lots (e.g. "distributed to Costco stores in CA, OR, WA"), but no public feed tracks store-level inventory. RecallRadar therefore:

- treats a chain named in an active recall affecting your area as a signal, and
- shows that chain's locations within your chosen radius (5/10/25 miles) with the linked recalls,
- while being explicit in the UI that a specific store may never have stocked the recalled lot.

For USDA FSIS recalls, store-level *retail distribution lists* are often published as PDFs — the "Official notice" link on each recall card takes you there.

Recalls that don't name any known chain still appear in the **products to avoid** list, filtered to your state or nationwide distribution.

## Architecture

```
index.html          — single page, semantic sections
css/styles.css      — mobile-first, light/dark via prefers-color-scheme
js/states.js        — US state name/abbreviation tables
js/retailers.js     — chain dictionary + recall-text matcher (regex, word-bounded)
js/geo.js           — browser geolocation, Zippopotam ZIP + Nominatim geocoding, haversine
js/sources.js       — openFDA / FSIS / CPSC fetchers → one normalized recall shape
js/stores.js        — Overpass query builder (name/brand regex, with fallback mirror)
js/ui.js            — rendering (all external text HTML-escaped)
js/app.js           — orchestration + filters
```

Design notes:

- **Per-source resilience:** each feed is fetched with `Promise.allSettled`; a failed or CORS-blocked feed shows as "unavailable" in the Data sources panel instead of breaking the page. openFDA's "no results" 404 is treated as an empty set.
- **Politeness:** responses are cached in `sessionStorage` for 30 minutes; Overpass has a fallback mirror; Nominatim is only called once per search.
- **Severity model:** FDA Class I / FSIS High Risk → red, Class II / default → amber, Class III / low → gray.
- **Leaflet is optional:** if the map CDN is unreachable the map hides and the store list still works.

## Disclaimer

RecallRadar is an informational aggregator, **not an official source** and not affiliated with the FDA, USDA, CPSC, or any retailer. Always verify against the linked official notice. When in doubt, don't consume or use the product.

## License

MIT — see [LICENSE](LICENSE).
