import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * FILTERS
 *
 * Every filter in the app lives behind this one control, at every size.
 *
 * They used to be scattered: the product-type menu sat in the global header
 * beside the app's name, the source toggles sat in the recalls toolbar, and
 * the sort chips sat in the recalls header — three places, none of which
 * showed you what was already on. On a phone the header row was the worst of
 * it, a 16rem popover opening out of a control squeezed between a search box
 * and a location chip.
 *
 * So: one trigger that carries a count, one surface that holds every group,
 * and — outside this file — a row of removable chips so an active filter is
 * always visible without opening anything.
 *
 * The surface changes shape with the viewport: a bottom sheet on a phone,
 * where a thumb reaches the bottom of the screen and a 44px row is the
 * smallest thing worth aiming at; an anchored popover at md+, where the
 * trigger is a mouse target and a sheet would be silly.
 *
 * The phone sheet goes through a portal rather than staying where it is
 * written. The panel it lives in is `relative z-10`, which is a stacking
 * context — so a `fixed` sheet inside it, however high its own z-index,
 * still lands under anything above z-10 in the page. It landed under the
 * footer, and the footer swallowed the sheet's own "Show results" button.
 * ───────────────────────────────────────────────────────────────────────── */

/** The trigger. Shows how many filters are on, because "Filters" alone can't. */
export function FilterButton({ open, count, onClick, id }) {
  return (
    <button
      id={id}
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onClick}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold",
        "shadow-[var(--rr-bevel),var(--rr-shadow-1)] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60",
        count > 0
          ? "border-mint-line bg-mint-soft text-mint"
          : "border-line-strong bg-panel-2 text-paper"
      )}
    >
      <SlidersHorizontal className="size-3.5 shrink-0" />
      Filters
      {count > 0 && (
        <span className="tnum grid min-w-[1.15rem] place-items-center rounded-full bg-mint px-1 text-[10px] font-bold text-mint-ink">
          {count}
        </span>
      )}
    </button>
  );
}

/** One group of mutually-compatible toggles, drawn as chips rather than rows.
 *  Chips show their counts, so "Listeria · 3" tells you what turning it on
 *  will leave you with before you turn it on. An empty selection means
 *  everything, which is why "All" is a chip too rather than a cleared state. */
export function FilterGroup({ label, options, selected, onChange, allLabel = "All" }) {
  if (!options.length) return null;
  const chosen = new Set(selected);
  const toggle = (value) => {
    const next = new Set(selected);
    next.has(value) ? next.delete(value) : next.add(value);
    onChange([...next]);
  };
  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <p className="microlabel">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={chosen.size === 0}
          onClick={() => onChange([])}
          className={cn("chip", chosen.size === 0 ? "chip-on" : "chip-off")}
        >
          {allLabel}
        </button>
        {options.map((o) => {
          const on = chosen.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              disabled={!on && o.count === 0}
              title={!on && o.count === 0 ? "Nothing matches this alongside the filters already on" : undefined}
              onClick={() => toggle(o.value)}
              className={cn("chip", on ? "chip-on" : "chip-off")}
            >
              {on && <Check className="size-3 shrink-0" strokeWidth={3} />}
              <span className="normal-case tracking-normal">{o.label}</span>
              {o.count != null && <span className="tnum opacity-60">{o.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A group where exactly one option is on — sort order, for instance. */
export function FilterChoice({ label, options, value, onChange }) {
  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <p className="microlabel">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn("chip", value === o.value ? "chip-on" : "chip-off")}
          >
            <span className="normal-case tracking-normal">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function FilterSheet({ open, onClose, anchored, triggerId = "btn-filters", count, onClear, resultLabel, children }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);

  /* The desktop popover is measured against the viewport rather than hung off
   * the trigger with `absolute`. The trigger lives partway down a resizable
   * panel, so "below the button" is sometimes 600px of room and sometimes
   * 120 — hung absolutely, the panel ran off the bottom of the window and the
   * sort controls were unreachable. Fixed positioning also sidesteps the
   * panel's own stacking context, the same thing that put the phone sheet
   * under the footer. */
  useLayoutEffect(() => {
    if (!open || !anchored) return;
    const trigger = document.getElementById(triggerId);
    if (!trigger) return;
    const GAP = 6;
    const EDGE = 8;
    const place = () => {
      const r = trigger.getBoundingClientRect();
      const right = Math.max(EDGE, window.innerWidth - r.right);
      const below = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      // Flip up only when down is genuinely cramped and up is roomier.
      setPos(below < 260 && above > below
        ? { right, bottom: window.innerHeight - r.top + GAP, maxHeight: above }
        : { right, top: r.bottom + GAP, maxHeight: below });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchored, triggerId]);

  /* Focus goes into the surface when it opens and back to the trigger when it
   * closes, and Tab cycles inside it while it is open. The phone sheet claims
   * `aria-modal`, and a screen reader takes that claim literally: without this
   * the first Tab walked out of the sheet and into the page behind it, which
   * is exactly what aria-modal promises will not happen. */
  useEffect(() => {
    if (!open) return;
    const box = boxRef.current;
    const returnTo = document.activeElement;
    const first = box && box.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    (first || box)?.focus?.();
    return () => {
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [open, pos]);

  /* Escape closes from anywhere; a click outside closes the desktop popover.
   * The phone sheet dismisses on its own backdrop instead — but the same
   * handler is harmless there, since the backdrop is outside the box too. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const box = boxRef.current;
      if (!box) return;
      const items = [...box.querySelectorAll("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
      if (!items.length) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    const onDown = (e) => {
      const box = boxRef.current;
      if (box && !box.contains(e.target) && !e.target.closest?.(`#${triggerId}`)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose, triggerId]);

  if (!open) return null;

  const head = (
    <div className="relative flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
      {/* The grabber is decoration on desktop and a signal on a phone: this
          panel came up from the bottom and goes back down. */}
      {!anchored && (
        <span aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-line-strong" />
      )}
      <p className={cn("text-sm font-bold", !anchored && "mt-1.5")}>Filters &amp; sort</p>
      {count > 0 && (
        <button
          type="button"
          onClick={onClear}
          className={cn("tnum text-[11px] font-semibold uppercase tracking-wider text-mint hover:underline", !anchored && "mt-1.5")}
        >
          Clear all · {count}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close filters"
        className={cn("ml-auto grid size-8 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper", !anchored && "mt-1.5")}
      >
        <X className="size-4" />
      </button>
    </div>
  );

  if (anchored) {
    if (!pos) return null; // one layout pass before it can know where to sit
    return createPortal(
      <div
        ref={boxRef}
        role="dialog"
        aria-label="Filters and sort"
        tabIndex={-1}
        style={{ ...pos, width: "22rem", maxWidth: "calc(100vw - 1rem)" }}
        className="pop-in fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[var(--rr-shadow-3)]"
      >
        {head}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      {/* The sheet gets a dimmed ground so it reads as a layer, and the ground
          is the dismissal target — bigger and far more obvious than
          "somewhere else on the page". */}
      <div className="absolute inset-0 bg-ink/60 backdrop-blur-[1px]" onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label="Filters and sort"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-line bg-panel shadow-[var(--rr-shadow-3)]"
      >
        {head}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>

        {/* A phone sheet covers the list it is filtering, so the count has to
            come to the sheet — otherwise you tune filters blind and only find
            out what you did after dismissing it. */}
        <div
          className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-4 py-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <p aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fog">
            {resultLabel}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="h-11 shrink-0 rounded-lg border border-mint bg-mint px-5 text-sm font-semibold text-mint-ink shadow-[var(--rr-bevel-strong),var(--rr-shadow-1)] active:translate-y-px"
          >
            Show results
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
