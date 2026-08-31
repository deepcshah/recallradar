# Committed feed snapshots

The `.json` files in this directory are **machine-generated** — do not edit them
by hand. They are written by `.github/workflows/refresh-feeds.yml`, which runs
`scripts/refresh-feeds.mjs` on a GitHub runner four times a day and commits the
result.

They exist because every other path this app has to USDA leaves from a Vercel
serverless function, so they all fail together for whatever reason that one
caller is being refused. A GitHub runner is a different network with a different
IP reputation, and what it fetches is committed here — so the deployment ships
with a copy of the data as a static asset, served off the CDN, needing no Blob
store, no environment variable, and no cooperation from USDA at request time.

This is the bottom tier of four, and the only one that cannot be taken away by
anything USDA decides about this deployment's egress:

1. live fetch, server-side (`api/recalls.js`)
2. Vercel Blob cache, warmed by `api/refresh-feeds.js`
3. a direct fetch from the user's own browser (`fsisFromBrowser`)
4. **this snapshot** (`recoverBlockedSources`)

Each carries its own age, and the UI says which tier answered and how old it is.
A three-hour-old list of meat recalls is worth enormously more than an empty
panel labelled "unavailable" — and worth less than nothing if presented as live.

An empty directory is the normal state before the workflow has run once.
