import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Camera, CameraOff, Check, ExternalLink, Keyboard, Loader2, RotateCcw,
  ShieldQuestion, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { isPlausibleUpc, lookupProduct, matchUpc, upcKey } from "@/lib/upc";

/* ─────────────────────────────────────────────────────────────────────────
 * SCAN A BARCODE
 *
 * Point the camera at a package, and answer: is this thing recalled?
 *
 * The whole design is shaped by one fact about the data — no government feed
 * publishes a barcode field. UPCs appear inside free text, inconsistently,
 * and CPSC has none at all. So coverage is partial and unmeasurable from the
 * inside, which makes the empty result the dangerous one:
 *
 *   A scan that finds nothing has NOT established that a product is safe.
 *
 * Everything below follows from refusing to let "no match" look like a green
 * tick. The clear state is grey and interrogative, never green; it says how
 * many notices even carried a barcode to compare against; and it offers the
 * check that actually answers the question — a full openFDA lookup including
 * recalls that have since been terminated, which is the only way to tell
 * "that recall is over" from "we never had it".
 *
 * Decoding uses the platform's BarcodeDetector where it exists (Chromium, so
 * most Android) and lazy-loads ZXing everywhere else — notably iOS Safari,
 * which has never shipped BarcodeDetector. The import is deliberately inside
 * the function so the decoder is a separate chunk that a person who never
 * scans anything does not download.
 * ───────────────────────────────────────────────────────────────────────── */

const FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];

/** One decoder interface over two very different implementations. */
async function makeDecoder(video) {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const det = new window.BarcodeDetector({ formats });
        return {
          async read() {
            const hits = await det.detect(video);
            return hits && hits.length ? hits[0].rawValue : null;
          },
          stop() {},
        };
      }
    } catch (_) { /* fall through to ZXing */ }
  }

  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader();
  return {
    async read() {
      try {
        // decodeOnceFromVideoElement would restart the stream; this reads the
        // frame already on screen, which is what the preview is showing.
        const result = reader.decodeFromCanvas(frameToCanvas(video));
        return result ? result.getText() : null;
      } catch (_) {
        return null; // ZXing throws NotFoundException on every empty frame
      }
    },
    stop() { try { reader.reset?.(); } catch (_) { /* already torn down */ } },
  };
}

let scratch = null;
function frameToCanvas(video) {
  if (!scratch) scratch = document.createElement("canvas");
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  scratch.width = w;
  scratch.height = h;
  scratch.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, w, h);
  return scratch;
}

function Row({ r }) {
  return (
    <li className="rounded-xl border border-line bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={r.severity || "med"}>{r.classification || "Recall"}</Badge>
        <span className="tnum ml-auto text-[11px] text-fog">{r.source}</span>
      </div>
      <p className="mt-1.5 text-[13px] font-semibold [overflow-wrap:anywhere]">{r.product}</p>
      {r.reason && <p className="mt-1 text-[12px] leading-relaxed text-fog [overflow-wrap:anywhere]">{r.reason}</p>}
      {r.url && (
        <a href={r.url} target="_blank" rel="noopener noreferrer"
           className="mt-2 inline-flex min-h-8 items-center gap-1 text-[12px] font-semibold text-mint hover:underline">
          Official notice <ExternalLink className="size-3" />
        </a>
      )}
    </li>
  );
}

export default function ScanSheet({ open, onClose, recalls }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const decoderRef = useRef(null);
  const loopRef = useRef(0);
  const closedRef = useRef(false);

  const [camera, setCamera] = useState("starting"); // starting | live | denied | unsupported
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(loopRef.current);
    clearTimeout(loopRef.current);
    try { decoderRef.current?.stop(); } catch (_) { /* nothing to stop */ }
    decoderRef.current = null;
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** Everything a barcode leads to, gathered before anything is rendered. */
  const check = useCallback(async (raw) => {
    stopCamera();
    setBusy(true);
    const code = upcKey(raw);
    // Open Food Facts turns the number into words, which is the only way a
    // near-miss can be spotted at all. A miss there is not informative.
    const product = await lookupProduct(raw).catch(() => null);
    const local = matchUpc(recalls, raw, product);

    /* The lookup that includes finished recalls. This is what separates
     * "that recall ended in March" from "we have never heard of it", and it
     * is the only question the nearby feed cannot answer. */
    let history = null;
    try {
      const res = await fetch(`/api/lookup?upc=${encodeURIComponent(raw.replace(/\D/g, ""))}`,
        { headers: { Accept: "application/json" } });
      if (res.ok) history = await res.json();
    } catch (_) { /* static deploy, or offline — the local answer still stands */ }

    setResult({ raw, code, product, ...local, history });
    setBusy(false);
  }, [recalls, stopCamera]);

  // ── camera lifecycle ──
  useEffect(() => {
    if (!open || result) return;
    closedRef.current = false;
    let cancelled = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamera("unsupported"); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => {});
        decoderRef.current = await makeDecoder(v);
        if (cancelled) return;
        setCamera("live");

        const tick = async () => {
          if (cancelled || closedRef.current || !decoderRef.current) return;
          let value = null;
          try { value = await decoderRef.current.read(); } catch (_) { /* keep looking */ }
          if (value && isPlausibleUpc(value)) {
            try { navigator.vibrate?.(40); } catch (_) { /* not everywhere */ }
            check(value);
            return;
          }
          // ~8fps: fast enough to feel instant, slow enough not to cook a phone.
          loopRef.current = setTimeout(() => { loopRef.current = requestAnimationFrame(tick); }, 120);
        };
        tick();
      } catch (err) {
        if (cancelled) return;
        setCamera(err && /NotAllowed|Permission/i.test(err.name || err.message) ? "denied" : "unsupported");
      }
    })();

    return () => { cancelled = true; stopCamera(); };
  }, [open, result, check, stopCamera]);

  useEffect(() => {
    if (open) return;
    closedRef.current = true;
    stopCamera();
    setResult(null);
    setCamera("starting");
    setManual("");
    setManualOpen(false);
  }, [open, stopCamera]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const again = () => { setResult(null); setCamera("starting"); };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-ink" role="dialog" aria-modal="true" aria-label="Scan a barcode">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-3">
        <Camera className="size-4 text-mint" />
        <p className="text-sm font-bold">Scan a barcode</p>
        {result && (
          <Button variant="ghost" size="sm" className="ml-auto h-9" onClick={again}>
            <RotateCcw /> Scan another
          </Button>
        )}
        <button onClick={onClose} aria-label="Close scanner"
                className={"grid size-9 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper " + (result ? "" : "ml-auto")}>
          <X className="size-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* ---------------- viewfinder ---------------- */}
        {!result && (
          <div className="relative flex h-full flex-col">
            <div className="relative min-h-0 flex-1 bg-black">
              <video ref={videoRef} playsInline muted autoPlay
                     className="h-full w-full object-cover" aria-label="Camera preview" />
              {camera === "live" && (
                <>
                  {/* A wide, short window: retail barcodes are wider than tall,
                      and a square reticle invites people to frame it wrong. */}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-28 w-[78%] rounded-xl border-2 border-mint/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
                  </div>
                  <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-[13px] font-semibold text-white drop-shadow">
                    Line the barcode up inside the box
                  </p>
                </>
              )}
              {camera === "starting" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-fog">
                  <Loader2 className="size-5 animate-spin" />
                  <p className="text-sm">Starting the camera…</p>
                </div>
              )}
              {(camera === "denied" || camera === "unsupported") && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
                  <CameraOff className="size-6 text-fog" />
                  <p className="text-sm font-semibold text-paper">
                    {camera === "denied" ? "No camera access" : "This browser can't use the camera here"}
                  </p>
                  <p className="max-w-xs text-xs leading-relaxed text-fog">
                    {camera === "denied"
                      ? "Allow camera access in your browser's site settings, or type the number under the barcode instead."
                      : "Type the number printed under the barcode instead."}
                  </p>
                </div>
              )}
            </div>

            {/* ---------------- typed fallback ---------------- */}
            <div className="shrink-0 border-t border-line bg-panel px-4 py-3"
                 style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}>
              {manualOpen || camera === "denied" || camera === "unsupported" ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); if (manual.replace(/\D/g, "").length >= 8) check(manual); }}
                  className="flex items-center gap-2"
                >
                  <Input
                    autoFocus={manualOpen}
                    inputMode="numeric"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    placeholder="Number under the barcode"
                    aria-label="Barcode number"
                    className="h-11 flex-1"
                  />
                  <Button type="submit" className="h-11 shrink-0" disabled={manual.replace(/\D/g, "").length < 8 || busy}>
                    {busy ? <Loader2 className="animate-spin" /> : "Check"}
                  </Button>
                </form>
              ) : (
                <Button variant="secondary" className="h-11 w-full" onClick={() => setManualOpen(true)}>
                  <Keyboard /> Type the number instead
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ---------------- result ---------------- */}
        {result && <ScanResult result={result} />}
        {busy && !result && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/80">
            <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm font-semibold">
              <Loader2 className="size-4 animate-spin text-mint" /> Checking the notices…
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ScanResult({ result }) {
  const { raw, product, exact, named, checked, history } = result;
  const hasExact = exact.length > 0;
  const hasNear = !hasExact && named.length > 0;
  const past = history ? (history.matches || []).filter((m) => !/ongoing|pending/i.test(m.status)) : [];

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {/* what was scanned */}
      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel-2 p-3">
        {product?.image
          ? <img src={product.image} alt="" className="size-14 shrink-0 rounded-lg border border-line object-cover" />
          : <span className="grid size-14 shrink-0 place-items-center rounded-lg border border-line bg-panel text-fog"><Camera className="size-5" /></span>}
        <div className="min-w-0 flex-1">
          {product?.brand && <p className="microlabel leading-none">{product.brand}</p>}
          <p className="truncate text-sm font-bold">{product?.name || "Unknown product"}</p>
          <p className="tnum text-[11px] text-fog">{raw.replace(/\D/g, "")}</p>
        </div>
      </div>

      {/* the verdict */}
      {hasExact && (
        <div className="rounded-xl border border-alert-line bg-alert-soft p-3.5">
          <p className="flex items-center gap-2 text-sm font-bold text-alert">
            <AlertTriangle className="size-4 shrink-0" />
            This barcode is on an active recall notice
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper">
            Check the lot or date code on your package against the notice — a recall usually
            covers particular lots, not every unit ever made.
          </p>
        </div>
      )}
      {hasNear && (
        <div className="rounded-xl border border-amber/45 bg-amber-soft p-3.5">
          <p className="flex items-center gap-2 text-sm font-bold text-amber">
            <AlertTriangle className="size-4 shrink-0" />
            No exact barcode match — but something very similar is recalled
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-paper">
            These notices name a product with the same brand or name. Read them and compare
            against your package.
          </p>
        </div>
      )}
      {!hasExact && !hasNear && (
        /* Deliberately grey and interrogative. Not green, not a tick, and it
         * never says "safe" — a scan that finds nothing has established
         * nothing, and dressing that up as an all-clear is the one way this
         * feature could do real harm. */
        <div className="rounded-xl border border-line-strong bg-panel-2 p-3.5">
          <p className="flex items-center gap-2 text-sm font-bold text-paper">
            <ShieldQuestion className="size-4 shrink-0 text-fog" />
            No match — which is not the same as clear
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-fog">
            No recall notice we hold prints this barcode. Most notices never list one at all —
            {checked === 0
              ? " in fact none of the notices loaded for your area carries a barcode, so there was nothing here to compare against."
              : ` of the ${checked} notice${checked === 1 ? " that does" : "s that do"} carry one in your area, none was this.`}
            {" "}Treat this as &ldquo;not found&rdquo;, not as a clean bill of health.
          </p>
        </div>
      )}

      {exact.length > 0 && (
        <section>
          <p className="microlabel">Matching notices</p>
          <ul className="mt-2 flex flex-col gap-2">{exact.map((r) => <Row key={r.id} r={r} />)}</ul>
        </section>
      )}
      {named.length > 0 && (
        <section>
          <p className="microlabel">Similar products</p>
          <ul className="mt-2 flex flex-col gap-2">{named.map((r) => <Row key={r.id} r={r} />)}</ul>
        </section>
      )}

      {/* recalls that are over — the reason a news story can't be found */}
      {past.length > 0 && (
        <section>
          <p className="microlabel">Past recalls for this product</p>
          <p className="mt-1 text-[12px] leading-relaxed text-fog">
            These are finished. The FDA marks a recall <span className="text-paper">Terminated</span> once
            the recalling firm has accounted for the product — which is why a recall you remember
            from the news may not appear anywhere else in this app.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {past.slice(0, 6).map((m) => (
              <li key={m.id} className="rounded-xl border border-line bg-panel p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="low"><Check className="mr-1 inline size-3" />{m.status}</Badge>
                  <span className="tnum ml-auto text-[11px] text-fog">{m.source}</span>
                </div>
                <p className="mt-1.5 text-[13px] font-semibold [overflow-wrap:anywhere]">{m.product.slice(0, 160)}</p>
                {m.reason && <p className="mt-1 text-[12px] text-fog [overflow-wrap:anywhere]">{m.reason.slice(0, 160)}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {history === null && (
        <p className="text-[12px] leading-relaxed text-subtle">
          Couldn't reach the full FDA archive just now, so this checked only the notices already
          loaded for your area.
        </p>
      )}

      <p className="text-[12px] leading-relaxed text-subtle">
        Barcodes are read out of each notice's free text — no government feed publishes a barcode
        field, and CPSC consumer-product recalls have none at all. Always confirm against the
        official notice.
      </p>
    </div>
  );
}
