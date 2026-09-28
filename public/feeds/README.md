# Committed feed snapshots

The `.json` files in this directory are **machine-generated** — do not edit them
by hand. They are written by `.github/workflows/refresh-feeds.yml`, which runs
`scripts/refresh-feeds.mjs` on a GitHub runner four times a day and commits the
result.

They exist because every live path this app has to USDA leaves from a Vercel
serverless function, so they all fail together for whatever reason that one
caller is being refused. A GitHub runner is a different network with a different
IP reputation, and what it fetches is committed here — so the deployment ships
with a copy of the data as a static asset, needing no Blob store, no environment
variable, and no cooperation from USDA at request time.

This is the bottom tier, and the only one that cannot be taken away by anything
USDA decides about this deployment's egress:

1. live fetch, server-side (`api/recalls.js`)
2. Vercel Blob cache, warmed by `api/refresh-feeds.js`
3. a direct fetch from the user's own browser (`fsisFromBrowser`)
4. **this snapshot**

Tier 4 is read from both sides. The browser reads it over the CDN
(`recoverBlockedSources` in `src/lib/sources.js`); the server reads its own copy
off disk, falling back to its own CDN URL (`src/lib/snapshot.js`, wired in as
the last tier of `feedWithFallback`). The server side matters more than it
sounds: without it, a deployment whose egress USDA refuses and whose Blob store
is unattached reports "USDA FSIS: unavailable" from `/api/recalls` while a
perfectly good copy sits inside the same deployment, and recovery depends on the
browser making a second round trip.

Because the server reads these files, they have to be inside the function
bundle — that is what `functions["api/*.js"].includeFiles` is for in
`vercel.json`. Removing it does not break anything visibly; it quietly demotes
the server back to the CDN fallback.

Each tier carries its own age, and the UI says which one answered and how old it
is. A three-hour-old list of meat recalls is worth enormously more than an empty
panel labelled "unavailable" — and worth less than nothing if presented as live.

An empty directory is the normal state before the workflow has run once. A feed
missing while the others are present means the workflow refused to write it:
`scripts/refresh-feeds.mjs` will not overwrite a good snapshot with an empty or
collapsed one, and turns the run red instead.

## `index.json` — the national search index

Also machine-generated, by `scripts/build-index.mjs`, which
`scripts/refresh-feeds.mjs` runs after writing the snapshots. It is every recall
from all three agencies in the last year, **active and ended**, with no
location filter: USDA and CPSC from the snapshots above, openFDA food / drug /
device enforcement fetched nationwide by `report_date`, every status.

It answers the question the per-state feeds cannot — "is *this* recalled?" —
for a product whose notice names some other state. The browser searches it
(`src/lib/search-index.js`, MiniSearch loaded only when someone searches); the
server reads it off disk (`src/lib/index-server.js`) for share cards and push
digests.

```
{ builtAt, lookbackDays, count,
  sources: { fda: {ok, count, fetchedAt, note?}, fsis: {...}, cpsc: {...} },
  recalls: [ { id, source, product, firm, reason, classification, severity,
               date, status: "active"|"ended", endDate?, distribution, states,
               coverage: "nationwide"|"states"|"unstated", category, reasonKey,
               url, upcs? } ] }
```

Things worth knowing before reading it:

- **`sources.fda.ok: false` means the FDA records are stale, not absent.** When
  openFDA fails or collapses, the previous index's FDA records are carried
  over rather than dropped — the same rule as the snapshots. The client treats
  an index search with no FDA hit under that flag as "FDA not checked" and asks
  openFDA live through `/api/lookup`. The copy committed from a sandbox with no
  egress to api.fda.gov holds USDA and CPSC only, with `fda.ok: false` and
  `count: 0`; the first workflow run fills it in.
- **`coverage: "unstated"` is not nationwide.** It means the notice named no
  state and no national distribution. `distribution` is the agency's own text,
  capped (~400 characters), and is what a verdict quotes back as evidence.
- **A USDA "not active" flag on a notice younger than 90 days is not read as
  ended.** On fresh notices that flag does not track the recall's lifecycle —
  the first build saw a three-day-old Class I recall flagged inactive — and an
  ended status becomes the headline "This recall has ended".
- **Size is held near 3 MB raw by trimming text, never by dropping records.**
  The build retries at tighter caps until it fits and logs where it settled.
- Rewritten only when the records or a source's `ok` changed, so an unchanged
  refresh commits nothing.
