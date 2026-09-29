import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, Clock, Crosshair, Loader2, MapPin, MapPinOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResponsiveSurface } from "@/components/ui/responsive-surface";
import { canGeolocate, geoErrorMessage, locLabel } from "@/lib/geo";

/* ─────────────────────────────────────────────────────────────────────────
 * THE LOCATION PICKER
 *
 * One surface, opened by LocationButton: a popover at md+, a bottom sheet
 * below (ResponsiveSurface). Top to bottom:
 *
 *   Your location                                  (sheet: ✕)
 *   Only your state leaves this browser.
 *   ZIP code or city
 *   [ e.g. 10001 or Chicago, IL             → ]
 *   ⚠ We couldn't find ZIP 00000. …               ← under the field, always
 *   ⌖ Use my current location                      ← the one-tap path, first
 *   📍 New York, NY 10001            Current ✓
 *   🕘 Chicago, IL 60601             State: IL     ← recents, max 3
 *   ──────────────────────────────
 *   Forget this location   Remembered in this browser only.
 *
 * The rules it exists to keep:
 *   - It never closes before the place resolves. A failed lookup leaves it
 *     open with the error under the field and the text selected, so fixing a
 *     typo is one keystroke. (The old phone sheet closed itself on submit and
 *     threw "HTTP 404 from api.zippopotam.us" into the header behind it.)
 *   - Errors are sentences with a next step (GEO_ERRORS in lib/geo.js).
 *   - The geolocation prompt only ever follows a tap on "Use my current
 *     location". Nothing asks on load.
 * ───────────────────────────────────────────────────────────────────────── */

function Row({ icon: Icon, label, sub, trailing, onClick, disabled, busy, className, ...rest }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy || undefined}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors",
          "hover:bg-panel-3 focus-visible:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60",
          "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
          className,
        )}
        {...rest}
      >
        {busy
          ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-fog" />
          : <Icon aria-hidden="true" className="size-4 shrink-0 text-fog" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] text-paper">{label}</span>
          {sub && <span className="block truncate text-[12px] text-subtle">{sub}</span>}
        </span>
        {trailing}
      </button>
    </li>
  );
}

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {string}   [props.anchorId="btn-location"]
 * @param {object}   [props.loc]           current location or null
 * @param {object[]} [props.recents]       [{label, lat, lon, state, stateAbbr, zip}], max 3, not the current one
 * @param {string}   [props.reason]        "to check your state" | "to find stores near you" | …
 * @param {Function} props.onSubmitText    (text) => Promise; rejects with a coded Error
 * @param {Function} props.onUseCurrent    () => Promise; rejects with a coded Error
 * @param {Function} props.onPickRecent    (loc) => Promise|void
 * @param {Function} props.onForget        () => void
 */
export default function LocationPicker({
  open, onClose, anchorId = "btn-location", loc, recents = [], reason,
  onSubmitText, onUseCurrent, onPickRecent, onForget,
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "text" | "geo" | "recent:<label>" | null
  const inputRef = useRef(null);
  const geoOk = canGeolocate();

  // A fresh surface every time it opens: no stale error, no stale text.
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setBusy(null);
  }, [open]);

  const fail = (err) => {
    setError(err);
    /* Every failure lands the reader back in the field — for a geolocation
     * failure that is the fallback, one keystroke away. */
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  };

  const run = async (kind, job) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await job();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    run("text", () => onSubmitText(text));
  };

  const errorText = error ? geoErrorMessage(error) : "";
  const current = loc ? locLabel(loc) : "";
  const lead = reason ? `Needed ${reason}. ` : "";

  return (
    <ResponsiveSurface
      open={open}
      onClose={onClose}
      anchorId={anchorId}
      id="location-picker"
      title="Your location"
      titleId="location-picker-title"
      initialFocusRef={inputRef}
      renderHeader={(sheet) => (
        <div className="relative shrink-0 px-4 pb-1 pt-4">
          {sheet && <span aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-line-strong" />}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p id="location-picker-title" className={cn("text-sm font-bold text-paper", sheet && "mt-1")}>Your location</p>
              <p className="mt-0.5 text-[12px] leading-snug text-subtle">
                {lead}Only your state leaves this browser.
              </p>
            </div>
            {sheet && (
              <button type="button" onClick={onClose} aria-label="Close"
                      className="-mr-1 grid size-9 shrink-0 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper">
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-2">
        <form noValidate role="search" aria-label="Set location" onSubmit={submit}>
          <label htmlFor="loc-input" className="mb-1.5 block text-[12px] font-semibold text-fog">ZIP code or city</label>
          <div className="relative">
            <input
              ref={inputRef}
              id="loc-input"
              value={text}
              onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
              disabled={!!busy}
              autoComplete="postal-code"
              inputMode="text"
              enterKeyHint="go"
              spellCheck={false}
              placeholder="e.g. 10001 or Chicago, IL"
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "loc-error" : undefined}
              className={cn(
                "h-11 w-full rounded-lg border border-line-strong bg-panel-2 pl-3.5 pr-12 text-[15px] text-paper",
                "shadow-[var(--rr-field)] transition-shadow placeholder:text-subtle disabled:opacity-70",
                "focus-visible:border-mint/60 focus-visible:outline-none focus-visible:shadow-[var(--rr-field),0_0_0_3px_var(--rr-accent-soft)]",
                error && "border-alert focus-visible:border-alert",
              )}
            />
            <button
              type="submit"
              disabled={!!busy}
              aria-label="Look up this place"
              className="absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md text-fog hover:bg-panel-3 hover:text-paper disabled:opacity-100"
            >
              {busy === "text"
                ? <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                : <ArrowRight aria-hidden="true" className="size-4" />}
            </button>
          </div>
          {error && (
            <p id="loc-error" role="alert" className="mt-1.5 flex gap-1.5 text-[12px] font-semibold leading-snug text-alert">
              <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>{errorText}</span>
            </p>
          )}
        </form>

        <ul className="-mx-1.5 flex flex-col" aria-label="Places">
          {geoOk && (
            <Row
              icon={Crosshair}
              label="Use my current location"
              sub={busy === "geo" ? "Locating…" : undefined}
              busy={busy === "geo"}
              disabled={!!busy}
              onClick={() => run("geo", onUseCurrent)}
            />
          )}
          {loc && (
            <Row
              icon={MapPin}
              label={current}
              sub="Current"
              disabled={!!busy}
              aria-current="true"
              onClick={onClose}
              trailing={<Check aria-hidden="true" className="size-4 shrink-0 text-paper" />}
            />
          )}
          {recents.map((r) => (
            <Row
              key={r.label}
              icon={Clock}
              label={locLabel(r)}
              sub={`State: ${r.stateAbbr}`}
              busy={busy === `recent:${r.label}`}
              disabled={!!busy}
              onClick={() => run(`recent:${r.label}`, () => onPickRecent(r))}
            />
          ))}
        </ul>

        {loc && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3">
            <button
              type="button"
              onClick={onForget}
              disabled={!!busy}
              className="tap inline-flex items-center gap-1.5 rounded-md text-[13px] font-semibold text-alert hover:underline disabled:opacity-50"
            >
              <MapPinOff aria-hidden="true" className="size-3.5" /> Forget this location
            </button>
            <span className="text-[12px] text-subtle">Remembered in this browser only.</span>
          </div>
        )}
      </div>
    </ResponsiveSurface>
  );
}
