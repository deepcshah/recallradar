/* Data-layer checks, offline: fixtures in scripts/fixtures, network mocked.
 *
 *   node scripts/check-data.mjs
 *
 * Covers the acceptance scenario (the September 2026 United Sugar recall,
 * checked from New York and from Texas), openFDA freshness, FDA announcements
 * (RSS parse + dedupe + verdict), live-lookup ranking, and the ambiguous
 * state-code query fix. Exits 1 on the first failed assertion. Writes nothing.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

import { normalizeFda, fdaSearchQuery, fdaDistributionClause, needsUnscopedDepth } from "../src/lib/sources.js";
import { verdictFor, isInArea, statesIn, VERDICTS } from "../src/lib/verdict.js";
import { prepareSearch, searchIndex, freshnessOf, recentFor, lookupMatchToRecord } from "../src/lib/search-index.js";
import { buildIndex, parseRss, announcementToIndex, dropAnnouncedDuplicates, sameFirm } from "./build-index.mjs";
import { rankMatches } from "../api/_lib/lookup-rank.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => readFile(resolve(HERE, "fixtures", name), "utf8");

const fdaFood = JSON.parse(await fixture("openfda-food-sugar.json"));
const rss = await fixture("fda-recalls-rss.xml");
const NY = { stateAbbr: "NY" };
const TX = { stateAbbr: "TX" };
const NOW = new Date("2026-09-28T15:00:00Z");

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`  ok  ${label}`);
}
const show = (label, v) => console.log(`      ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

// ─────────────────────────────────────────── 1. the sugar recall, NY vs TX
console.log("\n1. United Sugar recall (openFDA fixture F-1234-2026)");
const sugarRaw = fdaFood.results[0];
const [sugarNY] = normalizeFda("food", [sugarRaw], NY);
const [sugarTX] = normalizeFda("food", [sugarRaw], TX);
const vNY = verdictFor(sugarNY, NY);
const vTX = verdictFor(sugarTX, TX);
show("NY scope", sugarNY.scope);
show("NY verdict", `${vNY.verdict} — ${vNY.headline} — ${vNY.detail}`);
show("TX scope", sugarTX.scope);
show("TX verdict", `${vTX.verdict} — ${vTX.headline} — ${vTX.detail}`);
check("NY: scope 'elsewhere'", () => assert.equal(sugarNY.scope, "elsewhere"));
check("NY: verdict not_listed, 'Not reported in New York'", () => {
  assert.equal(vNY.verdict, VERDICTS.NOT_LISTED);
  assert.equal(vNY.headline, "Not reported in New York");
});
check("NY: detail names all 8 states and the caveat", () => {
  assert.match(vNY.detail, /Sent to IA, IL, IN, KS, MN, OH, PA, TX\. New York isn't listed\./);
  assert.match(vNY.detail, /incomplete/);
});
check("NY: not in the NY area list", () => assert.equal(isInArea(sugarNY, NY), false));
check("TX: scope 'state', verdict in_area", () => {
  assert.equal(sugarTX.scope, "state");
  assert.equal(vTX.verdict, VERDICTS.IN_AREA);
  assert.equal(vTX.headline, "Distributed in Texas");
});
check("IN (ambiguous code) is still read from 'IL, IN, IA'", () =>
  assert.equal(verdictFor(normalizeFda("food", [sugarRaw], { stateAbbr: "IN" })[0], { stateAbbr: "IN" }).verdict, VERDICTS.IN_AREA));

// ─────────────────────────────────────────── 2. build-index with fixtures
console.log("\n2. build-index with the openFDA + RSS fixtures");
const { index } = await buildIndex({
  fdaRaw: { food: fdaFood, drug: [], device: [] },
  fdaRss: rss,
  now: NOW,
  write: false,
  out: resolve(tmpdir(), "yanked-check-index-does-not-exist.json"),
});
await prepareSearch(index);
const inIndex = index.recalls.find((r) => r.id === "fda-food-F-1234-2026");
show("index record", inIndex);
show("sources.fda", index.sources.fda);
show("sources.fdaAnnouncements", index.sources.fdaAnnouncements);
show("sources.fsis", index.sources.fsis);
check("sugar record is in the index, coverage 'states', 8 states", () => {
  assert.ok(inIndex);
  assert.equal(inIndex.coverage, "states");
  assert.deepEqual(inIndex.states, ["IA", "IL", "IN", "KS", "MN", "OH", "PA", "TX"]);
});
check("index verdicts: NY not_listed, TX in_area", () => {
  assert.equal(verdictFor(inIndex, NY).verdict, VERDICTS.NOT_LISTED);
  assert.equal(verdictFor(inIndex, TX).verdict, VERDICTS.IN_AREA);
});
const sugarHits = searchIndex(index, "sugar");
show("searchIndex('sugar') top 5", sugarHits.slice(0, 5).map((r) => `${r.id} | ${r.product.slice(0, 60)}`));
check("searchIndex(index, 'sugar') ranks it first", () => assert.equal(sugarHits[0].id, "fda-food-F-1234-2026"));
check("searchIndex 'brown sugar' and 'united sugar' find it first", () => {
  assert.equal(searchIndex(index, "brown sugar")[0].id, "fda-food-F-1234-2026");
  assert.equal(searchIndex(index, "united sugar")[0].id, "fda-food-F-1234-2026");
});
check("sources.fda.lastUpdated = openFDA meta.last_updated", () => {
  assert.equal(index.sources.fda.lastUpdated, "2026-09-24");
  assert.deepEqual(index.sources.fda.lastUpdatedByKind, { food: "2026-09-24" });
  assert.equal(index.sources.fda.newest, "2026-09-10");
});
check("fsis/cpsc carry fetchedAt and newest", () => {
  for (const k of ["fsis", "cpsc"]) {
    assert.ok("fetchedAt" in index.sources[k]);
    assert.match(String(index.sources[k].newest), /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ─────────────────────────────────────────── 3. announcements
console.log("\n3. FDA announcements (RSS fixture)");
const items = parseRss(rss);
show("parsed items", items.map((i) => ({ title: i.title, pubDate: i.pubDate })));
check("parser: 4 items (link-less item skipped), CDATA + entities decoded, HTML stripped", () => {
  assert.equal(items.length, 4);
  assert.equal(items[0].title, "United Sugar Producers & Refiners Recalls Light Brown and Powdered Sugar Because of Undeclared Wheat");
  assert.equal(items[0].pubDate, "2026-08-21");
  assert.match(items[0].description, /^United Sugar Producers & Refiners, of Edina/);
  assert.match(items[1].description, /with Listeria monocytogenes\. The company’s/);
  assert.equal(items[2].title, 'Garden State Bakery Issues Allergy Alert on Undeclared Peanut in "Morning Glory" Muffins');
  assert.match(items[2].description, /No illnesses have been reported & the problem/);
});
const anns = index.recalls.filter((r) => r.source === "FDA announcement");
show("announcements kept in index", anns.map((a) => ({ id: a.id, firm: a.firm, date: a.date, coverage: a.coverage, states: a.states, category: a.category, reasonKey: a.reasonKey })));
check("window: the June item (>60 days) is gone", () => assert.ok(!anns.some((a) => /Old Mill/.test(a.firm))));
check("dedupe: United Sugar announcement dropped (enforcement record, same firm, within 45 days)", () => {
  assert.ok(!anns.some((a) => /United Sugar/.test(a.firm)));
  assert.equal(index.sources.fdaAnnouncements.droppedAsDuplicates, 1);
  assert.ok(sameFirm("United Sugar Producers & Refiners", "United Sugar Producers & Refiners Cooperative"));
  assert.ok(!sameFirm("United Natural Foods", "United Sugar Producers & Refiners Cooperative"));
  assert.ok(!sameFirm("Hudson Valley Greens", "Hudson Valley Creamery"));
});
check("dedupe keeps an announcement when the enforcement record is >45 days away", () => {
  const a = announcementToIndex(items[0]);
  const far = { ...inIndex, date: "2026-05-01" };
  assert.equal(dropAnnouncedDuplicates([a], [far]).kept.length, 1);
});
const hudson = anns.find((a) => /Hudson Valley/.test(a.firm));
const garden = anns.find((a) => /Garden State/.test(a.firm));
check("home town is not distribution: Hudson Valley ('of Kingston, New York') is 'unstated'", () => {
  assert.equal(hudson.firm, "Hudson Valley Greens");
  assert.equal(hudson.coverage, "unstated");
  assert.equal(hudson.status, "announced");
  assert.equal(hudson.announcement, true);
});
const vHudson = verdictFor(hudson, NY);
show("Hudson verdict (NY)", vHudson);
check("unstated announcement -> ANNOUNCED verdict, not in the NY area, not in 'new near you'", () => {
  assert.equal(vHudson.verdict, VERDICTS.ANNOUNCED);
  assert.equal(vHudson.headline, "Announced, not yet classified");
  assert.equal(verdictFor(hudson, null).verdict, VERDICTS.ANNOUNCED);
  assert.equal(isInArea(hudson, NY), false);
  assert.ok(!recentFor(index, NY, { sinceDays: 30 }).some((r) => r.id === hudson.id));
});
check("...but search shows it", () => assert.equal(searchIndex(index, "enoki")[0].id, hudson.id));
const vGarden = verdictFor(garden, NY);
show("Garden State verdict (NY)", vGarden);
check("announcement naming NY, NJ, CT -> normal geographic verdict + note", () => {
  assert.deepEqual(garden.states, ["CT", "NJ", "NY"]);
  assert.equal(vGarden.verdict, VERDICTS.IN_AREA);
  assert.equal(vGarden.announced, true);
  assert.match(vGarden.note, /hasn't classified/);
  assert.equal(verdictFor(garden, TX).verdict, VERDICTS.NOT_LISTED);
  assert.equal(isInArea(garden, NY), true);
});

// ─────────────────────────────────────────── 4. freshness
console.log("\n4. freshnessOf");
const fresh = freshnessOf(index, null, { now: NOW.getTime() });
show("from the index", fresh);
check("FDA uses openFDA's date (kind 'updated'), 4 days old -> not stale", () => {
  assert.deepEqual(fresh[0], { source: "FDA", asOf: "2026-09-24T00:00:00.000Z", kind: "updated", stale: false });
  assert.deepEqual(fresh.map((f) => f.source), ["FDA", "USDA FSIS", "CPSC"]);
});
const liveSources = [
  { name: "FDA Food enforcement", ok: true, count: 3, lastUpdated: "2026-09-10", fetchedAt: "2026-09-28T14:00:00Z" },
  { name: "FDA Drug enforcement", ok: false, error: "timed out" },
  { name: "USDA FSIS (meat, poultry, egg)", ok: true, count: 2, fetchedAt: "2026-09-28T14:00:00Z" },
  { name: "CPSC consumer products", ok: true, count: 9, fetchedAt: "2026-09-20T14:00:00Z" },
];
const freshLive = freshnessOf(null, liveSources, { now: NOW.getTime() });
show("from /api/recalls sources", freshLive);
check("live sources: FDA 18 days old -> stale; FSIS fresh; CPSC 8 days -> stale", () => {
  assert.equal(freshLive[0].stale, true);
  assert.equal(freshLive[1].stale, false);
  assert.equal(freshLive[2].stale, true);
});
check("no dates at all -> asOf null, stale", () =>
  assert.deepEqual(freshnessOf(null, null)[1], { source: "USDA FSIS", asOf: null, kind: "fetched", stale: true }));

// ─────────────────────────────────────────── 5. live lookup ranking
console.log("\n5. /api/lookup ranking (openFDA mocked)");
const realFetch = globalThis.fetch;
const seenUrls = [];
globalThis.fetch = async (url) => {
  seenUrls.push(String(url));
  const kind = String(url).match(/api\.fda\.gov\/(\w+)\//)[1];
  const body = kind === "food" ? fdaFood : { meta: { last_updated: "2026-09-23", results: { total: 0 } }, results: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
const { default: lookup } = await import("../api/lookup.js");
const resBody = await new Promise((done) => {
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { done({ code: this.code, body: b }); } };
  lookup({ query: { q: "sugar" } }, res);
});
globalThis.fetch = realFetch;
show("query sent", decodeURIComponent(seenUrls[0]).replace(/&api_key=.*/, "").slice(0, 220));
show("response", { ...resBody.body, matches: resBody.body.matches.map((m) => `${m.id} r${m.relevance}`) });
check("searches product, firm and reason; limit 100", () => {
  assert.match(seenUrls[0], /product_description:"sugar"\+OR\+recalling_firm:"sugar"\+OR\+reason_for_recall:"sugar"/);
  assert.match(seenUrls[0], /limit=100/);
});
check("sugar recall first; ingredient-only matches dropped; total/lastUpdated reported", () => {
  const b = resBody.body;
  assert.equal(resBody.code, 200);
  assert.equal(b.matches[0].id, "fda-food-F-1234-2026");
  assert.equal(b.matches.length, 1);
  assert.equal(b.total, 1);
  assert.equal(b.dropped, 2);
  assert.equal(b.lastUpdated, "2026-09-24");
  assert.equal(typeof b.activeCount, "number");
  assert.equal(lookupMatchToRecord(b.matches[0]).relevance, 3);
});
check("rankMatches keeps ingredient mentions when nothing better exists", () => {
  const only = [{ id: "a", product: "Cookies. Ingredients: flour, sugar", firm: "X", reason: "", reportDate: "20260901" }];
  assert.equal(rankMatches(only, "sugar").ranked.length, 1);
});

// ─────────────────────────────────────────── 6. ambiguous state codes
console.log("\n6. ambiguous state codes in the openFDA query");
const qIN = fdaSearchQuery({ stateAbbr: "IN" });
const qNY = fdaSearchQuery({ stateAbbr: "NY" });
show("Indiana clause", fdaDistributionClause({ stateAbbr: "IN" }));
show("New York clause", fdaDistributionClause({ stateAbbr: "NY" }));
check("IN/OR/ME query the full name only; NY queries both; unscoped pass goes deep for IN", () => {
  assert.ok(!/distribution_pattern:"IN"/.test(qIN) && /distribution_pattern:"Indiana"/.test(qIN));
  assert.ok(!/distribution_pattern:"OR"/.test(fdaSearchQuery({ stateAbbr: "OR" })));
  assert.ok(!/distribution_pattern:"ME"/.test(fdaSearchQuery({ state: "Maine" })));
  assert.ok(/distribution_pattern:"NY"/.test(qNY) && /distribution_pattern:"New York"/.test(qNY));
  assert.equal(needsUnscopedDepth({ stateAbbr: "IN" }), true);
  assert.equal(needsUnscopedDepth({ stateAbbr: "NY" }), false);
});
check("statesIn: all-caps prose does not invent Indiana/Oregon", () => {
  assert.deepEqual(statesIn("DISTRIBUTED IN CALIFORNIA"), ["CA"]);
  assert.deepEqual(statesIn("SHIPPED TO STORES IN NY OR NJ"), ["NJ", "NY"]);
  assert.deepEqual(statesIn("DISTRIBUTED TO CA, OR, WA"), ["CA", "OR", "WA"]);
  assert.deepEqual(statesIn("in stores or online in Oregon"), ["OR"]);
});

// ─────────────────────────────────────────── 7. All US (/api/recalls?scope=us)
console.log("\n7. /api/recalls?scope=us (openFDA mocked; USDA/CPSC fall back to the committed snapshots)");
{
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/api\.fda\.gov\/food/.test(u)) return new Response(JSON.stringify(fdaFood), { status: 200 });
    if (/api\.fda\.gov/.test(u)) return new Response("{}", { status: 404 });
    return new Response("unavailable", { status: 503 });
  };
  const { default: recallsHandler } = await import("../api/recalls.js");
  const call = (query) => new Promise((done) => {
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { done({ code: this.code, body: b }); } };
    recallsHandler({ query }, res);
  });
  const us = await call({ scope: "us" });
  const ny = await call({ state: "New York", abbr: "NY" });
  const bad = await call({ scope: "us", abbr: "NY" });
  const junk = await call({ scope: "world" });
  globalThis.fetch = realFetch2;
  show("counts", { us: us.body.recalls.length, ny: ny.body.recalls.length, bad: bad.code, junk: junk.code });
  check("scope=us keeps other states' recalls (the sugar recall) and outnumbers NY", () => {
    assert.equal(us.code, 200);
    assert.equal(us.body.scope, "us");
    assert.ok(us.body.recalls.some((r) => r.id === "fda-food-F-1234-2026"));
    assert.ok(!ny.body.recalls.some((r) => r.id === "fda-food-F-1234-2026"));
    assert.ok(us.body.recalls.length > ny.body.recalls.length);
  });
  check("scope=us with a state, or an unknown scope, is a 400", () => {
    assert.equal(bad.code, 400);
    assert.equal(junk.code, 400);
  });
}

// ─────────────────────────────────────────── 8. "new" means when FDA published it
console.log("\n8. an FDA recall is new when FDA publishes it, not when the firm started it");
{
  const { summarize, newsDay } = await import("../src/lib/digest.js");
  const { parseRss: pr, announcementToIndex: a2i } = await import("./build-index.mjs");
  const now = Date.parse("2026-09-28T12:00:00Z");
  check("index + live sugar records carry posted (report date) and count as new in the week of Sep 24", () => {
    assert.equal(inIndex.posted, "2026-09-24");
    assert.equal(newsDay(inIndex), "2026-09-24");
    const live = normalizeFda("food", [sugarRaw], null)[0];
    assert.equal(live.posted, "2026-09-24");
    const s = summarize([inIndex], { loc: null, scope: "us", lastVisit: null, now });
    assert.equal(s.fresh.length, 1);
  });
  check("RSS: script text dropped, links re-serialized, javascript: refused", () => {
    const items = pr('<item><title>X Co Recalls Y</title><link>https://www.fda.gov/a" b</link><description><![CDATA[<script>alert(1)</script>Sold in Ohio.]]></description><pubDate>Fri, 25 Sep 2026 09:15:00 EDT</pubDate></item>' +
      '<item><title>Z Recalls W</title><link>javascript:alert(1)</link></item>');
    assert.equal(items.length, 1);
    assert.equal(items[0].link, "https://www.fda.gov/a%22%20b");
    assert.ok(!/alert/.test(a2i(items[0]).reason + a2i(items[0]).distribution));
  });
}

console.log(`\n${n} checks passed.`);
