/* The picture a shared recall unfurls into.
 *
 *   GET /api/share?format=png&id=fsis-024-2026&st=CA   -> 1200×630 PNG
 *   GET /api/share?format=png                       -> the generic Yanked card
 *
 * Referenced only from /api/share's og:image; nobody visits it directly.
 *
 * RUNTIME. This is an ordinary Node (serverless) function, not an Edge one.
 * @vercel/og 1.x ships two builds behind conditional exports — `edge` and
 * `node` — and on Node `ImageResponse` is a real WHATWG Response whose body
 * is rendered by satori + resvg (WASM, bundled in the package, as is the
 * Geist Regular font it defaults to). The Node build is what lets this
 * function share src/lib/index-server.js, which reads the national index off
 * disk; an Edge function has no `node:fs` and would have to fetch the index
 * over HTTP from its own CDN on every cold start. We await the Response's
 * arrayBuffer and end the Node `res` with it rather than use
 * `unstable_createNodejsStream`, which is marked unstable and saves nothing
 * on a ~60kB image.
 *
 * No JSX in api/ — there is no transform on this path — so the card is built
 * with React.createElement. Satori reads only inline `style`, flexbox only,
 * and every element with more than one child needs `display: flex`.
 *
 * FONTS AND GLYPHS. Only the bundled Geist Regular is available: there is no
 * bold, so hierarchy is size and colour alone. Satori fetches a fallback font
 * (or a Twemoji SVG) from the network for any glyph the font lacks, which is
 * a failed request here at best and a hung render at worst, so feed text is
 * narrowed to Latin-1 plus common typographic punctuation before it reaches
 * the renderer (`glyphSafe`).
 *
 * COLOUR. The README's rules, applied to a card: warm (the alert red) only
 * when the verdict is "in your area" AND the recall is high severity. A
 * "Not reported" or "Region not stated" card is neutral grey — never green,
 * because a state absent from a distribution list is not an all-clear, and
 * never the word "safe". An ended recall is grey too. The green accent
 * appears only in the wordmark, which is the brand, not a verdict.
 */
import React from "react";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRecall } from "./resolve-recall.js";
import { cardVerdict } from "../../src/lib/share.js";
import { coverageOf } from "../../src/lib/verdict.js";

const h = React.createElement;
const W = 1200;
const H = 630;

// Light-mode tokens from src/index.css, copied because a PNG has no :root.
const C = {
  bg: "#f1f1f1",
  card: "#ffffff",
  text: "#1a1a1a",
  muted: "#616161",
  subtle: "#6d6d6d",
  line: "#e3e3e3",
  sunken: "#ebebeb",
  accent: "#1f7a4c",
  neutralRail: "#8a8a8a",
  alert: "#8e1f0b",
  alertSoft: "#fdebe9",
  alertLine: "#f0b4ad",
};

/* Keep what Geist Regular certainly renders; map the rest to something
 * close or drop it. Satori would otherwise go to the network per glyph. */
function glyphSafe(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents left by NFKD
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-‒−]/g, "-")
    .replace(/[^\x20-\x7e -ÿ–—…·]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s, n) {
  const t = glyphSafe(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

function fmtDay(d) {
  if (!d) return "";
  const t = new Date(d);
  if (isNaN(t)) return "";
  return t.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/* Product titles run long ("X Recalls Y Due to Z; Violate Mandatory
 * Standard…", up to ~250 characters). The size steps down with length so a
 * short name reads big and a long one still fits three lines. */
function productSize(len) {
  if (len <= 50) return 52;
  if (len <= 90) return 44;
  return 38;
}

function wordmark() {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 14 } },
    h("div", {
      style: { width: 22, height: 22, borderRadius: 11, background: C.accent, border: `5px solid #ddf0e5` },
    }),
    h("div", { style: { fontSize: 32, color: C.text, letterSpacing: -0.5 } }, "Yanked"),
    h("div", { style: { fontSize: 26, color: C.subtle, marginLeft: 4 } }, "yanked.app"),
  );
}

function frame(rail, children) {
  return h(
    "div",
    {
      style: {
        width: W, height: H, display: "flex", background: C.bg, padding: 40,
        fontFamily: "Geist", color: C.text,
      },
    },
    h(
      "div",
      {
        style: {
          display: "flex", flex: 1, background: C.card, borderRadius: 28,
          border: `1px solid ${C.line}`, overflow: "hidden",
        },
      },
      h("div", { style: { width: 14, background: rail, display: "flex" } }),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", flex: 1, padding: "44px 56px 40px 50px" } },
        ...children,
      ),
    ),
  );
}

function genericCard() {
  return frame(C.neutralRail, [
    wordmark(),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
      h("div", { style: { fontSize: 72, lineHeight: 1.08, letterSpacing: -1.5 } }, "Recalls near you, from the official notices."),
      h(
        "div",
        { style: { fontSize: 30, color: C.muted, marginTop: 24, lineHeight: 1.35 } },
        "FDA, USDA FSIS and CPSC recalls — which ones reached your state, and which stores near you are named.",
      ),
    ),
  ]);
}

function recallCard(r, st) {
  const v = cardVerdict(r, st);
  const alert = v.tone === "alert";
  const product = clip(r.product || "Recalled product", 150);
  /* "Not reported in California" alone reads as an all-clear at thumbnail
   * size. The line under it says what the claim rests on — the states the
   * notice does list — and that such lists are known to be incomplete, the
   * same caveat verdictFor puts in `detail`. The hazard then moves down into
   * the footer rather than being dropped. */
  const notListed = v.verdict === "not_listed";
  const listed = coverageOf(r).states;
  const sub = notListed
    ? clip(`Sent to ${listed.length > 8 ? `${listed.length} other states` : listed.join(", ")} — distribution lists can be incomplete.`, 120)
    : clip(r.reason || "", 120);
  const meta = [glyphSafe(r.source), fmtDay(r.date), notListed ? clip(r.reason || r.classification, 60) : r.classification ? clip(r.classification, 40) : ""]
    .filter(Boolean)
    .join("  ·  ");

  return frame(alert ? C.alert : C.neutralRail, [
    h(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      wordmark(),
      h(
        "div",
        {
          style: {
            display: "flex", fontSize: 22, padding: "8px 18px", borderRadius: 999,
            color: alert ? C.alert : C.muted,
            background: alert ? C.alertSoft : C.sunken,
            border: `1px solid ${alert ? C.alertLine : C.line}`,
          },
        },
        r.status === "ended" ? "Recall ended" : "Recall notice",
      ),
    ),
    h(
      "div",
      {
        style: {
          display: "flex", marginTop: 34, fontSize: productSize(product.length), lineHeight: 1.18,
          color: C.text, letterSpacing: -0.5, maxHeight: 3 * 1.18 * productSize(product.length),
          overflow: "hidden",
        },
      },
      product,
    ),
    h("div", { style: { display: "flex", flex: 1 } }),
    h(
      "div",
      {
        style: {
          display: "flex", fontSize: 64, lineHeight: 1.05, letterSpacing: -1.5,
          color: alert ? C.alert : C.text,
        },
      },
      clip(v.line, 48),
    ),
    sub
      ? h("div", { style: { display: "flex", fontSize: 28, color: C.muted, marginTop: 16, lineHeight: 1.3 } }, sub)
      : null,
    h(
      "div",
      {
        style: {
          display: "flex", marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.line}`,
          fontSize: 24, color: C.subtle,
        },
      },
      meta || "Official recall notice",
    ),
  ].filter(Boolean));
}

/* THE HARFBUZZ SHIM. @vercel/og 1.0.3's Node build (dist/index.node.js) is
 * an ES module that inlines satori 0.33's HarfBuzz, and HarfBuzz's
 * Emscripten loader was bundled as CommonJS: at import time it calls
 * `require("fs")` and reads `hb.wasm` from `__dirname`. Neither exists in an
 * ES module, so a plain `import { ImageResponse } from "@vercel/og"` throws
 * "Dynamic require of fs is not supported" before the handler ever runs —
 * in this project, which is `"type": "module"`, and on Vercel too, which
 * does not transpile ESM functions to CJS. The package also does not ship
 * `hb.wasm` in its dist; the copy satori's own `harfbuzzjs` dependency
 * installs is the one it can use.
 *
 * So: point `__dirname` at that copy, lend a real `require` for the one
 * synchronous `fs` lookup, import, and take both globals away again (the
 * loader captures what it needs while the module evaluates). The import is
 * dynamic because static imports are hoisted above any code that could set
 * the globals first.
 *
 * The `new URL(…, import.meta.url)` spelling is deliberate: it is a static
 * reference Vercel's file tracer follows, which is what ships `hb.wasm` in
 * this function's bundle. If it ever stops being traced the render throws,
 * the handler falls back to… the same renderer, and answers 500 — link
 * unfurlers then show a text-only preview from /api/share's meta tags, which
 * is degraded but not wrong. Drop this shim once @vercel/og's Node build
 * imports cleanly (`node -e 'import("@vercel/og")'` is the test). */
const HB_WASM = fileURLToPath(new URL("../../node_modules/harfbuzzjs/hb.wasm", import.meta.url));
let ogModule = null;

function hbDir() {
  if (existsSync(HB_WASM)) return dirname(HB_WASM);
  try {
    // Hoisted differently (a monorepo, pnpm): ask resolution instead.
    return dirname(createRequire(import.meta.url).resolve("harfbuzzjs/hb.wasm"));
  } catch (_) {
    return dirname(HB_WASM);
  }
}

async function loadOg() {
  if (ogModule) return ogModule;
  const g = globalThis;
  const had = { require: g.require, __dirname: g.__dirname };
  g.require = createRequire(import.meta.url);
  g.__dirname = hbDir();
  try {
    ogModule = await import("@vercel/og");
  } finally {
    if (had.require === undefined) delete g.require; else g.require = had.require;
    if (had.__dirname === undefined) delete g.__dirname; else g.__dirname = had.__dirname;
  }
  return ogModule;
}

async function render(el) {
  const { ImageResponse } = await loadOg();
  const resp = new ImageResponse(el, { width: W, height: H });
  return Buffer.from(await resp.arrayBuffer());
}

export default async function handler(req, res) {
  const q = req.query || {};
  const id = String(q.id || "").slice(0, 120);
  const st = String(q.st || "");

  let record = null;
  if (id) {
    ({ record } = await resolveRecall(id));
  }

  let png;
  try {
    png = await render(record ? recallCard(record, st) : genericCard());
  } catch (err) {
    /* A recall whose text trips the renderer still gets a card — the generic
     * one — rather than a broken image in someone's group chat. */
    console.error("og: render failed", id, err && err.message);
    try {
      png = await render(genericCard());
    } catch (err2) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("og render failed");
    }
    record = null;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(png.length));
  /* A recall's verdict for a given state only changes when the index does
   * (one deploy a day at most), and unfurlers re-fetch aggressively. An
   * unknown id is cached briefly: it may be a recall the next index adds. */
  res.setHeader(
    "Cache-Control",
    record ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" : "public, max-age=300, s-maxage=600",
  );
  return res.end(png);
}
