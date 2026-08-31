/* Look one product up across openFDA — including recalls that are over.
 *
 * Every other path in this app asks openFDA for `status:"Ongoing"`, which is
 * right for "what should I worry about near me" and wrong for the question
 * people actually arrive with after seeing a headline: *is that thing still
 * recalled?* Under the ongoing-only query, a notice that has since been
 * terminated and a notice we never had look identical — both absent.
 *
 * `status` is openFDA's own lifecycle field (Ongoing / Completed / Terminated
 * / Pending), so "resolved" is public data we were filtering away rather than
 * a gap in the feeds. This endpoint drops the filter and reports the status
 * instead, which turns silence into an answer.
 *
 *   GET /api/lookup?upc=012345678905
 *   GET /api/lookup?q=romaine%20lettuce
 */
const KINDS = ["food", "drug", "device"];
const LOOKBACK_DAYS = 1095; // three years: long enough to cover "I saw it on the news"
const LIMIT = 25;

function fmt(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/* openFDA's Lucene syntax treats most punctuation as a term separator, so a
 * quoted phrase is the only reliable way to search free text. Anything that
 * could break out of the quotes is stripped rather than escaped. */
function phrase(s) {
  return String(s).replace(/["\\()\[\]{}:~^]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function jfetch(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (res.status === 404) return { results: [] }; // openFDA's "no matches"
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const upc = String(req.query.upc || "").replace(/\D/g, "").slice(0, 14);
  const q = phrase(req.query.q || "");
  if (!upc && !q) return res.status(400).json({ error: "pass ?upc= or ?q=" });

  const key = process.env.openfda;
  const since = fmt(new Date(Date.now() - LOOKBACK_DAYS * 86400000));
  const until = fmt(new Date());

  /* A barcode is printed several ways — UPC-A, EAN-13, GTIN-14 — and which
   * one a notice used is arbitrary. Search the forms that carry real
   * information rather than the zero-padded canonical one. */
  const forms = upc
    ? [...new Set([upc, upc.replace(/^0+/, ""), upc.padStart(13, "0"), upc.padStart(12, "0")])].filter((f) => f.length >= 11)
    : [];

  const clause = upc
    ? `(${forms.map((f) => `code_info:"${f}"+OR+product_description:"${f}"`).join("+OR+")})`
    : `(product_description:"${q}"+OR+recalling_firm:"${q}")`;
  const search = `${clause}+AND+report_date:[${since}+TO+${until}]`;

  const jobs = KINDS.map(async (kind) => {
    const url =
      `https://api.fda.gov/${kind}/enforcement.json?search=${search.replace(/ /g, "+")}` +
      `&sort=report_date:desc&limit=${LIMIT}` + (key ? `&api_key=${key}` : "");
    const data = await jfetch(url);
    return ((data && data.results) || []).map((r) => ({
      id: `fda-${kind}-${r.recall_number || r.event_id}`,
      source: { food: "FDA Food", drug: "FDA Drug", device: "FDA Device" }[kind],
      product: r.product_description || "",
      firm: r.recalling_firm || "",
      reason: r.reason_for_recall || "",
      classification: r.classification || "",
      // The whole point of this endpoint.
      status: r.status || "Unknown",
      terminationDate: r.termination_date || "",
      reportDate: r.report_date || "",
      distribution: r.distribution_pattern || "",
      codeInfo: r.code_info || "",
    }));
  });

  const settled = await Promise.allSettled(jobs);
  const matches = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") matches.push(...s.value);
    else failed.push(KINDS[i]);
  });

  // Every source failing is an outage, not an answer — say so rather than
  // returning an empty list that reads as "nothing found".
  if (failed.length === KINDS.length) {
    return res.status(502).json({ error: "openFDA is unreachable right now — try again shortly." });
  }

  matches.sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
  const active = matches.filter((m) => /ongoing|pending/i.test(m.status));

  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json({
    query: upc ? { upc } : { q },
    matches: matches.slice(0, 40),
    activeCount: active.length,
    resolvedCount: matches.length - active.length,
    partial: failed.length ? failed : undefined,
  });
}

export const config = { maxDuration: 30 };
