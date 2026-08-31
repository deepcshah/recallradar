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
5. **Scans a barcode** and checks it against the notices, with a typed fallback where there is no camera. See *Scanning, and why "no match" is not "safe"* below.

### One breakpoint, at 1024px

The whole information architecture switches once, at `lg`:

- **Below 1024** — a single column with a bottom bar (Near me · Recalls · Scan), a location chip that opens a sheet, and one overflow control for theme, sources and About. This is the phone architecture, and it is also the right one for an iPad in portrait: at 820px the two-column layout gave a 404px map beside a 416px panel and served neither.
- **1024 and up** — map and panel side by side, with a draggable boundary between them, the location form inline, and Scan as the header's primary action.

Touch-target sizing is keyed to `pointer: coarse`, not to width — an iPad is 820px wide *and* finger-driven, so viewport width is the wrong question to ask.

### One scope, two answers

One control at the top of the panel says how wide a net everything below is casting. It is labelled with its unit, because it sits a few hundred pixels above a bottom bar that also counts things:

```
RECALLS ⓘ  [ At a store near you · 12 ]  [ Anywhere in CA · 137 ]
```

| Scope | Recalls | Stores |
| --- | --- | --- |
| **At a store near you** | only notices naming a chain with a storefront near you | only those stores |
| **Anywhere in `ST`** | every active notice covering your area | every store nearby, chains and independents |

Both counts are recalls, and both respect whatever else is filtered — a chip says what turning it on would actually leave you with.

This replaced a three-chip control labelled *Named / All stores / All recalls*, which had two problems that fed each other. "Named" was internal vocabulary — a notice *names* a chain — and said neither by whom nor of what. And the three chips counted three different things (8 stores, 20 stores, 137 recalls) inside one segmented control, directly above a bottom bar counting "Near me 20" and "Recalls 137": two rows of numbers, different units, same digits, no stated subject. Two of the three also produced an identical recall list and differed only in whether the store column was on screen, which is a layout question wearing a filter's clothes. Store-list visibility now lives on the store list itself (a fold control on wide screens; on a phone the bottom bar already is it).

Independents can only ever be exposed at the area level — no notice will name one — so **Anywhere in `ST`** is the only scope in which one can honestly appear. The store list is always in distance order; whether a notice names a store is the scope control's job, not the sort's.

### Terms that explain themselves

"Class I" is the loudest thing on a recall card and the only word on it that is not English: an FDA term of art shaped exactly like an ordinal, so read cold it suggests *the first one*, or worse, *the mildest*. It means the opposite.

So the badge is a disclosure, not a label (`src/lib/classification.js`, `InfoTip` in `src/components/ui/tooltip.jsx`). On a mouse it opens on hover after the usual delay. On touch it opens on **tap** and stays until you tap away — never long-press, which is the OS's gesture, collides with selection and the context menu, and has no visible affordance. The affordance is a dotted underline on the term plus an `ⓘ`, both present before any interaction, and the trigger is a real button with `aria-expanded` sized to a full thumb even when the type inside it is 11px.

`Tooltip` (hover-only, `aria-describedby`, supplements a control that already names itself) and `InfoTip` (hover **and** tap, a disclosure on a term) are separate components on one placement engine, because the trigger has to change with the behaviour. Where an agency assigns no class at all — CPSC never does — the badge says "not classified" rather than inventing the "Medium risk" it used to print.

Everything runs client-side against free, key-less public APIs. There is no server, no build step, no tracking — your location never leaves your browser except as query parameters to the public APIs above.

## Running it

A Vite app with Vercel serverless functions under `api/`:

```bash
npm install
npm run dev      # http://localhost:5173 (the /api routes need `vercel dev`)
npm run build    # → dist/
```

> **Note:** browser geolocation requires a secure context (HTTPS or `localhost`). The ZIP/address search works everywhere.

### On HTTPS

Vercel already redirects `http` to `https` at the edge, but only *after* the plaintext request has gone out. `vercel.json` sends `Strict-Transport-Security`, which closes that first request: once a browser has seen the header it rewrites `http://` to `https://` itself, before anything leaves the machine. Two years, `includeSubDomains`, and deliberately no `preload` — that submits the domain to a list baked into browser binaries and is slow to undo, which is the wrong commitment for a beta.

`vercel.json` carries a `$schema` line so an editor validates it in place. The headers array is strict: each entry takes `key` and `value` and nothing else, so there is nowhere to leave a comment — which is why this note is here.

## Scanning, and why "no match" is not "safe"

No government feed publishes a barcode field. UPCs turn up inside free text — openFDA's `code_info` and `product_description`, FSIS's `field_product_items` — inconsistently, and CPSC consumer-product recalls have none at all. Coverage is therefore partial and cannot be measured from inside the app, which makes the empty result the dangerous one.

So the scanner refuses to let a miss look like a green tick. The clear state is grey and interrogative, never green; it never uses the word *safe*; it says how many notices even carried a barcode to compare against; and it runs a second lookup that includes recalls which have since ended.

`src/lib/upc.js` collapses UPC-A, UPC-E, EAN-13 and GTIN-14 to one key so a match is not missed on spelling alone, and verifies the GTIN check digit so a twelve-digit lot number is not read as a barcode. Decoding uses the platform `BarcodeDetector` where it exists and lazy-loads ZXing everywhere else (notably iOS Safari, which has never shipped it) — a separate chunk, so anyone who never scans never downloads it. [Open Food Facts](https://world.openfoodfacts.org) turns a barcode into a brand and product name, which is what makes near-miss matching possible at all, and supplies the product photo for FDA and FSIS notices, neither of which publishes one.

## Is it still recalled?

`/api/lookup?upc=…` (or `?q=…`) is the one endpoint that does **not** filter to active notices. Everywhere else the app asks openFDA for `status:"Ongoing"` and FSIS for `field_active_notice`, which is right for "what should I worry about near me" and wrong for the question people arrive with after seeing a headline. Under an ongoing-only query, a recall that has since been terminated and a recall we never had look identical — both absent.

`status` is openFDA's own lifecycle field (Ongoing / Completed / Terminated / Pending), so "resolved" is public data that was being filtered away rather than a gap in the feeds. This endpoint reports it, which turns silence into an answer.

## How the store matching works (and its limits)

Government recall data is product-centric, not store-centric. Recall notices name the **chains** that received recalled lots (e.g. "distributed to Costco stores in CA, OR, WA"), but no public feed tracks store-level inventory. Yanked therefore:

- treats a chain named in an active recall affecting your area as a signal, and
- shows that chain's locations within your chosen radius (5/10/25 miles) with the linked recalls,
- while being explicit in the UI that a specific store may never have stocked the recalled lot.

For USDA FSIS recalls, store-level *retail distribution lists* are often published as PDFs — the "Official notice" link on each recall card takes you there.

Recalls that don't name any known chain still appear in the **products to avoid** list, filtered to your state or nationwide distribution.

One more case matters, because it is the app's whole premise: a notice whose distribution reads *"Sold at Trader Joe's stores"* names a chain and no geography at all. That is not "somewhere else", it is unsaid — but it used to be dropped exactly like a notice naming three other states. `scopeFor` now returns a fourth answer, `unstated`, and such a notice is kept when its text names a chain we can put on a map (and shown as **Region not stated**, never flattened into "Nationwide"). openFDA has no way to query for "names no state", so one unconstrained page per kind is fetched alongside the state-scoped ones.

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
src/lib/upc.js                  — barcode normalization, extraction from notice text, matching
src/components/ScanSheet.jsx    — camera scanner, typed fallback, and the honest empty state
src/components/ui/tooltip.jsx   — hover Tooltip + tappable InfoTip, one placement engine
src/lib/classification.js       — what Class I/II/III and USDA's risk words actually mean
src/lib/feed-cache.js           — last-good copies of the feeds, in Vercel Blob
src/lib/theme.js, tuning.js     — light/dark, and the DialKit-tunable motion constants
api/                            — Vercel functions: recalls, stores, per-feed proxies, diagnostics
api/lookup.js                   — one product across openFDA, INCLUDING finished recalls
api/refresh-feeds.js            — daily cron: warm the FSIS and CPSC caches off the request path
```

Design notes:

- **Per-source resilience:** each feed is fetched with `Promise.allSettled`; one failure never breaks the page. openFDA's "no results" 404 is treated as an empty set.
- **USDA and CPSC are unreliable, and it is not the URL.** `https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json` is the documented endpoint and it is correct; USDA sits behind a WAF that scores datacenter egress and TLS fingerprints, so a serverless function gets a 403 where a laptop gets JSON (impersonating Chrome makes it worse — Node's handshake never matches the claim). CPSC's `saferproducts.gov` returns 180 days as one uncompressed document and regularly outruns the request budget. Both are handled the same way: a few spaced retries inside the request, every success written to Vercel Blob, a daily cron (`api/refresh-feeds.js`) warming those copies **off** the request path, and a fallback to the last good copy with an explicit "as of". The cache previously filled only when a live user request happened to succeed, which meant a deployment could run for weeks with USDA showing "unavailable" every single time. `BLOB_READ_WRITE_TOKEN` is what makes any of it work; `/api/diag?probe=feeds` says whether it is set.
- **A missing agency is a hole in the answer, not a status light.** When a feed is down or serving a saved copy, the recall list says so at the top, names what is missing from it, and says an empty list is not the same as no recalls — rather than leaving it to an amber dot in the desktop footer.
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
