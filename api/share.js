/* The page a shared recall link lands on — for about a hundred milliseconds.
 *
 *   GET /r/fsis-024-2026?st=CA
 *     -> (vercel.json rewrite) /api/share?id=fsis-024-2026&st=CA
 *     -> tiny HTML: og:* / twitter:* meta, then on to /?r=fsis-024-2026&st=CA
 *
 * Two readers, one response. A link unfurler (iMessage, Slack, WhatsApp,
 * Facebook) does not run JavaScript; it reads the meta tags and fetches
 * og:image, which is /api/share?format=png drawing the verdict card. A person runs the
 * inline script and is replaced straight into the SPA, which opens that
 * recall's verdict. The meta refresh is for the rare browser with scripts
 * off; the visible link is for the rarer one that ignores both.
 *
 * Why not render the SPA here and inject tags into index.html? Because this
 * function would then need the built index.html in its bundle and would be on
 * the critical path of every shared-link visit. A redirect costs one hop and
 * leaves the app served from the CDN exactly as it is everywhere else.
 *
 * An unknown id — a recall the next index dropped, a mangled paste — still
 * answers 200 with the generic Yanked card and redirects to the home page.
 * A 404 would make unfurlers show nothing, and the person who tapped it would
 * land on an error rather than on the thing they came for, one tap away.
 *
 * Every piece of feed text reaching the HTML goes through `esc`: recall
 * titles come from three agencies' free text, and an attribute is exactly
 * where an unescaped quote stops being cosmetic.
 */
import { readIndex, findRecall } from "../src/lib/index-server.js";
import { cardVerdict, cleanState } from "../src/lib/share.js";
import { VERDICTS } from "../src/lib/verdict.js";
import ogHandler from "./_lib/og.js";

const SITE = "https://yanked.app";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

/* Absolute URLs are required in og:image — unfurlers do not resolve relative
 * ones. The Host header names the deployment that was actually asked (a
 * preview URL unfurls with its own preview card), but it is client-supplied,
 * so it is accepted only if it looks like a hostname; anything else falls
 * back to the production origin rather than being echoed into the page. */
function originOf(req) {
  const h = req.headers || {};
  const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return SITE;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = String(h["x-forwarded-proto"] || (local ? "http" : "https")).split(",")[0].trim();
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

function page({ title, description, image, url, target }) {
  const t = esc(title);
  const d = esc(description);
  const i = esc(image);
  const u = esc(url);
  const go = esc(target);
  /* JSON.stringify, then `<` escaped, is the safe way to put a string inside
   * a <script>: it cannot close the tag or break out of the literal. */
  const js = JSON.stringify(target).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Yanked">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta property="og:image" content="${i}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${go}">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f1f1f1;color:#1a1a1a;margin:0;padding:48px 16px}a{color:#1f7a4c}@media (prefers-color-scheme:dark){body{background:#1a1a1a;color:#e3e3e3}a{color:#4fca85}}</style>
<script>location.replace(${js});</script>
</head>
<body>
<p><a href="${go}">Open this recall on Yanked</a></p>
</body>
</html>`;
}

/* One function, two answers. Vercel's Hobby plan deploys at most twelve
 * functions, and every file directly under api/ is one — so the preview
 * image is not its own endpoint but `?format=png` on this one. The card's
 * code lives in api/_lib/og.js; the underscore keeps Vercel from deploying
 * it separately. */
export default async function handler(req, res) {
  const q = req.query || {};
  if (q.format === "png") return ogHandler(req, res);
  const id = String(q.id || "").slice(0, 120);
  const st = cleanState(q.st);
  const origin = originOf(req);

  let record = null;
  if (id) {
    const index = await readIndex();
    record = findRecall(index, id);
  }

  let body;
  if (record) {
    const v = cardVerdict(record, st);
    const product = clip(record.product || "Recalled product", 110);
    /* The description leads with the verdict in full-sentence form. With no
     * state shared, verdictFor's headline would ask the *viewer* to add a
     * location, which in a chat preview reads like an instruction from the
     * sender; the card's coverage line ("Sent to AZ, NM, TX") says what is
     * actually known. Not-listed keeps verdictFor's detail, caveat and all —
     * that is the one verdict an unfurl must not shorten into an all-clear. */
    const lead = v.verdict === VERDICTS.NEEDS_LOCATION ? `${v.line}.` : `${v.headline}.`;
    const tail = v.verdict === VERDICTS.NOT_LISTED
      ? v.detail
      : [record.reason, [record.source, record.date].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    const qs = new URLSearchParams({ id: record.id });
    if (st) qs.set("st", st);
    const target = `/?${new URLSearchParams({ r: record.id, ...(st ? { st } : {}) })}`;
    body = page({
      title: `Recall: ${product}`,
      description: clip(`${lead} ${tail}`, 300),
      image: `${origin}/api/share?format=png&${qs}`,
      url: `${origin}/r/${encodeURIComponent(record.id)}${st ? `?st=${st}` : ""}`,
      target,
    });
  } else {
    body = page({
      title: "Yanked — recalls near you",
      description:
        "Which FDA, USDA and CPSC recalls reached your state, and which stores near you are named in the notices.",
      image: `${origin}/api/share?format=png`,
      url: `${origin}/`,
      target: "/",
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    record ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" : "public, max-age=60, s-maxage=300",
  );
  return res.end(body);
}
