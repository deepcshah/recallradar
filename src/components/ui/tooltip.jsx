import * as React from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * TWO WAYS TO SAY MORE
 *
 * `Tooltip`  — a hover hint on a control that already says what it is.
 *              Mouse and keyboard only. It supplements; it is never the only
 *              copy, because a phone will never see it.
 *
 * `InfoTip`  — a disclosure on a *term*. It is a real button, it opens on tap
 *              as well as on hover, and it carries a visible affordance so a
 *              phone user can tell there is something to open. Use this
 *              wherever the extra text is the difference between understanding
 *              the interface and guessing at it — "Class I" being the case
 *              this was written for.
 *
 * Why two components rather than one that always opens on tap: the trigger
 * has to change with the behaviour. A hover hint hangs off whatever element is
 * already there and adds `aria-describedby`. A tappable disclosure has to be a
 * button, has to say `aria-expanded`, has to be at least a thumb across, and
 * has to *look* openable — otherwise it is a secret. Bolting tap onto Tooltip
 * would have made every hint a lie on touch: reachable in principle, invisible
 * in practice, and sometimes swallowing a tap meant for the control beneath.
 *
 * Both share one placement engine: measure the real bubble, flip when it would
 * leave the viewport, clamp to the edges, and dismiss on Escape, on scroll and
 * on resize. Neither is ever the only place a fact lives.
 * ───────────────────────────────────────────────────────────────────────── */

const OPEN_DELAY = 220;   // hover only; a tap opens immediately
const GAP = 8;
const EDGE = 8;

let uid = 0;

function useBubbleId(prefix) {
  const ref = React.useRef(null);
  if (ref.current == null) ref.current = `${prefix}-${++uid}`;
  return ref.current;
}

/** Position a portalled bubble against an anchor, and wire up dismissal.
 *  Returns the fixed coordinates, or null until the first measurement. */
function usePlacement({ open, side, anchorRef, bubbleRef, onDismiss }) {
  const [pos, setPos] = React.useState(null);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const t = anchorRef.current?.getBoundingClientRect();
      const b = bubbleRef.current?.getBoundingClientRect();
      if (!t) return;
      const w = b ? b.width : 220;
      const h = b ? b.height : 36;
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
    const onKey = (e) => e.key === "Escape" && onDismiss();
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, side, anchorRef, bubbleRef, onDismiss]);

  return pos;
}

const BUBBLE_CLASS =
  "pop-in pointer-events-none fixed z-[70] max-w-[min(20rem,calc(100vw-1rem))] " +
  "rounded-lg border border-line bg-panel shadow-[var(--rr-shadow-3)]";

/* ───────────────────────────────── Tooltip ─────────────────────────────── */

/* It replaces `title=""`, which was doing this job badly: the native tooltip
 * takes about a second to appear, cannot be styled, renders in the OS font at
 * the OS size, never appears on keyboard focus, and on a touch device either
 * does nothing or fires a long-press menu.
 *
 * It describes, it does not name. The trigger keeps its own accessible name;
 * this only adds `aria-describedby`. A control whose only label is its tooltip
 * is unusable to anyone who cannot summon one. */
export function Tooltip({ content, children, side = "top", className, disabled }) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef(null);
  const anchorRef = React.useRef(null);
  const bubbleRef = React.useRef(null);
  const timer = React.useRef(null);
  const id = useBubbleId("tt");

  const cancel = React.useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);

  const schedule = React.useCallback(() => {
    if (disabled || !content) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  }, [disabled, content]);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  /* The wrapper is `display: contents`, so it generates no box of its own and
   * its own rect is all zeros — measure the control inside it. */
  React.useLayoutEffect(() => {
    anchorRef.current = wrapRef.current?.firstElementChild || wrapRef.current;
  });

  const pos = usePlacement({ open, side, anchorRef, bubbleRef, onDismiss: cancel });

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
          ? React.cloneElement(children, { "aria-describedby": id })
          : children}
      </span>

      {open && createPortal(
        <div
          ref={bubbleRef}
          id={id}
          role="tooltip"
          style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          className={cn(BUBBLE_CLASS, "px-2.5 py-1.5 text-[12px] font-medium leading-snug text-paper")}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
}

/* ───────────────────────────────── InfoTip ─────────────────────────────── */

/* THE TOUCH RULE, since this is the component that settles it:
 *
 *   Hover opens it on a mouse, after the same delay as a tooltip, so a
 *   desktop reader gets the definition for free.
 *   A click or tap PINS it open, on every device, and a second one closes it.
 *   Tapping anywhere else closes it. So does Escape, and so does scrolling.
 *
 * Long-press is not used and never should be: it is the OS's gesture, it
 * conflicts with text selection and the context menu, it has no visible
 * affordance, and no one goes looking for it. The `ⓘ` is the affordance —
 * small, always present, and the one convention a phone user already reads as
 * "there is more here". The button is a full thumb target even when the term
 * inside it is 11px type.
 *
 * The trigger keeps its own text as its accessible name and adds
 * `aria-expanded` / `aria-controls`, which is the disclosure pattern: the
 * definition is content that appears, not a label that has to be summoned. */
/* `variant`:
 *   "term"  (default) — the child is a word in a sentence. The trigger wraps
 *                       it, dotted-underlines it, and sets the ⓘ after it.
 *   "badge"           — the child is a pill. The trigger *becomes* the pill
 *                       and the ⓘ goes inside it.
 *
 * The second exists because the first was being used for both. Wrapping a
 * rounded badge put the mark after the badge's right edge, so "Not classified
 * ⓘ Injury hazard" rendered as a floating glyph between two pills, attached
 * to neither and looking like a third, broken one. A badge is a box; a
 * disclosure about it belongs inside the box. */
export function InfoTip({
  title, body, children, side = "top", className, triggerClassName, label,
  variant = "term",
}) {
  const [open, setOpen] = React.useState(false);
  const pinned = React.useRef(false);
  const btnRef = React.useRef(null);
  const bubbleRef = React.useRef(null);
  const timer = React.useRef(null);
  const id = useBubbleId("info");

  const close = React.useCallback(() => {
    clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
  }, []);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  // A tap outside dismisses. Bound only while open, and only outside the
  // trigger — the trigger's own click is the toggle.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!btnRef.current?.contains(e.target)) close(); };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, close]);

  const pos = usePlacement({ open, side, anchorRef: btnRef, bubbleRef, onDismiss: close });

  if (!body && !title) return children;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse" || pinned.current) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "mouse" || pinned.current) return;
          clearTimeout(timer.current);
          setOpen(false);
        }}
        onClick={() => {
          clearTimeout(timer.current);
          const next = !(open && pinned.current);
          pinned.current = next;
          setOpen(next);
        }}
        onFocus={(e) => { if (e.target.matches?.(":focus-visible")) setOpen(true); }}
        onBlur={() => { if (!pinned.current) setOpen(false); }}
        className={cn(variant === "badge" ? "infotip-badge" : "infotip",
                      open && (variant === "badge" ? "infotip-badge-open" : "infotip-open"),
                      triggerClassName)}
      >
        {variant === "badge" && React.isValidElement(children)
          /* Cloned rather than wrapped, so the mark lands inside the badge's
           * own border and inherits its colour. Wrapping could only ever put
           * it outside, which is the bug this variant exists to fix. */
          ? React.cloneElement(children, undefined,
              children.props.children,
              <Info key="infotip-mark" className="infotip-mark" aria-hidden="true" />)
          : (<>
              {children}
              <Info className="infotip-mark" aria-hidden="true" />
            </>)}
      </button>

      {open && createPortal(
        <div
          ref={bubbleRef}
          id={id}
          role="note"
          style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          className={cn(BUBBLE_CLASS, "w-[min(19rem,calc(100vw-1rem))] px-3 py-2.5", className)}
        >
          {title && <p className="text-[12px] font-bold leading-snug text-paper">{title}</p>}
          {body && <p className="mt-1 text-[12px] font-medium leading-relaxed text-fog">{body}</p>}
        </div>,
        document.body
      )}
    </>
  );
}
