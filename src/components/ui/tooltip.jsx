import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * TOOLTIP
 *
 * A shadcn-shaped tooltip, written against plain DOM because the app carries
 * no Radix dependency — so the pieces Radix would give us are here
 * explicitly: an open delay, a portal, viewport-aware placement, dismissal on
 * Escape and on scroll, and `aria-describedby` wiring.
 *
 * It replaces `title=""`, which was doing this job badly: the native tooltip
 * takes about a second to appear, cannot be styled, renders in the OS font at
 * the OS size, never appears on keyboard focus, and on a touch device either
 * does nothing or fires a long-press menu.
 *
 * Two deliberate limits:
 *
 * - It opens for a mouse, and for keyboard focus. It does not open on touch.
 *   A tooltip is a pointer affordance; on a phone there is no hover state to
 *   hang it from, and a tooltip that needs a long press is a tooltip nobody
 *   finds. Anything a phone user must know belongs in the interface itself,
 *   so `content` here is always a supplement and never the only copy.
 * - It describes, it does not name. The trigger keeps its own accessible
 *   name; this only adds `aria-describedby`. A control whose only label is
 *   its tooltip is unusable to anyone who cannot summon one.
 * ───────────────────────────────────────────────────────────────────────── */

const OPEN_DELAY = 220;
const GAP = 8;
const EDGE = 8;

let uid = 0;

export function Tooltip({ content, children, side = "top", className, disabled }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  const wrapRef = React.useRef(null);
  const bubbleRef = React.useRef(null);
  const timer = React.useRef(null);
  const idRef = React.useRef(null);
  if (idRef.current == null) idRef.current = `tt-${++uid}`;

  const cancel = React.useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  const schedule = React.useCallback(() => {
    if (disabled || !content) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  }, [disabled, content]);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  /* Measure after the bubble exists, so placement uses its real size rather
   * than a guess — a two-line tooltip near the top of the window has to flip
   * below, and it cannot know it is two lines until it has been laid out. */
  React.useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const place = () => {
      /* The wrapper is `display: contents`, so it generates no box of its own
       * and its own rect is all zeros — measure the control inside it. */
      const anchor = wrapRef.current?.firstElementChild || wrapRef.current;
      const t = anchor?.getBoundingClientRect();
      const b = bubbleRef.current?.getBoundingClientRect();
      if (!t) return;
      const w = b ? b.width : 200;
      const h = b ? b.height : 32;
      const above = t.top - GAP - h;
      const below = t.bottom + GAP;
      const flip = side === "top" ? above < EDGE : below + h > window.innerHeight - EDGE;
      const top = (side === "top") === !flip ? above : below;
      const left = Math.min(
        Math.max(EDGE, t.left + t.width / 2 - w / 2),
        Math.max(EDGE, window.innerWidth - w - EDGE)
      );
      setPos({ top: Math.max(EDGE, top), left });
    };
    place();
    // A second pass once the bubble has been measured for real.
    const raf = requestAnimationFrame(place);
    const onKey = (e) => e.key === "Escape" && cancel();
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, side, cancel]);

  if (!content) return children;

  return (
    <>
      <span
        ref={wrapRef}
        className={cn("contents", className)}
        // `pointerType` is what keeps this off touch screens: a tap fires a
        // pointerenter too, and without the guard every tap on a phone would
        // leave a tooltip stranded on screen.
        onPointerEnter={(e) => e.pointerType === "mouse" && schedule()}
        onPointerLeave={cancel}
        onPointerDown={cancel}
        onFocusCapture={(e) => {
          // Only a keyboard focus ring earns a tooltip; a click already
          // focused the control and the pointer path handles that case.
          if (e.target.matches?.(":focus-visible")) setOpen(true);
        }}
        onBlurCapture={cancel}
      >
        {/* `aria-describedby` has to land on the control itself. A
         * `display: contents` element is dropped from the accessibility tree,
         * so the attribute would go nowhere if it stayed on the wrapper — the
         * tooltip would look right and announce nothing. Every trigger used
         * here spreads unknown props onto its own element, so cloning one prop
         * in is enough and needs no ref forwarding. */}
        {open && React.isValidElement(children)
          ? React.cloneElement(children, { "aria-describedby": idRef.current })
          : children}
      </span>

      {open && createPortal(
        <div
          ref={bubbleRef}
          id={idRef.current}
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          className={cn(
            "pop-in pointer-events-none fixed z-[70] max-w-[min(20rem,calc(100vw-1rem))]",
            "rounded-lg border border-line bg-panel px-2.5 py-1.5",
            "text-[12px] font-medium leading-snug text-paper shadow-[var(--rr-shadow-3)]"
          )}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
}
