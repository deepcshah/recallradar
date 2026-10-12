/* Sending one email through Resend's HTTP API — fetch, no SDK.
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer RESEND_API_KEY
 *   { from, to: [address], subject, html, text, headers }
 *
 * (https://resend.com/docs/api-reference/emails/send-email). The response is
 * { id } on success and { statusCode, name, message } on failure; both are
 * reduced here to { ok, id } | { ok:false, status, error } so callers never
 * see an exception for an HTTP error.
 *
 * Resend's default rate limit is 2 requests per second per team, so the cron
 * sends one at a time with a gap (SEND_GAP_MS) rather than in parallel.
 *
 * `idempotencyKey`, when given, is sent as the Idempotency-Key header so a
 * cron re-run after a crash between "sent" and "recorded as sent" does not
 * deliver the same digest twice.
 *
 * `setFetchForTests(fn)` replaces fetch, so the checks can run with no
 * network and assert exactly what would have been sent.
 */
export const RESEND_URL = "https://api.resend.com/emails";
export const SEND_GAP_MS = 600;

let fetchImpl = (...a) => fetch(...a);

export function setFetchForTests(fn) {
  fetchImpl = fn || ((...a) => fetch(...a));
}

export async function sendEmail({ apiKey, from, to, subject, html, text, headers, idempotencyKey }) {
  const body = { from, to: [to], subject, html, text };
  if (headers && Object.keys(headers).length) body.headers = headers;
  const reqHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (idempotencyKey) reqHeaders["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);
  let res;
  try {
    res = await fetchImpl(RESEND_URL, { method: "POST", headers: reqHeaders, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, status: 0, error: `network: ${String((err && err.message) || err).slice(0, 120)}` };
  }
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  if (res.ok && json && json.id) return { ok: true, id: json.id };
  return {
    ok: false,
    status: res.status,
    error: String((json && (json.message || json.name)) || `HTTP ${res.status}`).slice(0, 200),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
