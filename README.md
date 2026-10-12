# 📡 Yanked

**Find out whether the recall you heard about reached you — and which stores near you sold recalled products.**

Live at [yanked.app](https://yanked.app). Yanked is a responsive, single-page web app. It opens on **Home**: a search box over every FDA, USDA and CPSC recall of the last year, answered for your state, and a short digest of what is new near you (see *Home, and the question people arrive with* below). Neither needs a location to start. Give it one (browser geolocation, a ZIP code, or an address) and the rest of the app — the **Stores** and **Recalls** views, which were the whole app before Home — does the following:

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

- **Below 1024** — a single column. The header holds the logo, the location, the Alerts bell and one overflow control for theme, sources and About; there is no bottom bar. Home's search field carries the barcode button; the stores and full-list views have a back control and a Stores | Recalls switch. This is the phone architecture, and it is also the right one for an iPad in portrait: at 820px the two-column layout gave a 404px map beside a 416px panel and served neither.
- **1024 and up** — Home is a centred 640px column under the same four-item header. *Stores near you named in recalls* or *Browse all with filters* opens the map and panel side by side, with a draggable boundary between them, under a bar with the way back Home, the scope switch and the Stores / Recalls panel switches.

Touch-target sizing is keyed to `pointer: coarse`, not to width — an iPad is 820px wide *and* finger-driven, so viewport width is the wrong question to ask.

### Where you are: one button, one picker

There is exactly one place to set a location: the **location button** in the header (`LocationButton.jsx`) — `📍 New York, NY 10001 ▾`, or `📍 Set location` — the same element at every width. It opens one surface (`LocationPicker.jsx` on `ui/responsive-surface.jsx`): an anchored 360px popover under the button at `md` and up (iPad portrait included), a bottom sheet below that.

```
Your location
Only your state leaves this browser.
ZIP code or city  [ e.g. 10001 or Chicago, IL      → ]
⚠ We couldn't find ZIP 00000. Check the digits, or try a city and state.
⌖  Use my current location
📍 New York, NY 10001                         Current ✓
🕘 Chicago, IL 60601                          State: IL
─────────────────────────────
Forget this location   Remembered in this browser only.
```

- It never closes before the place resolves. A failed lookup keeps it open with the error **under the field** (never a strip across the page) and the text selected. Every error has a code (`GEO_ERRORS` in `src/lib/geo.js`: `empty`, `zip_invalid`, `zip_not_found`, `place_not_found`, `no_state`, `network`, `geo_denied`, `geo_unavailable`, `geo_unsupported`) and a sentence with a next step; a place with no US state is refused rather than set.
- "Use my current location" is the first row, and the only thing that can trigger the browser's permission prompt. Nothing asks on load. The row is hidden where geolocation cannot work (no API, insecure context).
- The last three places are kept as recents (`rr-recent-locs`); *Forget this location* clears them too.
- Every other "set a location" in the app — a search card's *Check your state*, the digest, the Stores tab, alerts, the scope switch — opens this same picker, with a one-line reason ("Needed to find stores near you.").
- Esc, the scrim or a click outside closes it; focus is trapped while open and returns to the button.

### Three levels of scope

**1. Near me · `ST` │ All US** — the global switch beside the location button (`ScopeSwitch.jsx`, a radio group: one Tab stop, arrow keys). It decides what Home (digest, aisles, follows), the Recalls list and the counts are about:

| | Near me · `ST` | All US |
| --- | --- | --- |
| List | the live area list (`/api/recalls?state&abbr`) | the live national list (`/api/recalls?scope=us`), fetched the first time it is needed |
| Fallback while loading / if it failed | the index through `recentFor` | the index through `recentForUs` (no area filter) |
| Digest | "This week in NY: 14 new recalls · 3 serious" | "This week in the US: 61 new recalls · 9 serious" |
| Recalls panel | the store scope row (below) | a banner — "All US · 1,204 recalls · each card shows where it went" — plus *Only ones that reached NY*, which is simply Near me |

All US means **every** recall, not the old no-location meaning of "nationwide-distribution notices only" — which silently left out a recall sent to eight states. Search is national in both modes; the switch changes only its framing (verdict groups in Near me, one flat "3 recalls across the US" list in All US), and every card keeps its verdict for your state either way. Near me needs a state: with no location it opens the picker instead of switching.

Defaults: All US on a first visit; Near me the moment a location is set or changed; All US after *Forget*; otherwise whatever was last chosen (`rr-scope`). `?scope=us` (or `near` / `local`) in the URL wins on load and is written back with `replaceState`, so `?scope=us` is a shareable "all US" link; `?scope=near` without a location falls back to All US and does not pop the picker.

**2. The store scope, in Near me.** One control at the top of the panel:

```
ⓘ  [ At a store near you · 12 ]  [ All in CA · 137 ]
```

| Scope | Recalls | Stores |
| --- | --- | --- |
| **At a store near you** | only notices naming a chain with a storefront near you | only those stores |
| **All in `ST`** | every active notice covering your area | every store nearby, chains and independents |

Both counts are recalls, and both respect whatever else is filtered. Independents can only ever be exposed at the area level — no notice will name one — so **All in `ST`** is the only scope in which one can honestly appear. The store list is always in distance order.

**3. A selected store** overrides both: it always lists area recalls that name its chain, whatever the global switch says — a Texas-only recall naming Target does not concern the Target on 34th St. Stores themselves are local in both modes; in All US the store list says "Stores are matched to recalls that reach NY."

Push alerts stay per state in both modes.

### Freshness, said out loud

Every answer that could read as "not here" carries a quiet date line (`FreshnessLine.jsx`, from `freshnessOf` in `search-index.js`): "Data: FDA as of Sep 24 · USDA Sep 27 · CPSC Sep 25", with an amber dot on a stale agency. It sits at the bottom of the digest, under the Recalls list (plus "FDA: the newest notices only, back to …" when `/api/recalls` reports `truncated`), in every empty search, and inside every "Not reported in …" card. When the list on screen has no FDA records and FDA's date is unknown or stale, it says so: "FDA recalls aren't in this list yet … Search still checks FDA directly."

### Terms that explain themselves

"Class I" is the loudest thing on a recall card and the only word on it that is not English: an FDA term of art shaped exactly like an ordinal, so read cold it suggests *the first one*, or worse, *the mildest*. It means the opposite.

So the badge is a disclosure, not a label (`src/lib/classification.js`, `InfoTip` in `src/components/ui/tooltip.jsx`). On a mouse it opens on hover after the usual delay. On touch it opens on **tap** and stays until you tap away — never long-press, which is the OS's gesture, collides with selection and the context menu, and has no visible affordance. The affordance is a dotted underline on the term plus an `ⓘ`, both present before any interaction, and the trigger is a real button with `aria-expanded` sized to a full thumb even when the type inside it is 11px.

`Tooltip` (hover-only, `aria-describedby`, supplements a control that already names itself) and `InfoTip` (hover **and** tap, a disclosure on a term) are separate components on one placement engine, because the trigger has to change with the behaviour. Where an agency assigns no class at all — CPSC never does — the badge says "not classified" rather than inventing the "Medium risk" it used to print.

The recall data comes from free, key-less public APIs. Your location is remembered in your own browser (`localStorage`, so a return visit opens straight onto it; the location picker has *Forget this location*, which also clears recent places), and it leaves the browser only as query parameters to those APIs and to the store lookup — analytics gets the two-letter state and nothing finer, and alerts (only if you turn a channel on) store the state, your follows and — for email — your address, never coordinates. See *Alerts* below.

## Home, and the question people arrive with

The map-first app answered "what reached the shops around me?". People mostly arrive with the opposite question: they saw a headline about a sausage and want to know whether it is *their* sausage. So the landing view is now Home, one column at every width:

1. **Is it recalled?** (`src/components/RecallSearch.jsx`) — one field, with a barcode button inside it that opens the scanner. It searches the national index (below) as you type and, while there is a query, replaces the list under it with compact rows: what is wrong with what, the answer for your state as one short line ("Not reported in New York", "Distributed in New York", "Region not stated", "Announced, not yet classified", "Ended"), and the firm and date. No location needed: without one, each row says where the notice sent the product ("Sent to IL, IN, IA …"). The empty result still says what was checked.
2. **Latest recalls** (`src/components/LatestRecalls.jsx`, rows in `RecallRow.jsx`) — newest first by the day the agency published the notice (`posted || date`), with the Near me · `ST` | All US switch on the list it scopes. Each row is the plain headline (`plainHeadline` in `digest.js`), one muted line ("Listeria · Oct 8 · In NY"), and a text badge only for a serious recall ("Serious": Class I / USDA high) or a dashed "Announced" for an FDA announcement not yet classified. It reads the live list for the scope when there is one and falls back to the index — never mixing the two — and says how many are active and the oldest agency date it read, with the per-agency freshness line under the list. Twenty at a time.
   **Category pills** sit under the search box — All · Food · Meat & poultry · Drugs · Medical devices · Products (`src/lib/primary-category.js`: FDA Food → Food, USDA FSIS → Meat & poultry, FDA Drug → Drugs, FDA Device → Medical devices, CPSC → Products, an FDA announcement by what it is about). One choice filters both the latest list and search results, each pill counts what is below it in the current scope, and the choice is kept in the URL as `?cat=`. A filter that hides every result says so ("11 recalls match “sugar”, none of them in Drugs") rather than looking like an empty search.

   **Image tiles** (`RecallThumb.jsx`) are text-first: the agency's own photo where there is one (CPSC, https on cpsc.gov only), otherwise a calm category tile — never stock or generated art. Open Food Facts photos appear only inside an opened recall that prints a barcode, fetched on open and captioned "Photo: Open Food Facts — the recalled lot may look different".
3. **Two quiet ways on** — *Stores near you named in recalls* (the map and store list) and *Browse all with filters* (the full list with the Filters sheet), then the data-sources line and the beta notice.

The header is four things at every width: the logo, the location (pin + state), the Alerts bell with its count, and the overflow (theme, sources, About). There is no bottom tab bar; the stores and full-list views carry their own back control, scope switch and (on a phone) a Stores | Recalls switch.

The map, store list and full recall list are mounted the first time one is opened and kept mounted after, so going Home and back keeps the selection, the scroll and the camera; the store lookup (one Mapbox request per chain) and MapLibre itself (about 800kB, its own chunk) are not paid for until then. The area recall list is still fetched as soon as there is a location, because the list and the scanner read it.

Any row — from Latest recalls, search, or Alerts — opens the same recall sheet: the full answer, the agency's distribution text quoted, the state map, follow, watch and share. A shared link (`/?r=<id>&st=`) opens it straight away, labelled *Shared with you*. The live area list and the index apply the same rule for when a USDA notice has ended (the 90-day rule below), so one recall gets one answer everywhere; if they still disagree — a live record cached before that rule — the index's reading wins in that sheet.

### The verdict: six answers, and none of them is "safe"

`src/lib/verdict.js` turns one notice and one state into one of six answers, with the notice's own words as evidence:

| Verdict | Headline | When |
| --- | --- | --- |
| `in_area` | Distributed in California / Distributed nationwide | the notice names your state, or says nationwide |
| `not_listed` | Not reported in California | it names states, and yours is not one |
| `unstated` | The notice doesn't say where it was sold | it names no geography at all |
| `ended` | This recall has ended | the agency has closed it — which wins over the rest |
| `needs_location` | Add your location to check your state | we do not know your state yet |
| `announced` | Announced, not yet classified | a company press release FDA has not classified yet, naming no place — the release has no distribution list, so it is shown in search but never counted as "in your area" (one that does name states gets the answers above, plus a note that it is an announcement) |

**"Not reported in your state" is deliberately not "doesn't affect you".** A distribution list is what the recalling firm told the agency it shipped. Distributors re-ship, people travel and shop across a border, and a chain's warehouse may serve three states the notice never names. So the answer says exactly what is known — "Sent to AZ, NM, TX. California isn't listed." — adds the caveat every time, and is grey, never green. The quoted distribution text (`evidence`) is on every opened card, with a state grid (`StateMap.jsx`) that fills what the notice names and outlines yours.

**"Unstated" is not "nationwide"**, for the reason given under the store matching section below: a notice that names a retailer and no place has said nothing about where, and inventing "everywhere" or "nowhere" would each be a claim the agency did not make. **"Ended" is not "gone"**: a closed recall can still be in a freezer, and the card says so.

An empty search is held to the scanner's rule: it lists each agency that was searched and how fresh our copy is, says outright when FDA could not be checked, and names what no source here covers (vehicles and car seats, boats, pesticides).

### Share cards

Every opened card can be shared. The link is `/r/<id>?st=CA`; `vercel.json` rewrites it to `api/share.js`, which answers crawlers with Open Graph tags and people with a redirect to `/?r=<id>&st=CA`. The preview image is `api/_lib/og.js` (served as `/api/share?format=png`), a 1200×630 PNG of the verdict rendered with `@vercel/og` from the same wording the card uses (`cardVerdict` in `src/lib/share.js`), so an unfurl in a group chat says "Not reported in California" and not just a product name. Opening the link lands on Home with that recall open, labelled *Shared with you*. The `st` is the sender's state: it answers for a reader the app knows nothing about yet, and a reader with a saved location gets their own state instead.

`@vercel/og` 1.0.3's Node build cannot be imported as shipped (it bundles a CommonJS loader that needs `require` and a `hb.wasm` it does not ship); `api/_lib/og.js` (served as `/api/share?format=png`) works around it and explains when the shim can go. If `/api/share?format=png` ever 500s in production, add `node_modules/harfbuzzjs/hb.wasm` to `includeFiles` — unfurls degrade to the text-only tags from `api/share.js` meanwhile, which are still accurate.

## Client data: one local database

Every list in the app — Home's *Latest recalls* (Near me and All US), search, the full Recalls view and its filters, the stores view's retailer matching, the Alerts inbox and a shared `?r=` link — reads **one dataset**: the browser's local copy of our recall database. There is no per-state fetch, no national fetch, no browser call to openFDA, USDA or CPSC, and the client no longer downloads `public/feeds/index.json`. Near me is that copy through `isInArea` (`src/lib/verdict.js`); All US is every active record in it. The one remaining live call is `/api/lookup`, asked only as a last resort when the local data has no strong match for a query (or holds no FDA data), and its rows are labelled *From FDA directly*.

**On the device** (`src/lib/local-db.js`, no dependencies). IndexedDB database `yanked-recalls` with two object stores: `meta` (the last applied manifest, `lastChecked`, `lastSynced`) and `chunks` (`{ key, hash, records, fetchedAt }`). Every call is wrapped; when IndexedDB is missing or fails (private windows, blocked site data, quota), the session switches to an in-memory store with the same interface and the app works the same, just without offline.

**The sync** (`src/lib/data-sync.js`), against the `/api/data` contract documented at the top of that file:

1. **Start**: read the stored manifest and chunks and render them straight away — `latest` first, so Home paints before the months are read back. Works offline.
2. **Check**: `GET /api/data?part=manifest` with `cache: "no-cache"` (the browser and CDN revalidate rather than serve a stale manifest). Compare each chunk's `hash` with the stored one.
3. **Fetch only what changed**: `latest` (last 30 days by news day) first, shown the moment it lands; then the other changed months in the background, newest first, three at a time, coalesced into a few re-renders. Chunk URLs carry `&h=<hash>`. A `404 {error:"stale"}` refetches the manifest once and retries with the hash it now names. Chunks the manifest no longer lists are deleted.
4. **Re-check** when the tab becomes visible and the last check is over five minutes old, and when the browser comes back online — never more than once a minute.

One sync runs at a time and can be aborted. Failures never clear data: the status becomes `offline` (no network) or `error` (a bad answer), and what is held stays on screen. State is `{ status: 'empty'|'cached'|'syncing'|'ready'|'offline'|'error', records, byId, manifest, sources, lastChecked, lastSynced }`; `records` is the union of all chunks, de-duplicated by id.

**What the reader sees.** A first-ever visit shows a skeleton until `latest` lands. A return visit renders the stored copy instantly, with a quiet *Updating…* only while a sync runs. Offline shows the stored copy with *Offline · last updated <time>*. The freshness line (*Data: FDA as of … · USDA … · CPSC …*) comes from the manifest's `sources` (`lastUpdated` for FDA, otherwise `syncedAt`), through `freshnessOf` — one database, one line.

**Cache headers relied on** (set by the server, `api/data.js`): the manifest must be revalidated (`max-age=0` for browsers, a short `s-maxage` at the CDN), and chunks must be `immutable` with a long `max-age`, since their URL includes their content hash. The client assumes a chunk URL never changes meaning.

**Analytics**: one `data_sync` event per sync — `status`, `chunks_fetched`, `bytes`, `ms`, `from_cache` — and nothing else (no ids, no location).

**Checks**: `node scripts/check-client-sync.mjs` runs the engine against a local HTTP server serving contract-shaped manifest and chunks built from the real committed `public/feeds/index.json`, with the in-memory store standing in for IndexedDB. It checks latest-first fetching, zero chunk fetches for an unchanged manifest, only the changed chunks after re-chunking the same real records, one manifest refetch on a stale 404, and that cached records survive a network failure. It does not check the deployed `/api/data`.

## The national index

Search needs every recall, not the ones scoped to one state, and it needs them faster than three agencies can answer. `public/feeds/index.json` is that: every FDA (food, drug, device), USDA FSIS and CPSC notice of the last 365 days, ended ones included, slimmed to what a card needs — with coverage (`nationwide` / `states` / `unstated`), category, reason and any UPCs worked out once at build time. It is built by `scripts/build-index.mjs`, which the refresh workflow runs after the feed snapshots, so it rides the same GitHub-runner tier as they do and is committed the same way.

It has tiers of its own, in the same spirit as the feeds:

1. **The committed index** is the source the database is built from. The browser no longer downloads it; it searches its local copy of the database (see *Client data* above) with MiniSearch (prefix + fuzzy, loaded as its own chunk; a query of six or more digits searches barcodes only).
2. **openFDA, live**, through `/api/lookup`, as a last resort when the local data has no FDA data or no strong match for the query — with "Checking FDA directly…" on screen while it runs, and "FDA couldn't be checked" rather than silence if it fails.
3. **The server's own copy**, read off disk by `src/lib/index-server.js` for the share cards and the push digest, falling back to the deployment's CDN.

An openFDA failure at build time keeps the previous FDA records and turns the workflow run red rather than committing an index with a hole in it. `index.json` records each source's `ok`, `count`, `fetchedAt` and `newest` (newest recall date), and the empty-search state reads them.

**Freshness.** Our fetch time is not the data's date. openFDA stamps every response with `meta.last_updated` (it republishes enforcement weekly), and that is recorded as `sources.fda.lastUpdated` (and `lastUpdatedByKind`) in the index, per FDA source in `/api/recalls`, and in `/api/lookup`. `freshnessOf(index, recallsSources?)` in `src/lib/search-index.js` turns all of it into one `{source, asOf, kind: 'updated'|'fetched', stale}` per agency; thresholds are in `STALE_AFTER_DAYS` (FDA's own date: 10 days; our FDA fetch: 2; FSIS: 2; CPSC: 3, so a weekend is not "stale"). An unknown date is stale, never assumed fresh.

**Early FDA announcements.** A company's press release reaches FDA's [recalls RSS feed](https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml) the day it is issued; the openFDA enforcement record (class, distribution list) can follow weeks later — the weeks when the recall is in the news. The index build reads the last 60 days of that feed (a small dependency-free parser; a failure is recorded in `sources.fdaAnnouncements` and never fails the run) into records with `source: 'FDA announcement'`, `status: 'announced'`, `announcement: true`. Places are read only from sentences about distribution ("distributed to stores in…"), because a release opens with the firm's home town, which is not where the product went. An announcement is dropped once openFDA has an enforcement record from the same firm within 45 days of it.

**Ambiguous state codes.** openFDA's text search ignores case, so `distribution_pattern:"IN"` matches the word "in" — nearly every notice — and Indiana's own recalls were cut off by the page cap. For codes that are ordinary words in notices (IN, OR, ME, OK, HI; DE, LA, AL from firm and brand names; CO for "company"; ID for "identifier" — `AMBIGUOUS_STATE_ABBRS` in `src/lib/verdict.js`) the state query asks for the full name only, and the abbreviation is found by a deeper unscoped pass plus the case-sensitive `statesIn` (which, in all-caps text, only accepts those codes inside a list of states). Every FDA source in `/api/recalls` reports `truncated: true` and `oldest` when openFDA had more matches than were fetched, so the list can say "showing the newest N".

**USDA's "closed" flag is believed after 90 days.** In practice USDA marks most notices not-active within days of issuing them — the committed snapshot once had a three-day-old Class I pork recall flagged closed — and "This recall has ended" is a headline, not a footnote. So a USDA notice is called ended — in the index, the area list, the digest, share cards and push alike — only when the flag is false *and* the notice is over 90 days old (`FSIS_TRUST_CLOSED_DAYS` and `fsisStatus` in `src/lib/sources.js`). The area list also shows USDA's raw flag, as the **Closed** badge with its disclosure, which says only that USDA stopped tracking the notice.

## Data pipeline: the recall database

Recall data used to reach the app by five independent routes — the committed index, `/api/recalls` calling openFDA on every request with four fallback tiers for USDA and CPSC, `/api/recalls?scope=us`, `/api/lookup`, and the browser's own direct fetches — each with its own window, filter and freshness, so they disagreed with each other. The recall database replaces that with one source of truth: **our** Postgres database is the base of every recall, a scheduled sync builds into it, and clients read one endpoint, `/api/data`, cached at the edge and on the device.

```
agencies ──ingest──▶ raw_records ──normalize──▶ recalls ──derive──▶ recall_index ──publish──▶ published ──▶ GET /api/data
 (openFDA,            as received,               canonical,          category, reason,        manifest +
  FSIS, CPSC,         append-only,               one row per         search text —            chunks, served
  FDA RSS)            versioned                  recall              CLASSIFIER_VERSION       verbatim
                                     └──▶ recall_changes (status, states, coverage, class…)
```

**Why the layers are separate.** Each answers a different question and changes for a different reason. `raw_records` is what the agency actually said, stored as received (never slimmed), with a new version only when the payload changes and otherwise just a new `last_seen` — so any canonical row can be traced to the exact payload that produced it (`recalls.raw_hash`), and a normalizer bug can be fixed and replayed without refetching. `recalls` is the app's reading of the newest payload, made by the **existing** normalizers (`fdaToIndex`, `fsisToIndex` + `fsisStatus`/`fsisGeography`, `cpscToIndex`, `announcementToIndex` — shared with the index build, not forked), with text kept whole; trimming is a publishing concern. `recall_changes` records when a reader-relevant field moves (status, states, coverage, classification, severity, end date). `recall_index` is *derived*: category and reason from `classifyRecord` (the same function the index build uses), stamped with `CLASSIFIER_VERSION`. `published` holds the finished manifest and chunks, so the API never computes anything per request.

**Sync cadence.** `.github/workflows/sync-db.yml` runs every six hours (`:41`, off the snapshot job's `:17`), on demand, and on pushes to `main` that touch the pipeline. openFDA is incremental by report date (from the newest report date held, minus 21 days, because openFDA publishes weekly and backfills), with a full 365-day window on the first run and at least weekly — a recall's status changes to Terminated without its report date moving, so only a full window sees it. USDA FSIS (whole feed, through the existing identity ladder), CPSC (180-day window) and the FDA recalls RSS are read whole every run. The existing health rules apply unchanged: floors and collapse checks (`FDA_HEALTH`, refresh-feeds' `healthProblems`) refuse a collapsed fetch, and a publication that is empty or less than half the current one is refused too — the previous one keeps serving. Every run writes one `sync_runs` row per source and a summary table (`$GITHUB_STEP_SUMMARY`). Announcements are best-effort as before.

**Published windows** are the committed index's: FDA and CPSC by news day within 365 days, USDA active at any age or otherwise within 365 days, FDA announcements for 60 days minus those an openFDA record from the same firm already covers. The database itself keeps everything.

**Client contract** (`src/lib/publication.js`; format 1).

- `GET /api/data?part=manifest` → `{ format, generatedAt, dataVersion, classifierVersion, sources: { fda|fsis|cpsc|fdaAnnouncements: { ok, count, lastUpdated, newestPosted, syncedAt } }, chunks: [{ key, from, to, count, hash, bytes }], totals: { recalls, active } }`, `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`. `lastUpdated` is the agency's own date where it publishes one (openFDA's `meta.last_updated`); `syncedAt` is when the data was fetched from the agency.
- `GET /api/data?part=chunk&key=<key>&h=<hash>` → `{ format, key, hash, records }`, immutable for a year when `h` is current; `404 {error:"stale", current}` (60 s) when it is not. `latest` holds every record whose news day (`posted` or `date`) is within 30 days; `YYYY-MM` chunks hold the rest by month; each record is in exactly one chunk, newest chunk first. A chunk's hash is the sha256 of its records, so it changes only when its content does: a client keeps chunks forever by hash and on each visit downloads only the manifest and whatever moved.
- Records are exactly `public/feeds/index.json`'s `recalls[]` shape, so search and verdict code is unchanged. One optional field is new: `image`, the agency's own product photo — today only CPSC publishes one — carried raw → `recalls.image` → chunks only when it is https on the agency's own domain (`src/lib/official-image.js`). Nothing is ever substituted: no stock photos, no category art; absent means absent. The committed index carries it too.
- `X-Yanked-Data: postgres | committed-index` says where the answer came from. Until `DATABASE_URL` is configured — and if the database is unreachable or has never been published to — `/api/data` builds the identical format from the committed `public/feeds/index.json` (anchored on its `builtAt`, so every instance agrees on the hashes). Share links (`/r/:id`) resolve from `recalls` first when the database is configured, then the index, then openFDA.

**Owner setup.**

1. Create a Postgres database on [Neon](https://neon.tech) or [Supabase](https://supabase.com) (free tiers are ample: a year of recalls is tens of MB). Copy its connection string — on Supabase, the *transaction pooler* string (port 6543) for Vercel; the driver runs with `prepare: false`, which the pooler requires.
2. Vercel → Project → Settings → Environment Variables: `DATABASE_URL` for **Production** (and Preview if previews should read it).
3. GitHub → Settings → Secrets and variables → Actions: a repository secret `DATABASE_URL` (the direct, non-pooled string is fine here).
4. Run **Sync recall database** from the Actions tab (or wait for the schedule). The first run applies the migrations and backfills a year of openFDA plus the whole USDA, CPSC and RSS feeds — a few minutes. Until it has published once, `/api/data` keeps serving the committed index; `X-Yanked-Data` flips to `postgres` when it is live. To seed a database without the network, `node scripts/sync/run.mjs --from-snapshots` loads the committed snapshots (real data, labelled as snapshot runs with the snapshots' own fetch dates).
5. Without the secret the scheduled job still runs, as a labelled dry run into a throwaway PGlite database, with a warning — never silently.

**Re-deriving the index.** Change `src/lib/category.js`, `src/lib/reason.js` or `classifyRecord`, bump `CLASSIFIER_VERSION` in `scripts/sync/derive.mjs`, and the next sync re-derives every row from the stored canonical rows — nothing is refetched, `raw_records` and `recalls` are untouched — then republishes; only chunks whose records changed get new hashes. To do it immediately: `node scripts/sync/run.mjs --reindex`.

**Running it.** `node scripts/db/migrate.mjs` (idempotent; `db/schema.sql` is migration 0001, later ones go in `db/migrations/NNNN_name.sql`); `node scripts/sync/run.mjs [--dry-run] [--pglite <dir>] [--source fda|fsis|cpsc|announcements|all] [--from-snapshots] [--full] [--reindex] [--expect id,…]`. `--dry-run` uses a fresh in-memory [PGlite](https://pglite.dev) (real Postgres in WASM) and writes nothing anywhere, even with `DATABASE_URL` set. `src/lib/db.js` is the one adapter (`query`, `exec`, `tx`, `close`) over the `postgres` driver or PGlite; all SQL is portable between them.

**What verifies it.** `node scripts/check-db.mjs` runs the migrations and the whole pipeline into PGlite using only real data — the committed snapshots, an older committed `fsis.json` from git history (a real change of a USDA notice's states, recorded in `recall_changes`, with only the affected chunks re-hashed), and the recorded real openFDA records in `scripts/fixtures/` — and checks idempotency, the classifier-version bump, the contract, and `/api/data` in both modes. It cannot reach the agencies or a hosted Postgres. The live half is the workflow's `pull_request` job: on every PR touching the pipeline it syncs from the live agencies into a fresh PGlite database twice (full backfill, then incremental), writes nothing, and posts the summary — per-source counts, openFDA's `last_updated`, chunk sizes, and spot checks — as a PR comment.

The committed snapshot/index pipeline (`refresh-feeds.yml`) keeps running alongside until the database is confirmed live; it is also `/api/data`'s fallback.

## Alerts

People asked the obvious question: "what happens if I follow something?" It used to be: a chip on Home, and a push notification nobody could get because push was switched off in production. Alerts is now a destination of its own — the bell in the header at every width — opening one surface (`src/components/AlertsPanel.jsx` on `ui/responsive-surface.jsx`, the same popover-or-sheet the location picker uses). Top to bottom:

```
Alerts                                   What you follow, and what's new for it · NY
NEW FOR YOU                                                         Mark all read
  🔔 [Closed by the agency]  Listeria in … — The agency has closed this recall. …
  New for "cheese"   [Class I] Salmonella in Spicy Pimento Cheese Dip   Sep 23
YOU FOLLOW
  Recalls             🔔 Salmonella in Spicy Jalapeno Jarlsberg Dip        ✕
  Products & brands   [cheese ✕]   [ Add a product or brand ] [+ FOLLOW]
DELIVERY
  Notifications on this device   Not available yet. This site hasn't switched it on.
  Email                          [ you@example.com ] [Email me]
  Weekly digest for NY                                                  (on)
  Serious recalls in NY, straight away                                  (on)
```

### Two kinds of follow

- **Products and brands** (follow *terms*): short phrases — "spinach", "Trader Joe's" — kept in `localStorage` (`rr-follows`, `src/lib/follows.js`) and matched literally against product and firm names: every word must start a word, no fuzzy matching, and never the recall reason, so "milk" does not fire on every undeclared-milk allergen notice. A match counts when the notice reaches your state, or names no geography at all (a brand you buy, recalled with no distribution published, is exactly what a follow is for); a notice naming only other states does not (`followRelevant` in `src/lib/recall-watch.js`, shared by the app and the cron).
- **One specific recall** — *Notify me about updates* on every opened card (`VerdictCard`) and *Notify me* on every card in the Recalls list (`src/components/WatchButton.jsx`). Kept in `rr-follow-recalls` (at most 50) as the id, the product line as you saw it, and a **snapshot** of the public fields worth watching (`recallSnapshot` in `src/lib/recall-watch.js`), taken from the national index's copy where there is one. An **update** is:
  - **status** — the agency closed it (reported as closed, with "recalled product can still be in homes", never as good news), or reopened it;
  - **distribution** — states *added*, or widened to nationwide. A state *disappearing* is deliberately not announced: an index rebuild re-reads the distribution text, and "TX was removed" from a parser change would be a false all-clear;
  - **classification** — e.g. Class II → Class I;
  - **classified by FDA** — a followed company announcement (press release) whose enforcement record has appeared: same firm (`sameFirm`, now in `src/lib/firm.js`, the rule the index build uses to drop the announcement), FDA, within 45 days.

### The inbox works with nothing switched on

"New for you" is computed **in the browser** (`computeInbox` in `src/lib/alerts.js`) from the national index plus whatever live lists the page already loaded (the index's copy wins on an id both have): updates to followed recalls, then new recalls matching a term since you last pressed *Mark all read* (or since your last visit, or the last 14 days on a first visit). Its count is the badge on the bell and the tab. No account, no channel, no request. Empty, it says what was checked and since when — "Nothing new for what you follow since Sep 17 — in the notices we read" — never that anything is safe.

### Delivery: web push and email, one engine

Both channels are optional and independent, and each says **"Not available yet"** when this deployment can't send it (GET `/api/push` reports `channels: { push, email }`, each with a reason) instead of disappearing.

| | Web push | Email |
| --- | --- | --- |
| Turned on by | *Turn on notifications* (the only thing that prompts for permission) | typing an address and *Email me*, then clicking the link in the confirmation email |
| Server needs | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, Blob, `CRON_SECRET` | `RESEND_API_KEY`, `ALERTS_FROM`, `ALERTS_SECRET`, Blob, `CRON_SECRET` |
| Stored at | `push/subs/<sha256(endpoint)>.json` | `alerts/email/<HMAC(ALERTS_SECRET, address)>.json` |
| Off | *Turn off on this device*, or a 404/410 from the push service | one-click unsubscribe in every email, *Turn off email* in the app |

What is sent (`api/_lib/alerts-engine.js`, the one engine both channels use; `api/_lib/send-digest.js` walks the subscribers):

- **Weekly digest** of new recalls in your state — Saturdays, `0 14 * * 6` UTC, if *Weekly digest* is on. A week with nothing new sends nothing, rather than a "0 recalls" message that would read as an all-clear.
- **Daily** (`30 15 * * *`): a new serious (Class I / high-risk) recall in your state if *Serious recalls … straight away* is on; a new recall matching a followed term; an update to a followed recall. Follow matches and updates go to any channel that's on — that is what following is.
- One push or one email per subscriber per run: specific when there is one thing to say, a summary otherwise.
- **Dedupe** per subscriber record: `lastSentIds` holds every recall id already sent and `u:<id>:<snapshot hash>` per reported update. Snapshots advance only after a successful send, so a failure is retried next run. Emails also carry an `Idempotency-Key` (subscriber, day, content).
- iPhone and iPad deliver web push only to a site added to the Home Screen; in a Safari tab the panel says so. Email works everywhere.
- **The service worker has no fetch handler**, on purpose: it can never serve a stale page or a stale recall list.

**Email specifics** (`api/_lib/email-channel.js`, `api/_lib/email-store.js`, `api/_lib/resend.js`; dispatched as `/api/push?channel=email&action=…` because the Hobby plan allows twelve functions):

- **Double opt-in.** `subscribe` stores a *pending* request and emails a confirmation link (48 hours, single use). The link's GET shows a page with one *Confirm* button that POSTs — mail scanners (Outlook Safe Links, corporate gateways) fetch every link in a message, and a GET that confirmed would opt people in unseen. Nothing but the confirmation is sent before that. Unconfirmed requests are deleted by the daily cron after a week. The response is identical whether or not the address was already subscribed.
- **Rate limit**: at most 3 confirmation emails per address per day, never two within 2 minutes (429 with `Retry-After`).
- **Unsubscribe**: every email has a one-click link in the body (a GET that unsubscribes immediately — the cost of a scanner doing it is an email you stop getting) and `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058; the POST unsubscribes). Unsubscribing **deletes the record**, address and all.
- **Tokens.** Confirmation and *manage* tokens are 32 random bytes; only their SHA-256 is stored, compared in constant time. The *manage* token stays in the browser that subscribed (`rr-alerts-email`) so it can keep follows in step, and only becomes valid once the address owner confirms — subscribing someone else's address gets you nothing, and a pending request can never delete a confirmed subscription. The unsubscribe token is *derived* — `HMAC(ALERTS_SECRET, key + per-record random salt)` — not stored, because every email the cron sends must carry a working link and a stored hash can't be put in an email; a leaked Blob store therefore yields no working links.
- **Links** point at `ALERTS_BASE_URL` (else `VERCEL_PROJECT_PRODUCTION_URL`, else `https://yanked.app`), never at the request's `Host` header, which a forged request could point elsewhere with the confirmation token in it.
- Sends are sequential with a 600ms gap (Resend's default limit is 2 requests/second). That is fine for hundreds of subscribers, not tens of thousands — a larger list wants Resend's batch endpoint and a queue.

**Push specifics**: subscription endpoints must belong to a browser push service (FCM, Mozilla, Apple, Windows); anything else is refused, so the cron can never be pointed at an arbitrary URL. An existing subscription is kept in step when follows, followed recalls, preferences or the state change, without prompting; `pushsubscriptionchange` in `public/sw.js` carries everything over to a rotated endpoint.

**`CRON_SECRET`** is required as soon as either channel is configured (VAPID keys or `RESEND_API_KEY` set): without it `/api/push?action=digest` answers 503 and sends nothing, because it would otherwise let anyone fire alerts at every subscriber, and its `?dry=1` preview shows subscribers' states and follow terms (never addresses or endpoints). Both channels also report "not available yet" until it is set. With neither channel configured, the cron is a harmless no-op that says so.

### When the browser forgets

Follows, followed recalls, the read marker and the email manage token all live in this browser's `localStorage`. Browsers clear it — on request, under storage pressure, and Safari on iPhone **after seven days without a visit** unless the site was added to the Home Screen. For an app people open now and then, that is the common case, not the edge one. Three things answer it, none of them pretending the data is safer than it is:

- **Ask to keep it.** The first follow of any kind calls `navigator.storage.persist()` (`requestPersistentStorage` in `src/lib/follows.js`) and records the answer. Chrome and Firefox honour it, deciding from engagement — a site with no history is usually told no. WebKit's seven-day rule is separate, so on iPhone this is not enough on its own.
- **Say what keeps it on iPhone.** Once something is followed, Safari on iPhone outside the Home Screen shows one dismissible card: Add to Home Screen keeps follows and is also what makes push possible there.
- **Restore from email.** The server already holds an email subscriber's follows, but a wiped browser has lost the token that proves it may read them — the inbox is the credential that's left. *Email me a link* (`?channel=email&action=restore-request`) sends a single-use, 30-minute link to `/?restore=<id>.<token>`; the answer is the same whether or not the address subscribes, and it shares the confirmation-email rate limit. Opening the link shows a **Restore** button and spends nothing; pressing it (`action=restore`) merges the server's follows into this browser (nothing local is removed) and gives this browser its own manage token, beside up to four others. Restored recalls come back without a snapshot, so the inbox takes today's state as the baseline instead of announcing the restore as an "update". Without email alerts there is no copy anywhere but the browser, and the panel says so.

### Owner setup

Nothing below is needed for the in-app inbox; each channel is switched on independently.

1. **Blob** — a Vercel Blob store is attached already (`RR_BLOB_READ_WRITE_TOKEN`; see *The Blob token is read from a prefixed name*). It is **public**, because the feed caches are written public, so it cannot hold email addresses. **Email alerts need a second store, created *private* in Vercel**, connected with its token in `ALERTS_BLOB_READ_WRITE_TOKEN` (`src/lib/blob.js`). With that set, every alert record — push and email — is read and written there with private access. Without it, push keeps using the main store and email reports itself unavailable; `emailConfig` refuses to run on a public store, so this cannot be skipped by accident.
2. **`CRON_SECRET`** — any long random string (`openssl rand -hex 32`) in Vercel → Settings → Environment Variables (Production). Vercel cron sends it automatically.
3. **Web push** — `npx web-push generate-vapid-keys` once; set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:` an address you read). Never rotate casually: every subscription is bound to the public key.
4. **Email via Resend**
   1. Create a Resend account; **Domains → Add domain** — use a sending subdomain such as `alerts.yanked.app` (or `yanked.app`).
   2. Add the DNS records Resend shows at your DNS host: the **DKIM** TXT record (`resend._domainkey…`), and for the bounce subdomain (`send.…`) the **SPF** TXT record (`v=spf1 include:amazonses.com ~all`) and **MX** record. Wait for Resend to show the domain *Verified*.
   3. Add a **DMARC** record if the domain has none: TXT at `_dmarc.yanked.app`, e.g. `v=DMARC1; p=none; rua=mailto:you@yanked.app` (Gmail and Yahoo require DMARC for bulk senders).
   4. **API Keys → Create** with *Sending access* only, restricted to that domain → `RESEND_API_KEY`.
   5. Set `ALERTS_FROM` to an address on the verified domain, e.g. `Yanked <alerts@yanked.app>`.
   6. Set `ALERTS_SECRET` to a random string of at least 32 characters (`openssl rand -hex 32`). **Never rotate it**: it keys every email record's filename and every unsubscribe link; a new secret orphans all subscribers.
   7. Optionally `ALERTS_BASE_URL=https://yanked.app` (defaults to the production domain).
5. **Redeploy**, then check: `GET /api/push` should report `channels.email.enabled: true` (and push, if configured); `curl -H "Authorization: Bearer $CRON_SECRET" "https://yanked.app/api/push?action=digest&mode=urgent&dry=1"` previews a run without sending. Subscribe your own address from the app, confirm, and use the unsubscribe link once to see the whole loop.

## Running it## Running it

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

Those rules capture with `:path(.*)` and not `:path*`, and the difference is the whole feature working or not. `:path*` matches segment by segment and rebuilds the destination from the segments, which silently drops a trailing slash: `/ingest/i/v0/e/` arrives at PostHog as `/i/v0/e`, and every PostHog ingestion endpoint — `/i/v0/e/`, `/e/`, `/flags/` — is a 404 without it. `:path(.*)` captures the remainder verbatim, trailing slash included. The failure is easy to miss because the one route with no trailing slash, `/array/<token>/config.js`, proxies fine either way: the library boots, reads its config, reports no error, and then every event it sends 404s.

**What is never sent.** This app knows where its user is standing, and that is the most sensitive thing it holds. No coordinates leave the browser at any precision, and neither does the ZIP or address typed into the box, the city geocoding resolved it to, or the name or address of any nearby store. What goes instead is the two-letter state — the granularity the recall feeds are themselves scoped to, and the coarsest thing that still answers "is this working outside California?" Everything else is a count or an outcome word.

**An email address leaves the browser in exactly one case**: you type it into Alerts and press *Email me*. It goes to `/api/push?channel=email&action=subscribe` and from there to Resend, to send the confirmation. It is never sent to analytics (the alert events carry the state and outcome words only), never put in a URL, and never echoed back in a cron preview. The server stores, per address, in one Vercel Blob file named by an HMAC of the address: the address; the state; your follow terms (≤20) and followed recall ids (≤50); a snapshot of each followed recall's public fields (status, states, class); your two preferences; the ids already sent; the hashes of the confirmation and manage tokens; a random salt; the times confirmation emails were sent (for the rate limit); and created/updated/confirmed timestamps. Nothing else — no IP address, no user agent, no name, no location finer than the state. An unconfirmed request is deleted after a week; unsubscribing or *Turn off email* deletes the file. Web push stores the same minus the address and tokens, plus the push subscription. With no channel on, follows and the inbox never leave the browser.

Scanned barcodes *are* sent, and the distinction is deliberate: a UPC identifies a product, not a person, and it is the only way to measure whether the coverage problem described below is actually biting in the field. `scan_completed` carries `notices_with_codes` alongside the result for the same reason the interface shows it — a miss against forty notices and a miss against nothing at all are not the same event.

**Search text is sent on the same argument, with a guard.** What goes into a box labelled "Product, brand or barcode" names a product, and "what do people search for and not find" is the index's coverage question just as unmatched scans are the barcode one. But a box is a box, so `searchQueryProp` in `src/lib/analytics.js` drops anything shaped like a ZIP, an email address, a phone number or a street address to `null` before it leaves, and caps the rest at 60 characters. The box searches as you type, so `search_submitted` fires once a query has sat unchanged for 1.2 seconds, with the result count and whether openFDA had to be asked live. Follow terms go through the same guard on `follow_added`. The other Home events carry outcome words and recall ids, which are public notice numbers: `verdict_viewed` (`verdict`, `source`, and `via` search, latest, alerts or share_link), `share_clicked` (`outcome`: shared, copied or failed — mostly a dismissed share sheet), `push_enabled` / `push_failed` (`reason`), `recall_followed` / `recall_unfollowed` (`recall_id`), `email_alerts_requested` (`state`), `email_alerts_failed`, `email_alerts_off`, `alerts_marked_read` (`count`) — never the email address.

**Location and scope events.** `location_set` carries `method` (`zip`, `address`, `geo`, `recent`, or `saved` for the silent restore) and the state; `location_failed` carries the method and the error code from `GEO_ERRORS` — never the typed text, never the ZIP. `location_picker_opened` says where it was opened from (`header`, `search_card`, `digest`, `stores_empty`, `alerts`, `scope_switch`, `stories`) and whether a location was already set. `scope_changed` carries `from`, `to` and `via` (`home_list`, `header`, `url`, `location_set`, `forget`, `recalls_chip`, `stores_note`), and `scope` (`near` | `us`) is registered as a super property so every event, autocapture included, can be split by it; `search_submitted` and `verdict_viewed` carry it too, and `recalls_loaded` for the national list has `scope: "us"` and no state.

Session replay is on with `maskAllInputs` and `maskTextSelector: "*"`, which greys out every string in the recording. That is a real cost to how readable a replay is, taken because the flow most worth watching is exactly the flow carrying someone's address. The comment in `src/lib/analytics.js` says precisely what to loosen, and what to mark `ph-no-capture` first, if that trade stops being worth it.

**Preview deploys report too.** `import.meta.env.DEV` is true only under the dev server, so every `vite build` is live the moment the key is scoped to that environment — which is what makes a preview testable, and also what would quietly mix branch deploys, PR previews and whatever automation finds a preview URL into the same funnels as real users. Every event therefore carries `environment`, registered as a super property from `VITE_VERCEL_ENV` (Vercel injects it into Vite builds on its own). Filter on `environment = production` for any number you intend to act on.

Keys go in `.env.example`. With none set, `initAnalytics()` returns immediately and posthog-js is never fetched — the app runs unmeasured rather than broken.

## Scanning, and why "no match" is not "safe"

No government feed publishes a barcode field. UPCs turn up inside free text — openFDA's `code_info` and `product_description`, FSIS's `field_product_items` — inconsistently, and CPSC consumer-product recalls have none at all. Coverage is therefore partial and cannot be measured from inside the app, which makes the empty result the dangerous one.

So the scanner refuses to let a miss look like a green tick. The clear state is grey and interrogative, never green; it never uses the word *safe*; it says how many notices even carried a barcode to compare against; and it runs a second lookup that includes recalls which have since ended.

`src/lib/upc.js` collapses UPC-A, UPC-E, EAN-13 and GTIN-14 to one key so a match is not missed on spelling alone, and verifies the GTIN check digit so a twelve-digit lot number is not read as a barcode. Decoding uses the platform `BarcodeDetector` where it exists and lazy-loads ZXing everywhere else (notably iOS Safari, which has never shipped it) — a separate chunk, so anyone who never scans never downloads it. [Open Food Facts](https://world.openfoodfacts.org) turns a barcode into a brand and product name, which is what makes near-miss matching possible at all, and supplies the product photo for FDA and FSIS notices, neither of which publishes one.

## Is it still recalled?

`/api/lookup?upc=…` (or `?q=…`) is the one endpoint that does **not** filter to active notices. Everywhere else the app asks openFDA for `status:"Ongoing"` and FSIS for `field_active_notice`, which is right for "what should I worry about near me" and wrong for the question people arrive with after seeing a headline. Under an ongoing-only query, a recall that has since been terminated and a recall we never had look identical — both absent.

`status` is openFDA's own lifecycle field (Ongoing / Completed / Terminated / Pending), so "resolved" is public data that was being filtered away rather than a gap in the feeds. This endpoint reports it, which turns silence into an answer.

A text query searches product, firm and reason, 100 per kind, and is ranked on the server (`api/_lib/lookup-rank.js`): the phrase in the firm name or the first 80 characters of the product description, then every word starting a word outside an ingredient list, then everything else. A match that only mentions the word in an ingredient list is dropped when anything better exists — so "sugar" finds the sugar recall, not every cookie. It returns the top 40 plus `total`, `dropped`, `truncated` and `lastUpdated`.

### Two kinds of check, and why they are kept apart

`node scripts/check-data.mjs` tests **logic** offline — geography, verdicts, ranking, freshness, parsing. The openFDA records it runs on are real, copied verbatim from api.fda.gov responses (the fixture's `_provenance` says which); the RSS fixture is fictional "Example … Co." items, because it tests a parser and its names say so. It cannot tell you whether a recall is in the data, and it must never be made to look as if it could: an earlier version asserted against a hand-written record of the United Sugar recall, passed, and was reported as proof the app handled that recall — while production, reading the real openFDA, had no such record, because openFDA had not published it yet.

`node scripts/check-alerts.mjs` tests the **alerts logic** offline, on synthetic records that say so ("Example … Co.", ids like `fda-food-TEST-0001`): email and recall-id validation, token hashing and verification, subscribe → confirm → unsubscribe (GET and the RFC 8058 POST), the rate limit, the recall diff engine (closed, states added, nationwide, reclassified, announcement classified), the planner's dedupe, the in-app inbox, and both channels through the cron handler. Resend is a mocked `fetch`, Blob an in-memory map, web-push's `sendNotification` a recorder, and the index a synthetic one — so it proves the logic, and nothing about whether Resend, Blob or a push service accepts the requests for real.

`node scripts/check-live-fda.mjs` tests **data**, live, and runs in the refresh workflow, where api.fda.gov is reachable. Its job-summary section says how current openFDA is (its own `last_updated` and newest report date), whether the index got FDA records, and whether each query in `scripts/watchlist.json` matches anything yet. That file is where a recall seen in the news goes — as an openFDA query, never as a record — so "is it in the data yet?" has an answer on every run.

**openFDA lags the news.** FDA classifies a recall, publishes it in the weekly Enforcement Report, and openFDA picks that report up afterwards; in September 2026 its data ran to the 23rd while a recall classified on the 21st was already in the headlines. When a search misses, `/api/lookup` now retries with every word matched separately (a phrase can miss a firm filed under a variant name) and returns openFDA's own `last_updated` even on a miss, and the no-results state says how far FDA's data runs.

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
src/App.jsx                     — layout, state, filtering, both draggable dividers; Home, deep links, alerts
src/components/RecallSearch.jsx — Home's search: national index + live openFDA, grouped by verdict
src/components/VerdictCard.jsx  — one recall answered for one state: evidence, map, share, follow
src/components/StateMap.jsx     — tile-grid US map of what a notice names (neutral, never red/green)
src/components/LatestRecalls.jsx — Home's newest-first list, Near me · ST | All US, freshness
src/components/RecallRow.jsx    — one compact recall row (headline, one meta line, serious badge)
src/components/MapView.jsx      — MapLibre map, markers, selection painting (lazy chunk)
src/components/FilterSheet.jsx  — the one filter surface: sheet on a phone, popover at md+
src/components/ui/              — button, badge, input
src/lib/states.js               — US state name/abbreviation tables
src/lib/retailers.js            — chain dictionary + recall-text matcher (regex, word-bounded)
src/lib/geo.js                  — browser geolocation, Zippopotam ZIP + Nominatim geocoding, haversine
src/lib/sources.js              — openFDA / FSIS / CPSC fetchers → one normalized recall shape
src/lib/verdict.js              — coverage, the five verdicts, and the one "is it in my area" rule
src/lib/search-index.js         — load + search the national index (MiniSearch), trending, live lookup
src/lib/index-server.js         — the same index read off disk, for the API functions
src/lib/digest.js               — the digest's counting and wording, pure and node-runnable
src/lib/follows.js              — follow terms, followed recalls, the last-visit and inbox-read markers, in localStorage
src/lib/recall-watch.js         — recall snapshots and the update diff (status, states, class, announcement → classified)
src/lib/alerts.js               — alert preferences, the email client, channel sync, the in-app inbox
src/lib/firm.js                 — sameFirm: the one rule for "this announcement became that enforcement record"
src/components/AlertsPanel.jsx  — the Alerts surface: inbox, follows, delivery
src/components/WatchButton.jsx  — "Notify me about updates" on one recall
src/lib/share.js                — share links and the one short-form verdict wording (card, unfurl)
src/lib/push.js, push-store.js  — web push client; subscription validation + Blob storage
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
api/                            — Vercel functions (11 of the Hobby plan's 12 — see Design notes): data, recalls, stores, USDA/CPSC proxies, diagnostics
api/data.js                     — the recall data clients read: manifest + chunks from Postgres, or built from the committed index
db/schema.sql, scripts/db/      — the recall database's schema and idempotent migration runner
scripts/sync/                   — the sync: ingest -> raw_records -> recalls -> recall_index -> published (README → Data pipeline)
src/lib/db.js                   — the database adapter: postgres driver, or PGlite for tests and dry runs
src/lib/publication.js          — the manifest/chunk format, shared by the sync and api/data.js
api/lookup.js                   — one product across openFDA, INCLUDING finished recalls
api/share.js                    — /r/:id unfurls: meta tags + redirect; ?format=png is the 1200×630 verdict card
api/push.js                     — push subscriptions + channel availability; ?action=digest runs the crons; ?channel=email&action=… is email
api/_lib/                       — code, not deployed functions: og.js (the card), send-digest.js (the crons), alerts-engine.js
                                  (what to send, push and email renderers), email-channel.js / email-store.js / resend.js (email)
public/sw.js, manifest.webmanifest — push-only service worker (no fetch handler) and install manifest
scripts/build-index.mjs         — build public/feeds/index.json, the national index
api/refresh-feeds.js            — daily cron: warm the FSIS and CPSC caches off the request path
scripts/refresh-feeds.mjs       — fetch the feeds from a GitHub runner, build the index, commit both
public/feeds/                   — the committed snapshots; machine-generated, see its README
```

Design notes:

- **Twelve functions, and every file in `api/` is one.** Vercel's Hobby plan refuses a deployment with more than twelve serverless functions, and it counts each file directly under `api/`. So new server work rides on an existing function behind a query parameter — the verdict card is `/api/share?format=png`, the alert crons are `/api/push?action=digest` and email alerts `/api/push?channel=email&action=…`, the All US list is `/api/recalls?scope=us` (every active notice, no area filter; `400` with a state) — with the code itself in `api/_lib/`, which the underscore keeps from being deployed on its own. Count `ls api/*.js` before adding a file. `api/data.js` took the slot of `api/fda.js`, an openFDA proxy nothing called any more (the browser fallback reads openFDA directly and the server path is `/api/recalls`).
- **Per-source resilience:** each feed is fetched with `Promise.allSettled`; one failure never breaks the page. openFDA's "no results" 404 is treated as an empty set.
- **Four tiers for USDA and CPSC, because one is not enough.** `https://www.fsis.usda.gov/fsis/api/recall/v/1?format=json` is the documented endpoint, it is correct, and it takes no API key — it is served off the agency's own web host rather than from behind api.data.gov, so a 403 is not asking for a credential. It nonetheless refuses this app's serverless function much of the time, and CPSC's `saferproducts.gov` returns 180 days as one uncompressed document that regularly outruns the request budget. So the data is fetched from four places that fail independently: (1) a live server-side fetch with a few spaced retries; (2) a Vercel Blob copy, warmed daily by `api/refresh-feeds.js` **off** the request path, where a cron can afford to be patient; (3) a direct fetch from the user's own browser, which is a different client on a different network; and (4) a snapshot committed to `public/feeds/` by a GitHub Action. Each tier says how old it is, and the recall list names which one answered.
- **The fourth tier is the one that matters, and both sides read it.** Tiers 1–3 all ultimately need USDA to answer *this deployment* at some point; if it never does, they are empty together. `.github/workflows/refresh-feeds.yml` runs `scripts/refresh-feeds.mjs` on a GitHub runner four times a day — a different network with a different IP reputation — and commits the result, so the build ships with the data as a static asset needing no Blob store, no environment variable, and no cooperation from USDA at request time. The browser reads that snapshot over the CDN and the server reads its own copy off disk (`src/lib/snapshot.js`, the last tier of `feedWithFallback`) — without the server half, a deployment with refused egress and an unattached Blob store answers `/api/recalls` with "USDA FSIS: unavailable" while the data sits inside it.
- **A refresh job that cannot go red is a cron with a log file.** The first run of the Action was green and produced a snapshot holding one recall: USDA had answered 200, the fetch and commit both worked, and the feed was empty in every way that matters to a reader. Two things caused it. `slimFsis` gated everything on `field_active_notice === "true"`, one string comparison that all four tiers slim through, so when it stopped matching they all emptied together; it now admits recent closed notices too and the card labels them **Closed** rather than passing them off as live. And the script exited 0 if *either* feed was written, so a total USDA failure was green as long as CPSC turned up. Every feed is now required, has a floor, and is refused if it collapses against the copy already committed — the previous snapshot keeps serving and the run goes red. Each run publishes a summary table and a `feed-report` artifact carrying the raw upstream shape, because "USDA has one active recall" and "our filter stopped matching" look identical in a log and want opposite fixes.
- **The 403 was our own User-Agent.** Two commits had asserted opposite causes — `852c7d0` ("rejects clients without a browser user agent") and `4c0676c` ("an IP and TLS fingerprint decision, not a header one") — neither with a measurement. Measured at last, from one laptop, one IP, one sitting: curl is refused whatever headers it sends (including a full Chrome set over HTTP/2); a browser succeeds, in incognito too, so it is not a cookie; **Node succeeds with no headers and fails with `Yanked/1.0 (public recall aggregator; +https://yanked.app)`**. So part of the decision is the TLS/client fingerprint, which Node passes and curl does not — and with the client held fixed, the only thing separating 200 from 403 is our own User-Agent string.

  It is the *shape* of it. `Name/version (+url)` is the crawler idiom from the robots.txt era, and it is what bot-management products match to classify a self-identified bot. The app was refused for identifying honestly, in the format reserved for the kind of client it is not — one cached request per state per fifteen minutes against a documented JSON API published for software to consume. `FSIS_HEADER_SETS` is now a ladder of truthful identities walked in order: a bare product token (RFC 9110 §10.1.5), then no claim at all, then the exact request measured at 200. There is deliberately no browser rung; impersonating Chrome to a government API would be a lie, and the curl rows show it does not even work.
- **The experiment is still runnable from production**, because one unknown remains: the laptop above is a residential address, and whether Vercel's egress carries a second block on top of the User-Agent one has never been measured. `/api/diag?probe=feeds` fires the whole ladder plus the old crawler string and a browser control in parallel, and states its own conclusion — which rung answered, or that every truthful identity failed and the address is the remaining variable.
- **The Blob token is read from a prefixed name.** `@vercel/blob` looks for exactly one variable, `BLOB_READ_WRITE_TOKEN`. This project's store is attached with an `RR_BLOB_` prefix, so it exports `RR_BLOB_READ_WRITE_TOKEN` and the SDK never finds it. Nothing throws: every `head`/`put`/`list` here is wrapped in a catch that reads failure as "not cached yet", so an unfound token silently turns every cache into a permanent miss — feeds *and* the Mapbox store tiles, which is one Mapbox request per chain per visitor forever. `src/lib/blob.js` resolves the prefixed name (falling back to the unprefixed one) and passes it explicitly to every call; `/api/diag` reports which variable it actually found.
- **A missing agency is a hole in the answer, not a status light.** When a feed is *down*, the recall list says so at the top, names what is missing from it, and says an empty list is not the same as no recalls — rather than leaving it to an amber dot in the desktop footer. A feed *serving a saved copy* is the opposite case and is deliberately quiet: its recalls are in the list, only their provenance changed, and "live fetch failed (HTTP 403) and no cache was warm" asks a shopper to care about a WAF and a cold cache to learn something that does not change what they should do next. It reads as breakage while describing the fallback working as designed, so it lives in About — beside the per-source counts and *Check The Feeds*, where whoever runs this app will look for it.

- **A saved copy that matched nothing is neither of those, and it is the one that lies.** Either half alone is unremarkable: a copy that still found recalls is provenance, and a live feed that found none is a trustworthy zero. Together they render a section identical to "no recalls near you" while the honest claim is only "none in the copy we had" — the same mistake the scanner refuses to make about an unmatched barcode. Production shipped exactly this: a snapshot holding one New England notice, which every other state scoped away to a silent nought under a green source dot. So `ok && note && !count` says so at the top of the list. Only zero is caught — a copy thin enough to return two recalls where the live feed would return thirty is equally wrong and cannot be detected from inside the app, since the count it should have had is precisely what is missing.
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
