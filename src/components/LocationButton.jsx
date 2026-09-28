import { forwardRef } from "react";
import { ChevronDown, Loader2, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { locLabel } from "@/lib/geo";

/* ─────────────────────────────────────────────────────────────────────────
 * THE ONE PLACE TO SAY WHERE YOU ARE
 *
 * There used to be five: a header ZIP field, a search icon beside it, a
 * "My Location" button, a ZIP card inside search, and "Add your location" in
 * the digest — three separate inputs visible at once on a desktop, each with
 * its own error strip somewhere else on the page. Now there is this button,
 * the same element at every width, and it opens one surface (LocationPicker).
 *
 * Neutral, not mint. Green in this app means "selected / go", and a permanent
 * green bar across the header read as "all clear" — the loudest thing on the
 * screen saying the one thing the app must never say.
 * ───────────────────────────────────────────────────────────────────────── */
const LocationButton = forwardRef(function LocationButton(
  { loc, busy = false, open = false, onOpen, id = "btn-location", className }, ref,
) {
  const full = locLabel(loc);
  const short = locLabel(loc, { short: true });
  const aria = loc ? `Location: ${full}. Change location` : "Set location";
  const Pin = busy ? Loader2 : MapPin;
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="location-picker"
      aria-label={aria}
      aria-busy={busy || undefined}
      className={cn(
        "tap inline-flex h-9 min-w-0 max-w-[10.5rem] shrink items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2.5 sm:px-3",
        "text-[13px] font-semibold text-paper shadow-[var(--rr-bevel),var(--rr-shadow-1)] transition-colors",
        "hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60",
        "pointer-coarse:h-10 sm:max-w-[16rem] lg:max-w-[20rem]",
        open && "border-line-strong bg-panel-3",
        className,
      )}
    >
      <Pin aria-hidden="true" className={cn("size-3.5 shrink-0 text-fog", busy && "animate-spin")} />
      {loc ? (
        <>
          {/* The label is the reader's place; session replay masks all text
              (see analytics.js), and nothing here is ever sent as an event. */}
          <span className="truncate sm:hidden">{short}</span>
          <span id="location-label" className="hidden truncate sm:inline">{full}</span>
        </>
      ) : (
        <span className="truncate">Set location</span>
      )}
      {/* The chevron is a desktop affordance; at 390px its 20px is what keeps
          the header on one row. */}
      <ChevronDown aria-hidden="true" className={cn("hidden size-3.5 shrink-0 text-fog transition-transform sm:block", open && "rotate-180")} />
    </button>
  );
});

export default LocationButton;
