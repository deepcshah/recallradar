/* Alerts logic checks, offline.
 *
 *   node scripts/check-alerts.mjs
 *
 * LOGIC TESTS ONLY, ON SYNTHETIC DATA. Every recall below is invented and
 * says so: firms are "Example … Co.", ids are fda-food-TEST-0001 and the
 * like. Nothing here imitates a real recall, and nothing here proves anything
 * about the real index, Resend, Vercel Blob or any push service:
 *
 *   - Resend is a mocked fetch that records the request and answers
 *     { id: "test-…" }. Whether Resend accepts these requests for real is
 *     NOT tested.
 *   - Vercel Blob is an in-memory Map (memoryStore). Whether the Blob SDK
 *     calls succeed is NOT tested.
 *   - web-push's sendNotification is replaced with a recorder. Whether a
 *     push service delivers is NOT tested.
 *   - readIndex() serves a synthetic index (setIndexForTests).
 *
 * What it does check: input validation, token hashing and verification,
 * subscribe → confirm → unsubscribe (GET and RFC 8058 POST), rate limiting,
 * the recall diff engine (status, states added, nationwide, class,
 * announcement classified), the alert planner and its dedupe, and both
 * channels through the cron handler.
 *
 * Exits 1 on the first failed assertion. Writes nothing to disk.
 */
import assert from "node:assert/strict";
import * as awaitImportCrypto from "node:crypto";

// Configure BEFORE importing the handlers: some read env at import time.
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.ALERTS_FROM = "Yanked <alerts@example.test>";
process.env.ALERTS_SECRET = "test-secret-".padEnd(48, "x");
process.env.CRON_SECRET = "test-cron-secret";
process.env.ALERTS_BASE_URL = "https://yanked.example.test";
process.env.RR_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_TEST_not_real"; // never used: stores are swapped below
process.env.ALERTS_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_ALERTS_TEST_not_real"; // email needs its own private store (see emailConfig)

const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys(); // local key generation, no network
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
const pushCalls = [];
webpush.sendNotification = async (sub, payload) => { pushCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; };

const { setIndexForTests } = await import("../src/lib/index-server.js");
const { memoryStore, setPushStoreForTests, SUBS_PREFIX, validateSubscribeBody, cleanRecallIds, cleanPrefs, endpointKey } =
  await import("../src/lib/push-store.js");
const es = await import("../api/_lib/email-store.js");
const { setFetchForTests } = await import("../api/_lib/resend.js");
const { default: emailHandler } = await import("../api/_lib/email-channel.js");
const { default: digestHandler } = await import("../api/_lib/send-digest.js");
const { planAlerts, applyPlan, emailFor, pushPayloadFor, baselineSnapshots } = await import("../api/_lib/alerts-engine.js");
const { recallSnapshot, diffRecall, snapshotHash, followRelevant, isRecallId } = await import("../src/lib/recall-watch.js");
const { computeInbox } = await import("../src/lib/alerts.js");

let n = 0;
async function check(label, fn) {
  await fn();
  n++;
  console.log(`  ok  ${label}`);
}

// ------------------------------------------------------------ fixtures (SYNTHETIC)
const DAY = 86400000;
const NOW = Date.now();
const day = (offset) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);

/** A synthetic recall. Every field is invented. */
function rec(id, over = {}) {
  return {
    id, source: "FDA Food", product: `Example Product ${id} (synthetic test record)`, firm: "Example Test Foods Co.",
    reason: "Synthetic test reason: possible Listeria monocytogenes", classification: "Class II", severity: "med",
    date: day(-1), status: "active", distribution: "MN, WI", states: ["MN", "WI"], coverage: "states",
    url: "https://example.test/notice", category: "produce", reasonKey: "listeria", ...over,
  };
}
const R1 = rec("fda-food-TEST-0001");
const R2 = rec("fda-food-TEST-0002", { product: "Example Spinach Bags (synthetic)", firm: "Example Greens Co.", states: ["CA"], distribution: "CA" });
const R3 = rec("fda-food-TEST-0003", { classification: "Class I", severity: "high", states: ["CA", "NV"], distribution: "CA, NV" });
const ANN = rec("fda-ann-TEST01", {
  source: "FDA announcement", firm: "Example Sweeteners Producers Co.", classification: "Not yet classified",
  status: "announced", announcement: true, coverage: "unstated", states: [], distribution: "", date: day(-20),
});
const ENF = rec("fda-food-TEST-0004", { firm: "Example Sweeteners Producers Co.", classification: "Class I", severity: "high", date: day(-21) });
const syntheticIndex = (recalls) => ({ builtAt: new Date(NOW).toISOString(), sources: {}, lookbackDays: 365, recalls });

// ------------------------------------------------------------ mocks
const sent = []; // Resend requests
setFetchForTests(async (url, init) => {
  assert.equal(url, "https://api.resend.com/emails");
  const body = JSON.parse(init.body);
  sent.push({ headers: init.headers, body });
  return new Response(JSON.stringify({ id: `test-${sent.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
});
const emailMem = memoryStore(es.EMAIL_PREFIX);
es.setEmailStoreForTests(emailMem);
const pushMem = memoryStore(SUBS_PREFIX);
setPushStoreForTests(pushMem);

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.body = v; return this; },
    send(v) { this.body = v; return this; },
  };
}
async function call(handler, { method = "GET", query = {}, body, headers = {} }, ...extra) {
  const res = fakeRes();
  await handler({ method, query, body, headers }, res, ...extra);
  return res;
}
const linkParams = (text, action) => {
  const m = new RegExp(`action=${action}&id=([a-f0-9]{64})&t=([A-Za-z0-9_-]{43})`).exec(text);
  return m ? { id: m[1], t: m[2] } : null;
};

// ─────────────────────────────────────────── 1. validation
console.log("\n1. input validation (synthetic inputs)");
await check("email: normal addresses accepted and lower-cased", () => {
  assert.equal(es.cleanEmail("  Reader@Example.TEST "), "reader@example.test");
  assert.equal(es.cleanEmail("first.last+recalls@sub.example.co"), "first.last+recalls@sub.example.co");
});
await check("email: header injection, lists, display names, IP literals, oversize refused", () => {
  for (const bad of ["a@b.test\r\nBcc: x@y.test", "a@b.test, c@d.test", "Reader <a@b.test>", "a@[127.0.0.1]",
    "\"q\"@b.test", "a@b", "@b.test", "a@@b.test", "a@b.test ", "a b@c.test", `${"a".repeat(65)}@b.test`, `a@${"b".repeat(250)}.test`, 42, null]) {
    if (bad === "a@b.test ") continue; // trailing space is trimmed, not refused
    assert.equal(es.cleanEmail(bad), null, String(bad));
  }
});
await check("email subscribe body: unknown fields refused (no lat/zip can sneak in)", () => {
  const ok = es.validateEmailSubscribe({ email: "r@example.test", stateAbbr: "CA", follows: ["spinach"], recalls: [R1.id], prefs: { weekly: false } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.prefs, { weekly: false, urgent: true });
  assert.equal(es.validateEmailSubscribe({ email: "r@example.test", stateAbbr: "CA", zip: "00000" }).ok, false);
  assert.equal(es.validateEmailSubscribe({ email: "r@example.test", stateAbbr: "ZZ" }).ok, false);
  assert.equal(es.validateEmailSubscribe({ email: "r@example.test", stateAbbr: "CA", follows: ["x".repeat(41)] }).ok, false);
});
await check("recall ids: app-shaped ids only, ≤50, no paths or URLs", () => {
  assert.deepEqual(cleanRecallIds(["fda-food-TEST-0001", "cpsc-99999", "fsis-TEST-001-2026", "fda-ann-TEST01"]).length, 4);
  for (const bad of [["../push/subs/x"], ["https://evil.test"], ["fda-food-N/A"], ["fda-food-a..b"], [1], Array(51).fill("cpsc-1")]) {
    assert.equal(cleanRecallIds(bad), null, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(isRecallId("fda-food-TEST-0001"), true);
});
await check("prefs: booleans only, two keys only", () => {
  assert.deepEqual(cleanPrefs(undefined), { weekly: true, urgent: true });
  assert.equal(cleanPrefs({ weekly: "no" }), null);
  assert.equal(cleanPrefs({ weekly: true, email: "x" }), null);
});
await check("push body: recalls/prefs accepted, foreign endpoints still refused", () => {
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/TEST", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
  assert.equal(validateSubscribeBody({ subscription: sub, stateAbbr: "CA", follows: [], recalls: [R1.id], prefs: { urgent: false } }).ok, true);
  assert.equal(validateSubscribeBody({ subscription: { ...sub, endpoint: "https://169.254.169.254/x" }, stateAbbr: "CA" }).ok, false);
  assert.equal(validateSubscribeBody({ subscription: sub, stateAbbr: "CA", recalls: ["../x"] }).ok, false);
});

// ─────────────────────────────────────────── 2. tokens
console.log("\n2. tokens: random, stored hashed, compared in constant time");
await check("new tokens are 32 random bytes (43 base64url chars) and differ", () => {
  const a = es.newToken(); const b = es.newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
await check("tokenMatches: right token yes, wrong/garbled/empty no", () => {
  const t = es.newToken();
  const h = es.hashToken(t);
  assert.notEqual(h, t);
  assert.equal(es.tokenMatches(t, h), true);
  assert.equal(es.tokenMatches(es.newToken(), h), false);
  assert.equal(es.tokenMatches(t.slice(0, 42), h), false);
  assert.equal(es.tokenMatches(t, ""), false);
});
await check("unsubscribe token: derived from key+salt+secret, rejects another salt or key", () => {
  const secret = process.env.ALERTS_SECRET;
  const key = es.emailKey("r@example.test", secret);
  const salt = es.newToken();
  const t = es.unsubscribeToken(key, salt, secret);
  assert.equal(es.unsubscribeMatches(t, key, salt, secret), true);
  assert.equal(es.unsubscribeMatches(t, key, es.newToken(), secret), false);
  assert.equal(es.unsubscribeMatches(t, es.emailKey("s@example.test", secret), salt, secret), false);
});
await check("record key is keyed (HMAC), not a plain hash of the address", () => {
  const { createHash } = awaitImportCrypto;
  const plain = createHash("sha256").update("r@example.test").digest("hex");
  assert.notEqual(es.emailKey("r@example.test", process.env.ALERTS_SECRET), plain);
  assert.notEqual(es.emailKey("r@example.test", process.env.ALERTS_SECRET), es.emailKey("r@example.test", "another-secret".padEnd(40, "y")));
});

// ─────────────────────────────────────────── 3. email flow (mocked Resend + memory Blob)
console.log("\n3. email: subscribe → confirm → unsubscribe (Resend and Blob MOCKED)");
setIndexForTests(syntheticIndex([R1, R2, R3, ANN]));
const ADDR = "reader@example.test";
let ids;
let manage;
await check("subscribe stores a pending request, hashes the token, emails a confirm link", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "subscribe" },
    body: { email: ADDR, stateAbbr: "CA", follows: ["spinach"], recalls: [R1.id], prefs: { weekly: true, urgent: true } } }, NOW);
  assert.equal(res.statusCode, 202, JSON.stringify(res.body));
  assert.equal(res.body.status, "pending");
  manage = res.body.manage;
  assert.equal(sent.length, 1);
  const mail = sent[0].body;
  assert.deepEqual(mail.to, [ADDR]);
  assert.equal(mail.from, process.env.ALERTS_FROM);
  ids = linkParams(mail.text, "confirm");
  assert.ok(ids, "confirm link in the text part");
  assert.ok(mail.html.includes("action=confirm"));
  assert.ok(mail.headers["List-Unsubscribe"].startsWith("<https://yanked.example.test/api/push?channel=email&action=unsubscribe"));
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const stored = emailMem.data.get(es.pathFor(ids.id));
  assert.ok(stored);
  assert.ok(!stored.includes(ids.t), "plaintext confirm token is not stored");
  assert.ok(!stored.includes(manage), "plaintext manage token is not stored");
  assert.equal(JSON.parse(stored).confirmed, false);
});
await check("rate limit: a second confirmation within 2 minutes is a 429", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "subscribe" },
    body: { email: ADDR, stateAbbr: "CA" } }, NOW + 30000);
  assert.equal(res.statusCode, 429);
  assert.equal(sent.length, 1);
});
await check("rate limit: at most 3 confirmation emails a day per address", () => {
  const t0 = NOW;
  let r = { sends: [] };
  for (let i = 0; i < 3; i++) {
    const g = es.confirmSendAllowed(r, t0 + i * 5 * 60000);
    assert.equal(g.ok, true);
    r = { sends: g.sends };
  }
  assert.equal(es.confirmSendAllowed(r, t0 + 20 * 60000).ok, false);
  assert.equal(es.confirmSendAllowed(r, t0 + DAY + 60000).ok, true);
});
await check("status before confirming: pending; a wrong manage token reads as none", async () => {
  const ok = await call(emailHandler, { method: "POST", query: { channel: "email", action: "status" }, body: { id: ids.id, manage } }, NOW);
  assert.equal(ok.body.status, "pending");
  const bad = await call(emailHandler, { method: "POST", query: { channel: "email", action: "status" }, body: { id: ids.id, manage: es.newToken() } }, NOW);
  assert.equal(bad.body.status, "none");
});
await check("GET confirm only shows a button (mail scanners can't opt anyone in)", async () => {
  const res = await call(emailHandler, { method: "GET", query: { channel: "email", action: "confirm", id: ids.id, t: ids.t } }, NOW);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<form method="post"/);
  assert.match(res.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(JSON.parse(emailMem.data.get(es.pathFor(ids.id))).confirmed, false);
});
await check("a wrong or expired confirm token is refused", async () => {
  const wrong = await call(emailHandler, { method: "POST", query: { channel: "email", action: "confirm", id: ids.id, t: es.newToken() } }, NOW);
  assert.equal(wrong.statusCode, 400);
  const late = await call(emailHandler, { method: "POST", query: { channel: "email", action: "confirm", id: ids.id, t: ids.t } }, NOW + es.CONFIRM_TTL_MS + 1000);
  assert.equal(late.statusCode, 400);
});
await check("POST confirm confirms, applies the pending settings, snapshots followed recalls from the index", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "confirm", id: ids.id, t: ids.t } }, NOW);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /You&#39;re subscribed/);
  const r = JSON.parse(emailMem.data.get(es.pathFor(ids.id)));
  assert.equal(r.confirmed, true);
  assert.equal(r.pending, null);
  assert.deepEqual(r.follows, ["spinach"]);
  assert.deepEqual(Object.keys(r.snapshots), [R1.id]);
  assert.deepEqual(r.snapshots[R1.id].st, ["MN", "WI"]);
  // Only the documented fields are stored.
  const allowed = new Set(["email", "stateAbbr", "follows", "recalls", "snapshots", "prefs", "confirmed", "confirmedAt",
    "manageHash", "manageHashes", "restore", "unsubSalt", "pending", "sends", "lastSentIds", "createdAt", "updatedAt"]);
  for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected stored field ${k}`);
  // single use
  const again = await call(emailHandler, { method: "POST", query: { channel: "email", action: "confirm", id: ids.id, t: ids.t } }, NOW);
  assert.equal(again.statusCode, 400);
});
await check("update with the manage token changes follows; status now confirmed", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "update" },
    body: { id: ids.id, manage, follows: ["spinach", "example greens"], recalls: [R1.id, ANN.id] } }, NOW);
  assert.equal(res.body.status, "confirmed");
  const r = JSON.parse(emailMem.data.get(es.pathFor(ids.id)));
  assert.deepEqual(r.follows, ["spinach", "example greens"]);
  assert.ok(r.snapshots[ANN.id].a, "announcement snapshot marked");
});
await check("someone re-subscribing a confirmed address can't take it over or delete it", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "subscribe" },
    body: { email: ADDR, stateAbbr: "TX" } }, NOW + 10 * 60000);
  assert.equal(res.statusCode, 202);
  const r = JSON.parse(emailMem.data.get(es.pathFor(ids.id)));
  assert.equal(r.stateAbbr, "CA", "live settings unchanged until the owner confirms");
  const rm = await call(emailHandler, { method: "POST", query: { channel: "email", action: "remove" }, body: { id: res.body.id, manage: res.body.manage } }, NOW);
  assert.equal(rm.body.status, "none");
  assert.ok(emailMem.data.has(es.pathFor(ids.id)), "confirmed record survives a pending token's remove");
});

// ─────────────────────────────────────────── 3b. restore follows to a wiped browser
console.log("\n3b. email: restore follows to a browser that lost them (Resend and Blob MOCKED)");
const restoreParams = (text) => {
  const m = /\/\?restore=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})/.exec(text);
  return m ? { id: m[1], token: m[2] } : null;
};
const T1 = NOW + 20 * 60000;
let restoreLink;
await check("restore-request for an address with no subscription: same 202, no email sent", async () => {
  const before = sent.length;
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore-request" },
    body: { email: "nobody@example.test" } }, T1);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "sent-if-subscribed");
  assert.equal(sent.length, before);
});
await check("restore-request for a confirmed address: same 202, emails a single-use link, stores only its hash", async () => {
  const before = sent.length;
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore-request" },
    body: { email: ADDR } }, T1);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "sent-if-subscribed");
  assert.equal(sent.length, before + 1);
  const mail = sent[sent.length - 1].body;
  assert.deepEqual(mail.to, [ADDR]);
  restoreLink = restoreParams(mail.text);
  assert.ok(restoreLink && restoreLink.id === ids.id, "restore link in the text part");
  assert.ok(mail.headers["List-Unsubscribe"]);
  const stored = emailMem.data.get(es.pathFor(ids.id));
  assert.ok(!stored.includes(restoreLink.token), "plaintext restore token is not stored");
});
await check("restore-request shares the confirmation rate limit, and says nothing different when limited", async () => {
  const before = sent.length;
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore-request" },
    body: { email: ADDR } }, T1 + 30000);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "sent-if-subscribed");
  assert.equal(sent.length, before);
});
await check("restore with a wrong token: 410, nothing handed out", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore" },
    body: { id: ids.id, token: es.newToken() } }, T1);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.follows, undefined);
});
let restoredManage;
await check("restore returns the follows and a NEW manage token; the old browser's token still works", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore" },
    body: { id: restoreLink.id, token: restoreLink.token } }, T1 + 60000);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.email, ADDR);
  assert.deepEqual(res.body.follows, ["spinach", "example greens"]);
  assert.deepEqual(res.body.recalls.map((r) => r.id), [R1.id, ANN.id]);
  assert.ok(res.body.recalls[0].title.length > 0, "title from the (synthetic) index");
  assert.equal(res.body.stateAbbr, "CA");
  restoredManage = res.body.manage;
  assert.notEqual(restoredManage, manage);
  for (const m of [restoredManage, manage]) {
    const st = await call(emailHandler, { method: "POST", query: { channel: "email", action: "status" }, body: { id: ids.id, manage: m } }, T1);
    assert.equal(st.body.status, "confirmed");
  }
  const stored = emailMem.data.get(es.pathFor(ids.id));
  assert.ok(!stored.includes(restoredManage), "plaintext manage token is not stored");
});
await check("a new subscribe request for the address keeps the restored device's access", async () => {
  const before = await call(emailHandler, { method: "POST", query: { channel: "email", action: "subscribe" },
    body: { email: ADDR, stateAbbr: "TX" } }, NOW + DAY + 5 * 60000);
  assert.equal(before.statusCode, 202);
  const st = await call(emailHandler, { method: "POST", query: { channel: "email", action: "status" }, body: { id: ids.id, manage: restoredManage } }, NOW + DAY + 6 * 60000);
  assert.equal(st.body.status, "confirmed");
});
await check("a restore link works once", async () => {
  const res = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore" },
    body: { id: restoreLink.id, token: restoreLink.token } }, T1 + 90000);
  assert.equal(res.statusCode, 410);
});
await check("a restore link expires after 30 minutes", async () => {
  const T2 = NOW + DAY + 60 * 60000; // past the day's confirmation-email budget
  const req = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore-request" }, body: { email: ADDR } }, T2);
  assert.equal(req.statusCode, 202);
  const link = restoreParams(sent[sent.length - 1].body.text);
  assert.ok(link);
  const late = await call(emailHandler, { method: "POST", query: { channel: "email", action: "restore" },
    body: { id: link.id, token: link.token } }, T2 + es.RESTORE_TTL_MS + 1000);
  assert.equal(late.statusCode, 410);
});
await check("at most 5 devices: the oldest manage token drops off", () => {
  const rec = { manageHash: "a".repeat(64), manageHashes: ["b", "c", "d", "e", "f"].map((c) => c.repeat(64)) };
  const kept = [...es.manageHashesOf(rec), "0".repeat(64)].slice(-es.MAX_MANAGE_TOKENS);
  assert.equal(kept.length, 5);
  assert.ok(!kept.includes("a".repeat(64)));
});
await check("restore bodies: unknown fields and malformed tokens refused", () => {
  assert.equal(es.validateRestoreRequest({ email: ADDR, follows: [] }).ok, false);
  assert.equal(es.validateRestore({ id: ids.id, token: "short" }).ok, false);
  assert.equal(es.validateRestore({ id: "x", token: es.newToken() }).ok, false);
});

// ─────────────────────────────────────────── 4. diff engine
console.log("\n4. recall diff engine (synthetic records)");
await check("no previous snapshot: a baseline, never an update", () => {
  const out = diffRecall(null, R1);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.next.st, ["MN", "WI"]);
});
await check("status: active → ended is reported", () => {
  const out = diffRecall(recallSnapshot(R1), { ...R1, status: "ended" });
  assert.deepEqual(out.changes.map((c) => c.kind), ["status"]);
  assert.equal(out.changes[0].to, "ended");
});
await check("distribution: states added are reported (and only the added ones)", () => {
  const out = diffRecall(recallSnapshot(R1), { ...R1, states: ["IA", "MN", "WI"], distribution: "MN, WI, IA" });
  assert.deepEqual(out.changes, [{ kind: "states", added: ["IA"] }]);
});
await check("distribution: a state disappearing is NOT announced (never a false all-clear)", () => {
  const out = diffRecall(recallSnapshot(R1), { ...R1, states: ["MN"], distribution: "MN" });
  assert.equal(out.changes.length, 0);
});
await check("distribution: widened to nationwide", () => {
  const out = diffRecall(recallSnapshot(R1), { ...R1, coverage: "nationwide", states: [], distribution: "Nationwide" });
  assert.deepEqual(out.changes.map((c) => c.kind), ["nationwide"]);
});
await check("classification: Class II → Class I", () => {
  const out = diffRecall(recallSnapshot(R1), { ...R1, classification: "Class I", severity: "high" });
  assert.deepEqual(out.changes, [{ kind: "class", from: "II", to: "I" }]);
});
await check("announcement → enforcement record (same firm, within 45 days) is 'classified'", () => {
  const out = diffRecall(recallSnapshot(ANN), null, [R1, ENF]);
  assert.equal(out.changes[0].kind, "classified");
  assert.equal(out.record.id, ENF.id);
  assert.equal(out.next.m, ENF.id);
  // …and a different firm doesn't match
  const none = diffRecall(recallSnapshot(ANN), null, [R1, { ...ENF, firm: "Another Example Bakery Co." }]);
  assert.equal(none.changes.length, 0);
});
await check("snapshot hash changes with the change and not otherwise", () => {
  assert.equal(snapshotHash(recallSnapshot(R1)), snapshotHash(recallSnapshot({ ...R1, product: "renamed" })));
  assert.notEqual(snapshotHash(recallSnapshot(R1)), snapshotHash(recallSnapshot({ ...R1, status: "ended" })));
});
await check("follow relevance: in-state or unstated yes; other states only no; ended never", () => {
  assert.equal(followRelevant(R2, "CA"), true);
  assert.equal(followRelevant(R1, "CA"), false);
  assert.equal(followRelevant({ ...R1, coverage: "unstated", states: [], distribution: "" }, "CA"), true);
  assert.equal(followRelevant({ ...R2, status: "ended" }, "CA"), false);
});

// ─────────────────────────────────────────── 5. planner + dedupe
console.log("\n5. alert planner and dedupe (pure)");
const baseSub = (over = {}) => ({ stateAbbr: "CA", follows: [], recalls: [], snapshots: {}, prefs: { weekly: true, urgent: true }, lastSentIds: [], ...over });
await check("urgent: serious in-state recall + follow match + recall update in one plan", () => {
  const idx = syntheticIndex([R1, R2, R3, { ...R1, id: "fda-food-TEST-0009", status: "ended" }]);
  const sub = baseSub({ follows: ["example spinach"], recalls: [R1.id], snapshots: { [R1.id]: recallSnapshot({ ...R1, status: "active" }) } });
  const idx2 = syntheticIndex([{ ...R1, status: "ended" }, R2, R3]);
  const plan = planAlerts(sub, idx2, "urgent", NOW);
  assert.equal(plan.send, true);
  assert.deepEqual(plan.items.map((x) => x.kind).sort(), ["follow", "serious"]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].changes[0].to, "ended");
  assert.ok(idx); // (first index unused: kept to show ended records never alert)
});
await check("dedupe: after a successful send, the same run plans nothing", () => {
  const idx = syntheticIndex([{ ...R1, status: "ended" }, R2, R3]);
  const sub = baseSub({ follows: ["example spinach"], recalls: [R1.id], snapshots: { [R1.id]: recallSnapshot(R1) } });
  const plan = planAlerts(sub, idx, "urgent", NOW);
  const after = applyPlan(sub, plan, NOW);
  assert.ok(after.lastSentIds.includes(R3.id) && after.lastSentIds.some((k) => k.startsWith(`u:${R1.id}:`)));
  assert.equal(planAlerts(after, idx, "urgent", NOW), null);
});
await check("dedupe: an update already sent (write retried) moves the baseline but sends nothing", () => {
  const idx = syntheticIndex([{ ...R1, status: "ended" }]);
  const next = recallSnapshot({ ...R1, status: "ended" });
  const sub = baseSub({ recalls: [R1.id], snapshots: { [R1.id]: recallSnapshot(R1) }, lastSentIds: [`u:${R1.id}:${snapshotHash(next)}`] });
  const plan = planAlerts(sub, idx, "urgent", NOW);
  assert.equal(plan.send, false);
  assert.equal(plan.snapshots[R1.id].s, "ended");
});
await check("a first snapshot is taken silently (send:false), and pruned when unfollowed", () => {
  const idx = syntheticIndex([R1]);
  const p = planAlerts(baseSub({ recalls: [R1.id] }), idx, "urgent", NOW);
  assert.equal(p.send, false);
  assert.ok(p.snapshots[R1.id]);
  const q = planAlerts(baseSub({ recalls: [], snapshots: { [R1.id]: recallSnapshot(R1) } }), idx, "urgent", NOW);
  assert.deepEqual(q.snapshots, {});
});
await check("prefs: urgent off drops serious recalls, keeps follow matches; weekly off sends no digest", () => {
  const idx = syntheticIndex([R2, R3]);
  const plan = planAlerts(baseSub({ follows: ["example spinach"], prefs: { weekly: false, urgent: false } }), idx, "urgent", NOW);
  assert.deepEqual(plan.items.map((x) => x.kind), ["follow"]);
  assert.equal(planAlerts(baseSub({ prefs: { weekly: false, urgent: true } }), idx, "weekly", NOW), null);
});
await check("weekly: counts the week, sends once (dedupe)", () => {
  const idx = syntheticIndex([R2, R3]);
  const plan = planAlerts(baseSub(), idx, "weekly", NOW);
  assert.equal(plan.weekly.week.length, 2);
  assert.equal(planAlerts(applyPlan(baseSub(), plan, NOW), idx, "weekly", NOW), null);
});
await check("renderers: email has unsubscribe link + escaped text; push stays same-origin", () => {
  const idx = syntheticIndex([{ ...R3, product: "Example <script>alert(1)</script> Bars (synthetic)" }]);
  const plan = planAlerts(baseSub(), idx, "urgent", NOW);
  const m = emailFor(plan, { baseUrl: "https://yanked.example.test", unsubscribeUrl: "https://yanked.example.test/u?x=1" });
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes("https://yanked.example.test/u?x=1") && m.text.includes("Unsubscribe"));
  assert.ok(!/\bsafe\b/i.test(m.text), "never says safe");
  const p = pushPayloadFor(plan);
  assert.ok(p.url.startsWith("/"));
});
await check("baselineSnapshots keeps old baselines, adds new ids from the index, drops unknown", () => {
  const idx = syntheticIndex([R1, R2]);
  const old = { [R1.id]: recallSnapshot({ ...R1, states: ["MN"] }) };
  const out = baselineSnapshots([R1.id, R2.id, "cpsc-00000"], idx, old);
  assert.deepEqual(out[R1.id].st, ["MN"]);
  assert.ok(out[R2.id]);
  assert.equal(out["cpsc-00000"], undefined);
});

// ─────────────────────────────────────────── 6. inbox (client, pure)
console.log("\n6. in-app inbox (pure, synthetic)");
await check("inbox: updates for followed recalls + new term matches since the marker", () => {
  const out = computeInbox({
    records: [{ ...R1, status: "ended" }, R2, { ...R2, id: "fda-food-TEST-0005", date: day(-40) }],
    terms: ["example spinach"],
    followed: [{ id: R1.id, title: "x", snap: recallSnapshot(R1) }],
    since: new Date(NOW - 7 * DAY).toISOString(),
    stateAbbr: "CA",
    now: NOW,
  });
  assert.equal(out.updates.length, 1);
  assert.equal(out.matches.length, 1);
  assert.deepEqual(out.matches[0].records.map((r) => r.id), [R2.id], "old match is not 'new'");
  assert.equal(out.count, 2);
});

// ─────────────────────────────────────────── 7. cron, both channels
console.log("\n7. cron handler: both channels (Resend, Blob, web-push MOCKED)");
await check("refuses without CRON_SECRET bearer", async () => {
  const res = await call(digestHandler, { query: { action: "digest", mode: "urgent" } });
  assert.equal(res.statusCode, 401);
});
await check("urgent run: one email + one push, each with the update; second run sends nothing", async () => {
  // Push subscriber following R1 too.
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/TEST-ENDPOINT", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
  await pushMem.write(endpointKey(sub.endpoint), {
    subscription: sub, stateAbbr: "CA", follows: [], recalls: [R1.id], snapshots: { [R1.id]: recallSnapshot(R1) },
    prefs: { weekly: true, urgent: false }, lastSentIds: [],
  });
  setIndexForTests(syntheticIndex([{ ...R1, status: "ended" }, R2]));
  const before = sent.length;
  const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  const res = await call(digestHandler, { query: { action: "digest", mode: "urgent" }, headers: auth });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.email.sent, 1, JSON.stringify(res.body.email));
  assert.equal(res.body.push.sent, 1, JSON.stringify(res.body.push));
  const mail = sent[sent.length - 1];
  assert.equal(sent.length, before + 1);
  assert.match(mail.body.subject, /Example Spinach|Closed|update/i);
  assert.ok(mail.body.headers["List-Unsubscribe"]);
  assert.ok(mail.headers["Idempotency-Key"]);
  assert.equal(pushCalls.length, 1);
  assert.match(pushCalls[0].payload.title, /Closed by the agency|update/i);
  const again = await call(digestHandler, { query: { action: "digest", mode: "urgent" }, headers: auth });
  assert.equal(again.body.email.sent, 0);
  assert.equal(again.body.push.sent, 0);
  assert.equal(sent.length, before + 1);
  assert.equal(pushCalls.length, 1);
});
await check("dry run previews without addresses or endpoints", async () => {
  setIndexForTests(syntheticIndex([R2, R3]));
  const res = await call(digestHandler, { query: { action: "digest", mode: "weekly", dry: "1" }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const blob = JSON.stringify(res.body);
  assert.ok(!blob.includes(ADDR) && !blob.includes("fcm.googleapis.com"));
});
await check("one-click unsubscribe: POST from the List-Unsubscribe URL deletes the record", async () => {
  const mail = sent[sent.length - 1];
  const u = linkParams(mail.body.headers["List-Unsubscribe"], "unsubscribe");
  assert.ok(u);
  const bad = await call(emailHandler, { method: "POST", query: { channel: "email", action: "unsubscribe", id: u.id, t: es.newToken() }, body: { "List-Unsubscribe": "One-Click" } });
  assert.equal(bad.statusCode, 400);
  assert.ok(emailMem.data.has(es.pathFor(u.id)));
  const ok = await call(emailHandler, { method: "POST", query: { channel: "email", action: "unsubscribe", id: u.id, t: u.t }, body: { "List-Unsubscribe": "One-Click" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(emailMem.data.has(es.pathFor(u.id)), false);
  const again = await call(emailHandler, { method: "GET", query: { channel: "email", action: "unsubscribe", id: u.id, t: u.t } });
  assert.equal(again.statusCode, 200, "idempotent");
});
await check("unconfirmed records older than a week are removed by the daily run", async () => {
  const key = es.emailKey("stale@example.test", process.env.ALERTS_SECRET);
  await emailMem.write(es.pathFor(key), { email: "stale@example.test", confirmed: false, createdAt: new Date(NOW - 8 * DAY).toISOString() });
  await call(digestHandler, { query: { action: "digest", mode: "urgent" }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(emailMem.data.has(es.pathFor(key)), false);
});

setIndexForTests(null);
setFetchForTests(null);
{
  const { emailConfig } = await import("../api/_lib/email-store.js");
  await check("email stays off without its own private Blob store (addresses must not sit in public files)", async () => {
    const env = { ...process.env, ALERTS_BLOB_READ_WRITE_TOKEN: "" };
    const c = emailConfig(env);
    assert.equal(c.ok, false);
    assert.match(c.reason, /private Blob store/);
    assert.equal(emailConfig(process.env).ok, true);
  });
}

console.log(`\n${n} alert logic checks passed (synthetic data; Resend, Blob and push services mocked — not tested for real).`);
