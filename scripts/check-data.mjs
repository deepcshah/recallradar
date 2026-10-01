/* Data-layer checks, offline.
 *
 *   node scripts/check-data.mjs
 *
 * WHAT THIS IS NOT. It does not tell you whether a recall is in openFDA or in
 * our index — nothing offline can. That is scripts/check-live-fda.mjs, which
 * the refresh workflow runs against the real API.
 *
 * What it does check is logic: geography, verdicts, ranking, freshness,
 * parsing. The openFDA records it runs on are REAL — copied verbatim from
 * api.fda.gov responses (see the fixture's `_provenance`). The RSS fixture is
 * fictional "Example … Co." items, because it tests a parser, and its names
 * say so. Never add a hand-written record that imitates a real recall: a test
 * that passes against an invented record proves nothing about production and
 * reads as if it did.
 *
 * Exits 1 on the first failed assertion. Writes nothing.
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
import { rankMatches, relevanceOf } from "../api/_lib/lookup-rank.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = async (name) => readFile(resolve(HERE, "fixtures", name), "utf8");

const fdaFood = JSON.parse(await fixture("openfda-food-2026-09-23.json"));
const rss = await fixture("fda-recalls-rss.xml");
const NY = { stateAbbr: "NY" };
const TX = { stateAbbr: "TX" };
const MN = { stateAbbr: "MN" };
const NOW = new Date("2026-09-28T15:00:00Z");
const raw = (n) => fdaFood.results.find((r) => r.recall_number === n);

let n = 0;
function check(label, fn) {
  fn();
  n++;
  console.log(`  ok  ${label}`);
}
const show = (label, v) => console.log(`      ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

// ─────────────────────────────────────────── 1. geography on real records
console.log("\n1. verdicts on real openFDA records (report of 2026-09-23)");
const sprouts = raw("H-1339-2026");   // "MN, WI"
const dairy = raw("H-1343-2026");     // "NY"
const bread = raw("H-1304-2026");     // "New York."
const granola = raw("H-1309-2026");   // "Nationwide"
const candy = raw("H-1387-2026");     // 15 states, NY twice
const [sprNY] = normalizeFda("food", [sprouts], NY);
const [sprMN] = normalizeFda("food", [sprouts], MN);
const vSprNY = verdictFor(sprNY, NY);
const vSprMN = verdictFor(sprMN, MN);
show("Everything Sprouts, NY", `${sprNY.scope} — ${vSprNY.headline} — ${vSprNY.detail}`);
show("Everything Sprouts, MN", `${sprMN.scope} — ${vSprMN.headline}`);
check("'MN, WI' from NY: elsewhere, 'Not reported in New York', names the states, keeps the caveat", () => {
  assert.equal(sprNY.scope, "elsewhere");
  assert.equal(vSprNY.verdict, VERDICTS.NOT_LISTED);
  assert.equal(vSprNY.headline, "Not reported in New York");
  assert.match(vSprNY.detail, /Sent to MN, WI\. New York isn't listed\./);
  assert.match(vSprNY.detail, /incomplete/);
  assert.equal(isInArea(sprNY, NY), false);
});
check("'MN, WI' from MN: in area, 'Distributed in Minnesota'", () => {
  assert.equal(sprMN.scope, "state");
  assert.equal(vSprMN.verdict, VERDICTS.IN_AREA);
  assert.equal(vSprMN.headline, "Distributed in Minnesota");
});
check("'NY' is New York's and not Texas's", () => {
  assert.equal(verdictFor(normalizeFda("food", [dairy], NY)[0], NY).verdict, VERDICTS.IN_AREA);
  assert.equal(verdictFor(normalizeFda("food", [dairy], TX)[0], TX).verdict, VERDICTS.NOT_LISTED);
});
check("'New York.' (full name, trailing period) is New York", () =>
  assert.equal(verdictFor(normalizeFda("food", [bread], NY)[0], NY).verdict, VERDICTS.IN_AREA));
check("'Nationwide' reads as nationwide", () =>
  assert.equal(verdictFor(normalizeFda("food", [granola], TX)[0], TX).headline, "Distributed nationwide"));
check("a 15-state list with NY twice: deduped, includes NY and TX, not IN", () => {
  const [c] = normalizeFda("food", [candy], TX);
  assert.equal(new Set(c.states).size, c.states.length);
  assert.ok(c.states.includes("NY") && c.states.includes("TX") && !c.states.includes("IN"));
});

// ─────────────────────────────────────────── 2. build-index
console.log("\n2. build-index with the real openFDA records + the fictional RSS fixture");
const { index } = await buildIndex({
  fdaRaw: { food: fdaFood, drug: [], device: [] },
  fdaRss: rss,
  now: NOW,
  write: false,
  out: resolve(tmpdir(), "yanked-check-index-does-not-exist.json"),
});
await prepareSearch(index);
const sprIdx = index.recalls.find((r) => r.id === "fda-food-H-1339-2026");
show("index record", sprIdx);
show("sources.fda", index.sources.fda);
show("sources.fdaAnnouncements", index.sources.fdaAnnouncements);
check("every real record is in the index; 'MN, WI' has coverage 'states' [MN, WI]", () => {
  assert.equal(index.recalls.filter((r) => r.source.startsWith("FDA Food")).length, 7);
  assert.equal(sprIdx.coverage, "states");
  assert.deepEqual(sprIdx.states, ["MN", "WI"]);
  assert.equal(verdictFor(sprIdx, NY).verdict, VERDICTS.NOT_LISTED);
  assert.equal(verdictFor(sprIdx, MN).verdict, VERDICTS.IN_AREA);
});
check("searchIndex: 'sprouts' finds the sprout recall first; 'sesame' finds a Prince bread first", () => {
  assert.equal(searchIndex(index, "sprouts")[0].id, "fda-food-H-1339-2026");
  assert.match(searchIndex(index, "sesame")[0].firm, /Prince Bakery/);
});
check("sources.fda: lastUpdated is openFDA's (2026-09-23); newest is the newest report date", () => {
  assert.equal(index.sources.fda.lastUpdated, "2026-09-23");
  assert.deepEqual(index.sources.fda.lastUpdatedByKind, { food: "2026-09-23" });
  assert.equal(index.sources.fda.newest, "2026-09-23");
});
check("fsis/cpsc carry fetchedAt and newest", () => {
  for (const k of ["fsis", "cpsc"]) {
    assert.ok("fetchedAt" in index.sources[k]);
    assert.match(String(index.sources[k].newest), /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ─────────────────────────────────────────── 3. announcements (fictional RSS)
console.log("\n3. FDA announcements (fictional RSS fixture — parser behaviour only)");
const items = parseRss(rss);
show("parsed items", items.map((i) => ({ title: i.title, pubDate: i.pubDate })));
check("parser: 4 items (link-less item skipped), CDATA + entities decoded, HTML stripped", () => {
  assert.equal(items.length, 4);
  assert.equal(items[0].title, "Example Sweeteners Co. Recalls Light Brown and Powdered Sugar Because of Undeclared Wheat");
  assert.equal(items[0].pubDate, "2026-08-21");
  assert.match(items[0].description, /^Example Sweeteners Co\., of Exampleton/);
  assert.match(items[1].description, /with Listeria monocytogenes\. The company’s/);
  assert.equal(items[2].title, 'Example Bakery Co. Issues Allergy Alert on Undeclared Peanut in "Morning Glory" Muffins');
  assert.match(items[2].description, /No illnesses have been reported & the problem/);
});
const anns = index.recalls.filter((r) => r.source === "FDA announcement");
show("announcements kept in index", anns.map((a) => ({ id: a.id, firm: a.firm, date: a.date, coverage: a.coverage, states: a.states })));
check("window: the June item (>60 days) is gone", () => assert.ok(!anns.some((a) => /Example Mill/.test(a.firm))));
check("no enforcement record shares a firm with an announcement here, so none is dropped", () =>
  assert.equal(index.sources.fdaAnnouncements.droppedAsDuplicates, 0));
check("dedupe: same firm within 45 days is dropped, beyond 45 days is kept", () => {
  const a = announcementToIndex(items[0]);
  const near = { firm: "Example Sweeteners Co., Inc.", date: "2026-09-10", source: "FDA Food" };
  const far = { ...near, date: "2026-05-01" };
  assert.equal(dropAnnouncedDuplicates([a], [near]).kept.length, 0);
  assert.equal(dropAnnouncedDuplicates([a], [far]).kept.length, 1);
});
check("sameFirm: suffixes ignored; two shared words of three is not the same firm", () => {
  assert.ok(sameFirm("Example Sweeteners Co.", "Example Sweeteners Co., Inc."));
  // one distinctive word ("Example"; "Foods" is a stop word) is not enough
  assert.ok(!sameFirm("Example Foods", "Example Sweeteners Co."));
  assert.ok(sameFirm("Example Foods, Inc.", "EXAMPLE FOODS LLC"));
  assert.ok(!sameFirm("Example Valley Greens", "Example Valley Creamery"));
});
const greens = anns.find((a) => /Example Valley Greens/.test(a.firm));
const bakery = anns.find((a) => /Example Bakery/.test(a.firm));
check("home town is not distribution: 'of Kingston, New York' is 'unstated'", () => {
  assert.equal(greens.coverage, "unstated");
  assert.equal(greens.status, "announced");
  assert.equal(greens.announcement, true);
});
check("unstated announcement -> ANNOUNCED verdict, not in the NY area, not in 'new near you'", () => {
  const v = verdictFor(greens, NY);
  assert.equal(v.verdict, VERDICTS.ANNOUNCED);
  assert.equal(v.headline, "Announced, not yet classified");
  assert.equal(verdictFor(greens, null).verdict, VERDICTS.ANNOUNCED);
  assert.equal(isInArea(greens, NY), false);
  assert.ok(!recentFor(index, NY, { sinceDays: 30 }).some((r) => r.id === greens.id));
});
check("...but search shows it", () => assert.equal(searchIndex(index, "enoki")[0].id, greens.id));
check("announcement naming NY, NJ, CT -> normal geographic verdict + note", () => {
  const v = verdictFor(bakery, NY);
  assert.deepEqual(bakery.states, ["CT", "NJ", "NY"]);
  assert.equal(v.verdict, VERDICTS.IN_AREA);
  assert.equal(v.announced, true);
  assert.match(v.note, /hasn't classified/);
  assert.equal(verdictFor(bakery, TX).verdict, VERDICTS.NOT_LISTED);
});

// ─────────────────────────────────────────── 4. freshness
console.log("\n4. freshnessOf");
const fresh = freshnessOf(index, null, { now: NOW.getTime() });
show("from the index", fresh);
check("FDA uses openFDA's date (kind 'updated'), 5 days old -> not stale", () => {
  assert.deepEqual(fresh[0], { source: "FDA", asOf: "2026-09-23T00:00:00.000Z", kind: "updated", stale: false });
  assert.deepEqual(fresh.map((f) => f.source), ["FDA", "USDA FSIS", "CPSC"]);
});
check("openFDA's 2026-09-23 data is stale by 2026-10-05 (weekly feed, 10-day threshold)", () =>
  assert.equal(freshnessOf(index, null, { now: Date.parse("2026-10-05T00:00:00Z") })[0].stale, true));
const liveSources = [
  { name: "FDA Food enforcement", ok: true, count: 3, lastUpdated: "2026-09-10", fetchedAt: "2026-09-28T14:00:00Z" },
  { name: "FDA Drug enforcement", ok: false, error: "timed out" },
  { name: "USDA FSIS (meat, poultry, egg)", ok: true, count: 2, fetchedAt: "2026-09-28T14:00:00Z" },
  { name: "CPSC consumer products", ok: true, count: 9, fetchedAt: "2026-09-20T14:00:00Z" },
];
const freshLive = freshnessOf(null, liveSources, { now: NOW.getTime() });
check("live sources: FDA 18 days old -> stale; FSIS fresh; CPSC 8 days -> stale", () => {
  assert.equal(freshLive[0].stale, true);
  assert.equal(freshLive[1].stale, false);
  assert.equal(freshLive[2].stale, true);
});
check("no dates at all -> asOf null, stale", () =>
  assert.deepEqual(freshnessOf(null, null)[1], { source: "USDA FSIS", asOf: null, kind: "fetched", stale: true }));

// ─────────────────────────────────────────── 5. /api/lookup (openFDA mocked with the real records)
console.log("\n5. /api/lookup (fetch mocked; responses are the real records or openFDA's real 404 shape)");
const realFetch = globalThis.fetch;
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "No matches found!" } }; // as openFDA returns it
let mock = () => null;
const seenUrls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  seenUrls.push(u);
  const body = mock(u);
  return body
    ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify(NOT_FOUND), { status: 404 });
};
const { default: lookup } = await import("../api/lookup.js");
const ask = (query) => new Promise((done) => {
  const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { done({ code: this.code, body: b }); } };
  lookup({ query }, res);
});
const food = (u) => /api\.fda\.gov\/food\//.test(u);

mock = (u) => (food(u) ? fdaFood : null);
seenUrls.length = 0;
const sesame = await ask({ q: "sesame" });
show("query sent", decodeURIComponent(seenUrls[0]).replace(/&api_key=.*/, "").slice(0, 220));
show("sesame", { ...sesame.body, matches: sesame.body.matches.map((m) => `${m.id} r${m.relevance}`) });
check("searches product, firm and reason as a phrase; limit 100", () => {
  assert.match(seenUrls[0], /product_description:"sesame"\+OR\+recalling_firm:"sesame"\+OR\+reason_for_recall:"sesame"/);
  assert.match(seenUrls[0], /limit=100/);
});
check("'sesame': the two breads that name it lead; a 'may contain sesame' facility line is dropped", () => {
  const b = sesame.body;
  assert.deepEqual(b.matches.map((m) => m.id).sort(), ["fda-food-H-1304-2026", "fda-food-H-1306-2026"]);
  assert.ok(b.matches.every((m) => m.relevance === 3));
  assert.equal(b.matchedOn, "phrase");
  assert.equal(b.lastUpdated, "2026-09-23");
  assert.equal(lookupMatchToRecord(b.matches[0]).relevance, 3);
});
check("'sugar' against real data: nothing here is ABOUT sugar, so every ingredient mention is kept, weakly", () => {
  const ranked = rankMatches(fdaFood.results.map((r) => ({ id: r.recall_number, product: r.product_description, firm: r.recalling_firm, reason: r.reason_for_recall, reportDate: r.report_date })), "sugar");
  assert.ok(ranked.ranked.every((m) => m.relevance === 1));
  assert.equal(ranked.dropped, 0);
  // H-1309 writes "INGREDIENTS Organic … Coconut Sugar" with no colon
  assert.equal(relevanceOf({ product: granola.product_description, firm: granola.recalling_firm, reason: granola.reason_for_recall }, "sugar"), 1);
});

// A miss: openFDA 404s every search. The phrase misses, the word fallback
// runs, and the response still carries openFDA's own date from the probe.
mock = (u) => (food(u) && !/search=/.test(u) ? { meta: fdaFood.meta, results: fdaFood.results.slice(0, 1) } : null);
seenUrls.length = 0;
const miss = await ask({ q: "united sugar" });
show("urls", seenUrls.map((u) => decodeURIComponent(u).replace(/&api_key=.*/, "").slice(0, 160)));
show("miss", miss.body);
check("a miss falls back to all-words matching, then reports openFDA's date", () => {
  assert.ok(seenUrls.some((u) => /\(product_description:united\+OR\+recalling_firm:united\+OR\+reason_for_recall:united\)\+AND\+\(product_description:sugar/.test(u)));
  assert.equal(miss.body.total, 0);
  assert.equal(miss.body.matchedOn, "words");
  assert.equal(miss.body.lastUpdated, "2026-09-23");
});
globalThis.fetch = realFetch;

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
  assert.deepEqual(statesIn("IL, IN, IA, KS"), ["IA", "IL", "IN", "KS"]); // IN in a list of states is Indiana
});

// ─────────────────────────────────────────── 7. All US (/api/recalls?scope=us)
console.log("\n7. /api/recalls?scope=us (openFDA mocked with the real records; USDA/CPSC fall back to the committed snapshots)");
{
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/api\.fda\.gov\/food/.test(u)) return new Response(JSON.stringify(fdaFood), { status: 200 });
    if (/api\.fda\.gov/.test(u)) return new Response(JSON.stringify(NOT_FOUND), { status: 404 });
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
  check("scope=us keeps the MN/WI sprout recall; the NY list does not, but has the NY-only dairy recall", () => {
    assert.equal(us.code, 200);
    assert.equal(us.body.scope, "us");
    assert.ok(us.body.recalls.some((r) => r.id === "fda-food-H-1339-2026"));
    assert.ok(!ny.body.recalls.some((r) => r.id === "fda-food-H-1339-2026"));
    assert.ok(ny.body.recalls.some((r) => r.id === "fda-food-H-1343-2026"));
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
  check("H-1339 (started Aug 22, published Sep 23) carries posted and counts as new the week of Sep 23", () => {
    assert.equal(sprIdx.posted, "2026-09-23");
    assert.equal(newsDay(sprIdx), "2026-09-23");
    assert.equal(normalizeFda("food", [sprouts], null)[0].posted, "2026-09-23");
    const s = summarize([sprIdx], { loc: null, scope: "us", lastVisit: null, now });
    assert.equal(s.fresh.length, 1);
  });
  check("RSS: script text dropped, links re-serialized, javascript: refused", () => {
    const items = pr('<item><title>Example Co. Recalls Y</title><link>https://www.fda.gov/a" b</link><description><![CDATA[<script>alert(1)</script>Sold in Ohio.]]></description><pubDate>Fri, 25 Sep 2026 09:15:00 EDT</pubDate></item>' +
      '<item><title>Example Co. Recalls W</title><link>javascript:alert(1)</link></item>');
    assert.equal(items.length, 1);
    assert.equal(items[0].link, "https://www.fda.gov/a%22%20b");
    assert.ok(!/alert/.test(a2i(items[0]).reason + a2i(items[0]).distribution));
  });
}

console.log(`\n${n} checks passed.`);
