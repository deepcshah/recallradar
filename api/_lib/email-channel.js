/* Email alerts, dispatched from api/push.js as `?channel=email&action=…`
 * (Vercel Hobby deploys at most twelve functions; this rides on push's).
 *
 *   POST ?channel=email&action=subscribe    { email, stateAbbr, follows, recalls, prefs }
 *        -> stores a PENDING request and emails a confirmation link.
 *           { ok, status:"pending", id, manage }  — the same answer whether
 *           or not the address was already subscribed, so the endpoint can't
 *           be used to find out who is.
 *   GET  ?channel=email&action=confirm&id=…&t=…
 *        -> a small page with one "Confirm" button. NOT a confirmation by
 *           itself: mail scanners (Outlook Safe Links, corporate gateways)
 *           fetch every link in a message, and a GET that confirmed would
 *           opt people in without them ever seeing it. The button POSTs.
 *   POST ?channel=email&action=confirm&id=…&t=…   -> confirms; page.
 *   GET  ?channel=email&action=unsubscribe&id=…&t=…   -> unsubscribes; page.
 *   POST ?channel=email&action=unsubscribe&id=…&t=…   -> same, RFC 8058
 *        one-click (what Gmail/Apple Mail send from List-Unsubscribe-Post).
 *        Unsubscribing deletes the record — address and all.
 *   POST ?channel=email&action=update   { id, manage, stateAbbr?, follows?, recalls?, prefs? }
 *   POST ?channel=email&action=status   { id, manage }  -> { status: pending|confirmed|none }
 *   POST ?channel=email&action=remove   { id, manage }  -> deletes (the app's "Turn off")
 *
 * The unsubscribe link answers a GET on purpose — the README's promise is one
 * click — and the cost of a scanner unsubscribing someone is an email they
 * stop getting, which they can undo from the app; the cost of a scanner
 * CONFIRMING someone is mail they never agreed to. Hence the asymmetry.
 *
 * Tokens, keys and the stored record: see email-store.js.
 */
import {
  emailConfig, emailStore, validateEmailSubscribe, validateEmailManage, emailKey, pathFor, newToken, hashToken,
  tokenMatches, unsubscribeToken, unsubscribeMatches, confirmSendAllowed, isKey, isToken, CONFIRM_TTL_MS,
} from "./email-store.js";
import { sendEmail } from "./resend.js";
import { baselineSnapshots, escapeHtml } from "./alerts-engine.js";
import { readIndex } from "../../src/lib/index-server.js";
import { ABBR_TO_NAME } from "../../src/lib/states.js";

const MAX_BODY_CHARS = 8192; // 50 recall ids of up to 80 chars, 20 terms, a subscription

function parseJson(req) {
  let b = req.body;
  if (typeof b === "string") {
    if (b.length > MAX_BODY_CHARS) return { tooLarge: true };
    try { b = JSON.parse(b); } catch (_) { return { invalid: true }; }
  } else if (b && typeof b === "object") {
    try { if (JSON.stringify(b).length > MAX_BODY_CHARS) return { tooLarge: true }; } catch (_) { return { invalid: true }; }
  }
  return { body: b };
}

// ------------------------------------------------------------ links
export function linksFor(cfg, key, record) {
  const q = (action, t) => `${cfg.baseUrl}/api/push?channel=email&action=${action}&id=${key}&t=${encodeURIComponent(t)}`;
  return {
    unsubscribeUrl: q("unsubscribe", unsubscribeToken(key, record.unsubSalt, cfg.secret)),
    confirmUrl: (token) => q("confirm", token),
  };
}

/** Headers every email carries (RFC 2369 + RFC 8058). */
export function unsubscribeHeaders(url) {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ------------------------------------------------------------ pages
/** A tiny self-contained page. No scripts, no external anything; the CSP
 *  says so. Colours are the app's tokens, light and dark. */
export function page(res, status, { title, body, form }) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const h = escapeHtml;
  const formHtml = form
    ? `<form method="post" action="${h(form.action)}"><button type="submit">${h(form.label)}</button></form>`
    : "";
  return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${h(title)} · Yanked</title>
<style>
:root{--bg:#f1f1f1;--card:#fff;--line:#e3e3e3;--text:#1a1a1a;--muted:#616161;--accent:#1f7a4c;--ink:#fff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a1a;--card:#292929;--line:#3a3a3a;--text:#e3e3e3;--muted:#b5b5b5;--accent:#4fca85;--ink:#0b1f14}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
main{max-width:440px;margin:12vh auto 0;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
p.k{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{margin:0 0 8px;font-size:20px;line-height:1.3}p{margin:0 0 12px;color:var(--muted)}
button{font:inherit;font-weight:600;border:0;border-radius:10px;background:var(--accent);color:var(--ink);padding:12px 18px;width:100%;cursor:pointer}
a{color:var(--accent)}
</style></head><body><main><div class="card"><p class="k">Yanked alerts</p><h1>${h(title)}</h1>${body.map((x) => `<p>${h(x)}</p>`).join("")}${formHtml}</div>
<p style="margin-top:14px;font-size:13px"><a href="/">Open Yanked</a></p></main></body></html>`);
}

// ------------------------------------------------------------ handlers
async function handleSubscribe(req, res, cfg, now) {
  const parsed = parseJson(req);
  if (parsed.tooLarge) return res.status(413).json({ error: "Body too large." });
  if (parsed.invalid) return res.status(400).json({ error: "Body must be JSON." });
  const v = validateEmailSubscribe(parsed.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { email, stateAbbr, follows, recalls, prefs } = v.value;
  const store = emailStore();
  const key = emailKey(email, cfg.secret);
  const path = pathFor(key);

  let record;
  try { record = await store.read(path); } catch (_) { record = null; }
  const gate = confirmSendAllowed(record, now);
  if (!gate.ok) {
    res.setHeader("Retry-After", String(gate.retryAfter));
    return res.status(429).json({ error: "A confirmation email was sent to this address recently. Check your inbox (and spam), or try again later." });
  }

  const confirmToken = newToken();
  const manage = newToken();
  const nowIso = new Date(now).toISOString();
  const next = {
    email,
    stateAbbr: (record && record.stateAbbr) || stateAbbr,
    follows: (record && record.follows) || [],
    recalls: (record && record.recalls) || [],
    snapshots: (record && record.snapshots) || {},
    prefs: (record && record.prefs) || prefs,
    confirmed: Boolean(record && record.confirmed),
    ...(record && record.confirmedAt ? { confirmedAt: record.confirmedAt } : null),
    manageHash: (record && record.manageHash) || null,
    unsubSalt: (record && record.unsubSalt) || newToken(),
    // The new settings wait here until the address owner confirms them.
    pending: {
      tokenHash: hashToken(confirmToken),
      manageHash: hashToken(manage),
      stateAbbr, follows, recalls, prefs,
      expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString(),
    },
    sends: gate.sends,
    lastSentIds: (record && record.lastSentIds) || [],
    createdAt: (record && record.createdAt) || nowIso,
    updatedAt: nowIso,
  };
  try {
    await store.write(path, next);
  } catch (err) {
    return res.status(502).json({ error: `Could not save: ${String((err && err.message) || err).slice(0, 160)}` });
  }

  const links = linksFor(cfg, key, next);
  const confirmUrl = links.confirmUrl(confirmToken);
  const stateName = ABBR_TO_NAME[stateAbbr] || stateAbbr;
  const lines = [
    `Someone — hopefully you — asked Yanked to email recall alerts for ${stateName} to this address.`,
    "Nothing will be sent until you confirm. If this wasn't you, ignore this email; the request expires in 48 hours.",
  ];
  const sent = await sendEmail({
    apiKey: cfg.apiKey,
    from: cfg.from,
    to: email,
    subject: "Confirm your Yanked recall alerts",
    text: `${lines.join("\n\n")}\n\nConfirm: ${confirmUrl}\n\nDon't want these? ${links.unsubscribeUrl}\n`,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#f1f1f1;margin:0">
<div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:20px">
<h1 style="margin:0 0 12px;font-size:20px">Confirm your recall alerts</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#3a3a3a">${escapeHtml(l)}</p>`).join("")}
<p style="margin:16px 0"><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#1f7a4c;color:#fff;font-weight:600;text-decoration:none;padding:12px 18px;border-radius:10px">Confirm alerts</a></p>
<p style="margin:0;font-size:12px;color:#6d6d6d"><a href="${escapeHtml(links.unsubscribeUrl)}" style="color:#1f7a4c">Unsubscribe</a></p>
</div></div></body></html>`,
    headers: unsubscribeHeaders(links.unsubscribeUrl),
  });
  if (!sent.ok) {
    return res.status(502).json({ error: "We couldn't send the confirmation email. Check the address and try again in a few minutes." });
  }
  return res.status(202).json({ ok: true, status: "pending", id: key, manage });
}

function readTokens(req) {
  const q = req.query || {};
  return { key: String(q.id || ""), token: String(q.t || "") };
}

async function handleConfirm(req, res, cfg, method, now) {
  const { key, token } = readTokens(req);
  const invalid = () => page(res, 400, {
    title: "This link doesn't work",
    body: ["It may have expired (links last 48 hours), been used already, or been copied incompletely. Ask for a new one from the Alerts section of the app."],
  });
  if (!isKey(key) || !isToken(token)) return invalid();
  const store = emailStore();
  const path = pathFor(key);
  let record;
  try { record = await store.read(path); } catch (_) { record = null; }
  const p = record && record.pending;
  const live = p && Date.parse(p.expiresAt) > now && tokenMatches(token, p.tokenHash);
  if (!live) return invalid();

  if (method !== "POST") {
    // See the top of this file: a GET only shows the button.
    return page(res, 200, {
      title: "Confirm your recall alerts",
      body: [`Email alerts for ${ABBR_TO_NAME[p.stateAbbr] || p.stateAbbr} will go to the address this link was sent to.`],
      form: { action: `/api/push?channel=email&action=confirm&id=${key}&t=${encodeURIComponent(token)}`, label: "Confirm alerts" },
    });
  }

  const index = await readIndex().catch(() => null);
  const nowIso = new Date(now).toISOString();
  const next = {
    ...record,
    stateAbbr: p.stateAbbr,
    follows: p.follows,
    recalls: p.recalls,
    snapshots: baselineSnapshots(p.recalls, index, record.snapshots || {}),
    prefs: p.prefs,
    confirmed: true,
    confirmedAt: record.confirmedAt || nowIso,
    manageHash: p.manageHash,
    pending: null,
    updatedAt: nowIso,
  };
  try {
    await store.write(path, next);
  } catch (_) {
    return page(res, 502, { title: "Something went wrong", body: ["We couldn't save your confirmation. Please try the link again in a minute."] });
  }
  const what = [next.prefs.weekly && "a weekly digest", next.prefs.urgent && "serious recalls as they appear"].filter(Boolean);
  return page(res, 200, {
    title: "You're subscribed",
    body: [
      `Yanked will email ${what.length ? what.join(" and ") : "updates"} for ${ABBR_TO_NAME[next.stateAbbr] || next.stateAbbr}` +
        `${next.follows.length || next.recalls.length ? ", plus anything new about what you follow" : ""}.`,
      "Every email has a one-click unsubscribe link.",
    ],
  });
}

async function handleUnsubscribe(req, res, cfg, method) {
  const { key, token } = readTokens(req);
  const store = emailStore();
  const done = () => page(res, 200, {
    title: "You're unsubscribed",
    body: ["Your address and alert settings have been deleted. You can turn alerts back on from the app at any time."],
  });
  if (!isKey(key) || !isToken(token)) {
    return page(res, 400, { title: "This link doesn't work", body: ["It looks incomplete. Use the unsubscribe link in the most recent email, or turn email alerts off in the app."] });
  }
  let record;
  try { record = await store.read(pathFor(key)); } catch (_) { record = null; }
  // Already gone: still a success — the reader's intent is satisfied.
  if (!record) return done();
  if (!unsubscribeMatches(token, key, record.unsubSalt, cfg.secret)) {
    return page(res, 400, { title: "This link doesn't work", body: ["Use the unsubscribe link in the most recent email, or turn email alerts off in the app."] });
  }
  try {
    await store.remove(pathFor(key));
  } catch (_) {
    return page(res, 502, { title: "Something went wrong", body: ["We couldn't process that just now. Please try the link again in a minute."] });
  }
  return done();
}

async function authorized(body, update) {
  const v = validateEmailManage(body, { update });
  if (!v.ok) return { status: 400, error: v.error };
  const store = emailStore();
  const path = pathFor(v.value.id);
  let record;
  try { record = await store.read(path); } catch (_) { record = null; }
  if (!record) return { status: 200, none: true, value: v.value, path };
  const okLive = record.manageHash && tokenMatches(v.value.manage, record.manageHash);
  const okPending = record.pending && tokenMatches(v.value.manage, record.pending.manageHash);
  if (!okLive && !okPending) return { status: 200, none: true, value: v.value, path };
  return { record, value: v.value, path, live: okLive };
}

async function handleManage(req, res, action, now) {
  const parsed = parseJson(req);
  if (parsed.tooLarge) return res.status(413).json({ error: "Body too large." });
  if (parsed.invalid) return res.status(400).json({ error: "Body must be JSON." });
  const a = await authorized(parsed.body, action === "update");
  if (a.error) return res.status(a.status).json({ error: a.error });
  // A wrong token and a missing record look the same: "none".
  if (a.none) return res.status(200).json({ ok: true, status: "none" });
  const store = emailStore();

  if (action === "status") {
    return res.status(200).json({ ok: true, status: a.live && a.record.confirmed ? "confirmed" : "pending" });
  }
  if (action === "remove") {
    /* A manage token that is only PENDING (someone asked to subscribe this
     * address and it hasn't been confirmed) may withdraw that request, never
     * delete a confirmed subscription it didn't create. */
    if (!a.live && a.record.confirmed) {
      try { await store.write(a.path, { ...a.record, pending: null, updatedAt: new Date(now).toISOString() }); } catch (_) { /* best effort */ }
      return res.status(200).json({ ok: true, status: "none" });
    }
    try { await store.remove(a.path); } catch (err) {
      return res.status(502).json({ error: `Could not remove: ${String((err && err.message) || err).slice(0, 160)}` });
    }
    return res.status(200).json({ ok: true, status: "none" });
  }
  // update
  const { stateAbbr, follows, recalls, prefs } = a.value;
  const patch = {};
  if (stateAbbr !== undefined) patch.stateAbbr = stateAbbr;
  if (follows !== undefined) patch.follows = follows;
  if (recalls !== undefined) patch.recalls = recalls;
  if (prefs !== undefined) patch.prefs = prefs;
  let next;
  if (a.live && a.record.confirmed) {
    next = { ...a.record, ...patch, updatedAt: new Date(now).toISOString() };
    if (recalls !== undefined) {
      const index = await readIndex().catch(() => null);
      next.snapshots = baselineSnapshots(recalls, index, a.record.snapshots || {});
    }
  } else {
    // Not confirmed yet: the change applies to the pending request.
    next = { ...a.record, pending: { ...a.record.pending, ...patch }, updatedAt: new Date(now).toISOString() };
  }
  try { await store.write(a.path, next); } catch (err) {
    return res.status(502).json({ error: `Could not save: ${String((err && err.message) || err).slice(0, 160)}` });
  }
  return res.status(200).json({ ok: true, status: a.live && a.record.confirmed ? "confirmed" : "pending" });
}

export default async function emailHandler(req, res, now = Date.now()) {
  res.setHeader("Cache-Control", "no-store");
  const action = String((req.query || {}).action || "");
  const method = String(req.method || "GET").toUpperCase();
  const cfg = emailConfig();
  if (!cfg.ok) {
    if (action === "confirm" || action === "unsubscribe") {
      return page(res, 503, { title: "Email alerts are switched off", body: ["This site isn't sending email right now, so there is nothing to confirm or unsubscribe from."] });
    }
    return res.status(503).json({ enabled: false, error: cfg.reason });
  }
  if (action === "confirm" && (method === "GET" || method === "POST")) return handleConfirm(req, res, cfg, method, now);
  if (action === "unsubscribe" && (method === "GET" || method === "POST")) return handleUnsubscribe(req, res, cfg, method);
  if (method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (action === "subscribe") return handleSubscribe(req, res, cfg, now);
  if (action === "update" || action === "status" || action === "remove") return handleManage(req, res, action, now);
  return res.status(400).json({ error: "Unknown action. Use subscribe, confirm, unsubscribe, update, status or remove." });
}
