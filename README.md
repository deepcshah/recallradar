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

## Analytics, and what is deliberately not measured

Three things run: Vercel Web Analytics and Speed Insights, which need no code beyond the two components mounted in `src/main.jsx` and are switched on per-project in the Vercel dashboard, and PostHog, which is configured in `src/lib/analytics.js`.

PostHog is loaded as its own chunk rather than imported into the main bundle. It is about 90kB gzipped — two thirds the size of everything else on the page put together — and this is an app whose entire job is to answer one question quickly, so paying that on the critical path would show up directly in the Speed Insights numbers sitting next to it. The import fires immediately rather than on idle, so the request goes out in parallel with the app's own boot; events raised before it lands are queued, which is what keeps a scan opened straight off a cold load from vanishing.

Requests go to `/ingest` on this domain, rewritten to PostHog at the edge in `vercel.json`. Ad blockers drop requests to `posthog.com` outright, and they drop them for a slice of the audience that skews technical — the bias is invisible in the resulting numbers, which is what makes it worth a rewrite rule.

**What is never sent.** This app knows where its user is standing, and that is the most sensitive thing it holds. No coordinates leave the browser at any precision, and neither does the ZIP or address typed into the box, the city geocoding resolved it to, or the name or address of any nearby store. What goes instead is the two-letter state — the granularity the recall feeds are themselves scoped to, and the coarsest thing that still answers "is this working outside California?" Everything else is a count or an outcome word.

Scanned barcodes *are* sent, and the distinction is deliberate: a UPC identifies a product, not a person, and it is the only way to measure whether the coverage problem described below is actually biting in the field. `scan_completed` carries `notices_with_codes` alongside the result for the same reason the interface shows it — a miss against forty notices and a miss against nothing at all are not the same event.

Session replay is on with `maskAllInputs` and `maskTextSelector: "*"`, which greys out every string in the recording. That is a real cost to how readable a replay is, taken because the flow most worth watching is exactly the flow carrying someone's address. The comment in `src/lib/analytics.js` says precisely what to loosen, and what to mark `ph-no-capture` first, if that trade stops being worth it.

Keys go in `.env.example`. With none set, `initAnalytics()` returns immediately and posthog-js is never fetched — the app runs unmeasured rather than broken.

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
src/lib/blob.js                 — the Blob token, read from the RR_BLOB_-prefixed name
src/lib/theme.js, tuning.js     — light/dark, and the DialKit-tunable motion constants
api/                            — Vercel functions: recalls, stores, per-feed proxies, diagnostics
api/lookup.js                   — one product across openFDA, INCLUDING finished recalls
api/refresh-feeds.js            — daily cron: warm the FSIS and CPSC caches off the request path
scripts/refresh-feeds.mjs       — fetch the feeds from a GitHub runner and commit the snapshot
public/feeds/                   — the committed snapshots; machine-generated, see its README
```

Design notes:

- **Per-source resilience:** each feed is fetched with `Promise.allSettled`; one failure never breaks the page. openFDA's "no results" 404 is treated as an empty set.
- **Four tiers for USDA and CPSC, because one is not enough.** `https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json` is the documented endpoint, it is correct, and it takes no API key — it is served off the agency's own web host rather than from behind api.data.gov, so a 403 is not asking for a credential. It nonetheless refuses this app's serverless function much of the time, and CPSC's `saferproducts.gov` returns 180 days as one uncompressed document that regularly outruns the request budget. So the data is fetched from four places that fail independently: (1) a live server-side fetch with a few spaced retries; (2) a Vercel Blob copy, warmed daily by `api/refresh-feeds.js` **off** the request path, where a cron can afford to be patient; (3) a direct fetch from the user's own browser, which is a different client on a different network; and (4) a snapshot committed to `public/feeds/` by a GitHub Action. Each tier says how old it is, and the recall list names which one answered.
- **The fourth tier is the one that matters, and both sides read it.** Tiers 1–3 all ultimately need USDA to answer *this deployment* at some point; if it never does, they are empty together. `.github/workflows/refresh-feeds.yml` runs `scripts/refresh-feeds.mjs` on a GitHub runner four times a day — a different network with a different IP reputation — and commits the result, so the build ships with the data as a static asset needing no Blob store, no environment variable, and no cooperation from USDA at request time. The browser reads that snapshot over the CDN and the server reads its own copy off disk (`src/lib/snapshot.js`, the last tier of `feedWithFallback`) — without the server half, a deployment with refused egress and an unattached Blob store answers `/api/recalls` with "USDA FSIS: unavailable" while the data sits inside it.
- **A refresh job that cannot go red is a cron with a log file.** The first run of the Action was green and produced a snapshot holding one recall: USDA had answered 200, the fetch and commit both worked, and the feed was empty in every way that matters to a reader. Two things caused it. `slimFsis` gated everything on `field_active_notice === "true"`, one string comparison that all four tiers slim through, so when it stopped matching they all emptied together; it now admits recent closed notices too and the card labels them **Closed** rather than passing them off as live. And the script exited 0 if *either* feed was written, so a total USDA failure was green as long as CPSC turned up. Every feed is now required, has a floor, and is refused if it collapses against the copy already committed — the previous snapshot keeps serving and the run goes red. Each run publishes a summary table and a `feed-report` artifact carrying the raw upstream shape, because "USDA has one active recall" and "our filter stopped matching" look identical in a log and want opposite fixes.
- **The 403 was our own User-Agent.** Two commits had asserted opposite causes — `852c7d0` ("rejects clients without a browser user agent") and `4c0676c` ("an IP and TLS fingerprint decision, not a header one") — neither with a measurement. Measured at last, from one laptop, one IP, one sitting: curl is refused whatever headers it sends (including a full Chrome set over HTTP/2); a browser succeeds, in incognito too, so it is not a cookie; **Node succeeds with no headers and fails with `Yanked/1.0 (public recall aggregator; +https://yanked.app)`**. So part of the decision is the TLS/client fingerprint, which Node passes and curl does not — and with the client held fixed, the only thing separating 200 from 403 is our own User-Agent string.

  It is the *shape* of it. `Name/version (+url)` is the crawler idiom from the robots.txt era, and it is what bot-management products match to classify a self-identified bot. The app was refused for identifying honestly, in the format reserved for the kind of client it is not — one cached request per state per fifteen minutes against a documented JSON API published for software to consume. `FSIS_HEADER_SETS` is now a ladder of truthful identities walked in order: a bare product token (RFC 9110 §10.1.5), then no claim at all, then the exact request measured at 200. There is deliberately no browser rung; impersonating Chrome to a government API would be a lie, and the curl rows show it does not even work.
- **The experiment is still runnable from production**, because one unknown remains: the laptop above is a residential address, and whether Vercel's egress carries a second block on top of the User-Agent one has never been measured. `/api/diag?probe=feeds` fires the whole ladder plus the old crawler string and a browser control in parallel, and states its own conclusion — which rung answered, or that every truthful identity failed and the address is the remaining variable.
- **The Blob token is read from a prefixed name.** `@vercel/blob` looks for exactly one variable, `BLOB_READ_WRITE_TOKEN`. This project's store is attached with an `RR_BLOB_` prefix, so it exports `RR_BLOB_READ_WRITE_TOKEN` and the SDK never finds it. Nothing throws: every `head`/`put`/`list` here is wrapped in a catch that reads failure as "not cached yet", so an unfound token silently turns every cache into a permanent miss — feeds *and* the Mapbox store tiles, which is one Mapbox request per chain per visitor forever. `src/lib/blob.js` resolves the prefixed name (falling back to the unprefixed one) and passes it explicitly to every call; `/api/diag` reports which variable it actually found.
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
