import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/* How long the exit takes. The same number lives in index.css as
 * `--rr-sheet-out`; it is duplicated because the CSS owns the travel and this
 * file owns the unmount, and the unmount must not land first. */
export const SHEET_EXIT_MS = 240;

/* Mount, slide in, slide out, unmount.
 *
 * A sheet cannot animate away while React is deleting it, so closing has two
 * phases: `shown` flips false and the CSS transition runs, and only then does
 * `mounted` follow and the tree go. The double rAF on the way in is not
 * superstition — a single frame runs before the browser has painted the
 * element in its start position, so the transition has nothing to interpolate
 * from and the sheet is simply there.
 */
export function useSheetPresence(open) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), SHEET_EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  return { mounted, shown };
}

/* Drag the grabber down to dismiss. The panel follows the finger 1:1 (the
 * `is-dragging` class drops the transition); release past DISMISS_PX or with
 * a downward flick closes, anything less springs back on --rr-spring. Only
 * the grabber strip starts a drag, so scrolling the body never fights it. */
const DISMISS_PX = 120;
const FLICK_PX_PER_MS = 0.6;

export function useDragToDismiss(panelRef, onClose) {
  const st = useRef(null);
  const set = (y) => panelRef.current?.style.setProperty("--rr-drag", `${Math.max(0, y)}px`);
  return {
    onPointerDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      st.current = { y0: e.clientY, t0: performance.now(), dy: 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panelRef.current?.classList.add("is-dragging");
    },
    onPointerMove(e) {
      if (!st.current) return;
      st.current.dy = e.clientY - st.current.y0;
      set(st.current.dy);
    },
    onPointerUp() {
      const d = st.current;
      st.current = null;
      const el = panelRef.current;
      if (!d || !el) return;
      el.classList.remove("is-dragging");
      const v = d.dy / Math.max(1, performance.now() - d.t0);
      if (d.dy > DISMISS_PX || (d.dy > 24 && v > FLICK_PX_PER_MS)) onClose();
      else set(0);
    },
    onPointerCancel() {
      st.current = null;
      panelRef.current?.classList.remove("is-dragging");
      set(0);
    },
  };
}

/* One sheet, two shapes:
 *
 *   phone  a bottom sheet — scrim, 28px top corners, a grabber you can drag,
 *          safe-area padding, rising on the app's spring.
 *   ≥640   a centred dialog, 28px corners, growing in place (a 1440px-wide
 *          bottom sheet is a phone pattern at four times its size).
 *
 * `variant="detail"` is the recall sheet: no title bar — the grabber and a
 * floating close button sit over the content, so the content's own title is
 * the title — and `footer` floats as a frosted action bar over the bottom of
 * the scroll instead of taking a band of its own.
 *
 * Portalled, because sheets are triggered from inside panels that are
 * stacking contexts. Focus moves in on open, is trapped while open, and
 * returns to whatever opened it — the sheet claims `aria-modal`. */
export function Sheet({ open, onClose, title, children, footer, variant = "default", size = "md", labelledBy }) {
  const boxRef = useRef(null);
  const { mounted, shown } = useSheetPresence(open);
  const drag = useDragToDismiss(boxRef, onClose);
  const detail = variant === "detail";

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    const box = boxRef.current;
    const focusables = () => [...(box?.querySelectorAll(
      "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"
    ) || [])];
    /* The detail sheet lands focus on the dialog itself, not on its first
     * button: the first button is Close, and a screen reader opening a
     * recall should hear the recall, not "Close, button". */
    (detail ? box : (focusables()[0] || box))?.focus?.({ preventScroll: true });

    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge || document.activeElement === box) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    };
  }, [open, onClose, detail]);

  if (!mounted) return null;

  const width = size === "lg" ? "sm:max-w-[640px]" : "sm:max-w-[480px]";

  return createPortal(
    /* Inert on the way out: a tap landing on a surface already leaving would
       fire a control the user has just dismissed. */
    <div className={"fixed inset-0 z-[75] flex items-end justify-center sm:items-center sm:p-6 " + (shown ? "" : "pointer-events-none")}>
      <div className={"sheet-scrim absolute inset-0 bg-[var(--rr-scrim)] " + (shown ? "is-shown" : "")}
           onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={"sheet-panel sheet-centered relative flex w-full flex-col overflow-hidden outline-none " +
          "max-h-[92dvh] rounded-t-[28px] bg-panel shadow-[var(--rr-shadow-3)] " +
          "sm:max-h-[88dvh] sm:rounded-[28px] " + width + " " +
          (shown ? "is-shown" : "")}
      >
        {/* The grabber strip: 28px tall, the whole width, the drag target. */}
        <div {...drag}
             className="relative z-[2] flex h-7 shrink-0 touch-none items-start justify-center pt-2 sm:hidden"
             aria-hidden="true">
          <span className="sheet-grabber" />
        </div>
        {detail ? (
          <button type="button" onClick={onClose} aria-label="Close"
                  className="glass absolute right-3 top-3 z-[3] grid size-11 place-items-center rounded-full text-paper shadow-[var(--rr-shadow-2)] hover:bg-panel-3 sm:right-4 sm:top-4 sm:size-10">
            <X className="size-[18px]" aria-hidden="true" />
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2 px-5 pb-2 sm:pt-5">
            <p className="text-[17px] font-semibold tracking-tight">{title}</p>
            <button onClick={onClose} aria-label="Close"
                    className="icon-btn -mr-2 ml-auto">
              <X className="size-[18px]" />
            </button>
          </div>
        )}
        <div data-sheet-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (detail ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] px-3 pt-6 sm:px-4"
               style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
                        background: "linear-gradient(to top, var(--rr-surface) 55%, transparent)" }}>
            <div className="pointer-events-auto">{footer}</div>
          </div>
        ) : (
          <div className="shrink-0 border-t border-line px-5 pt-3"
               style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}>
            {footer}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
