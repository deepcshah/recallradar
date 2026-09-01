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

/* A bottom sheet: dimmed ground, rounded top, grabber, safe-area padding.
 *
 * Portalled, because every sheet in this app is triggered from inside a panel
 * that is `relative z-10` — a stacking context, which quietly traps a `fixed`
 * child underneath anything above z-10 in the page. That is not hypothetical;
 * it is how the filter sheet's own confirm button ended up under the footer.
 *
 * Focus moves in on open, is trapped while open, and returns to whatever
 * opened it — the sheet claims `aria-modal`, and that has to be true.
 */
export function Sheet({ open, onClose, title, children, footer }) {
  const boxRef = useRef(null);
  const { mounted, shown } = useSheetPresence(open);

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    const box = boxRef.current;
    const focusables = () => [...(box?.querySelectorAll(
      "button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"
    ) || [])];
    (focusables()[0] || box)?.focus?.();

    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    /* Inert on the way out. The sheet is still on screen for the length of the
       slide, and a tap that lands on a surface already leaving would fire a
       control the user has just dismissed. */
    <div className={"fixed inset-0 z-[75] " + (shown ? "" : "pointer-events-none")}>
      <div className={"sheet-scrim absolute inset-0 bg-ink/60 backdrop-blur-[1px] " + (shown ? "is-shown" : "")}
           onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={"sheet-panel absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden " +
          "rounded-t-2xl border border-b-0 border-line bg-panel shadow-[var(--rr-shadow-3)] " +
          (shown ? "is-shown" : "")}
      >
        <div className="relative flex shrink-0 items-center gap-2 border-b border-line px-4 pb-3 pt-4">
          <span aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-line-strong" />
          <p className="text-sm font-bold">{title}</p>
          <button onClick={onClose} aria-label="Close"
                  className="ml-auto grid size-8 place-items-center rounded-lg text-fog hover:bg-panel-3 hover:text-paper">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-line px-4 pt-3"
               style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
