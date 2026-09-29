import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSheetPresence } from "@/components/ui/sheet";

/* ─────────────────────────────────────────────────────────────────────────
 * ONE SURFACE, TWO SHAPES
 *
 * The pattern every location picker people already know uses (Instacart,
 * Target, Airbnb, Maps): a control in the header opens ONE surface, and that
 * surface changes shape with the device rather than the control moving.
 *
 *   ≥ md (768px)  an anchored popover, hung under the control that opened it,
 *                 left edges aligned, clamped 8px inside the viewport. No
 *                 scrim; a click outside closes it. Non-modal to assistive
 *                 tech, but focus is still kept inside while it is open.
 *   < md          a bottom sheet: scrim, grabber, safe-area padding. Modal.
 *
 * An iPad in portrait (820px) gets the popover. It used to get a phone sheet
 * stretched 820px wide, which is a phone pattern at twice the size it was
 * designed for.
 *
 * MOTION STORYBOARD
 *
 *    popover    0ms   mounted, opacity 0, 4px up, scale .98
 *              16ms   → settled, 160ms ease-out (exit 120ms, shorter — a
 *                     dismissal has to feel like it obeyed you)
 *    sheet      0ms   mounted off-screen
 *              16ms   → slides up on the app's sheet curve (--rr-sheet-in)
 *
 * Both keep the surface mounted through the exit (useSheetPresence), and both
 * drop their travel under prefers-reduced-motion (see index.css). Focus waits
 * for the sheet to arrive on touch, so the on-screen keyboard does not start
 * sliding up while the sheet is still sliding up under it.
 * ───────────────────────────────────────────────────────────────────────── */

export const SHEET_ENTER_MS = 280;
const GAP = 6;
const EDGE = 8;
const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";

/** True at md and up. Read synchronously on first render so the surface never
 *  mounts in the wrong shape and then jumps. */
export function useIsMd() {
  const q = "(min-width: 768px)";
  const [md, setMd] = useState(() => typeof window !== "undefined" && window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const sync = () => setMd(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return !!md;
}

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {string}   props.anchorId     id of the control that opened it (popover anchor, focus return)
 * @param {string}   props.title
 * @param {string}   [props.titleId]
 * @param {string}   [props.id]         id on the dialog (for aria-controls)
 * @param {number}   [props.width=360]
 * @param {object}   [props.initialFocusRef]
 * @param {boolean}  [props.returnFocus=true]
 * @param {Function} [props.renderHeader]  (isSheet) => node, replaces the default header
 */
export function ResponsiveSurface({
  open, onClose, anchorId, title, titleId, id, width = 360, initialFocusRef, returnFocus = true,
  renderHeader, children, className,
}) {
  const md = useIsMd();
  const boxRef = useRef(null);
  const { mounted, shown } = useSheetPresence(open);
  const [pos, setPos] = useState(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /* A click outside that closed the popover landed on something the reader
   * meant to use; focus must not be yanked back to the anchor from it. */
  const skipReturnRef = useRef(false);

  /* Where the popover sits. Measured against the viewport (fixed), because the
   * anchor lives in a header whose own stacking context would trap an
   * absolutely positioned child under the page. */
  useLayoutEffect(() => {
    if (!mounted || !md) return undefined;
    const anchor = document.getElementById(anchorId);
    if (!anchor) return undefined;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = Math.min(width, window.innerWidth - EDGE * 2);
      const left = Math.min(Math.max(EDGE, r.left), window.innerWidth - EDGE - w);
      const top = r.bottom + GAP;
      setPos({ left, top, width: w, maxHeight: window.innerHeight - top - EDGE });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [mounted, md, anchorId, width]);

  // Focus in, trap, Escape, outside click; focus back to the anchor on close.
  useEffect(() => {
    if (!open) return undefined;
    skipReturnRef.current = false;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    const delay = !md && coarse ? SHEET_ENTER_MS : 0;
    const t = setTimeout(() => {
      const box = boxRef.current;
      const target = initialFocusRef?.current || box?.querySelector(FOCUSABLE) || box;
      target?.focus?.({ preventScroll: true });
    }, delay);

    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const box = boxRef.current;
      if (!box) return;
      const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const onDown = (e) => {
      if (!md) return; // the sheet's scrim is its own dismissal target
      const box = boxRef.current;
      if (box && !box.contains(e.target) && !e.target.closest?.(`#${anchorId}`)) {
        skipReturnRef.current = true;
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      if (returnFocus && !skipReturnRef.current) {
        const anchor = document.getElementById(anchorId);
        if (anchor) anchor.focus({ preventScroll: true });
      }
    };
  }, [open, md, anchorId, initialFocusRef, returnFocus]);

  if (!mounted) return null;

  const header = renderHeader ? renderHeader(!md) : (
    <div className="relative flex shrink-0 items-center gap-2 px-4 pb-2 pt-4">
      {!md && <span aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-line-strong" />}
      <p id={titleId} className="text-sm font-bold">{title}</p>
      {!md && (
        <button type="button" onClick={onClose} aria-label="Close"
                className="ml-auto grid size-8 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper">
          <X className="size-4" />
        </button>
      )}
    </div>
  );

  if (md) {
    if (!pos) return null; // one layout pass before it knows where to sit
    return createPortal(
      <div
        ref={boxRef}
        id={id}
        role="dialog"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : title}
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
        className={cn(
          "popover-panel fixed z-[70] flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--rr-shadow-3)]",
          shown && "is-shown", !shown && "pointer-events-none", className,
        )}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className={"fixed inset-0 z-[75] " + (shown ? "" : "pointer-events-none")}>
      <div className={"sheet-scrim absolute inset-0 bg-ink/60 backdrop-blur-[1px] " + (shown ? "is-shown" : "")}
           onClick={onClose} />
      <div
        ref={boxRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : title}
        tabIndex={-1}
        className={cn(
          "sheet-panel absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden",
          "rounded-t-2xl border border-b-0 border-line bg-panel shadow-[var(--rr-shadow-3)]",
          shown && "is-shown", className,
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
