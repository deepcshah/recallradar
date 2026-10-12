import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * NEAR ME · NY  │  ALL US
 *
 * The one global answer to "which recalls am I looking at?". It drives Home's
 * Latest recalls list (where it sits, on the list it scopes), the stores and
 * Recalls view, and the counts; search is always national and only changes
 * how it orders.
 *
 * A segmented control with radio semantics: one Tab stop, arrows move and
 * select (roving tabindex), Home/End jump. The selected segment is a raised
 * neutral, never mint — a green "Near me" would read as "near me is fine".
 *
 * "Near me" with no location does not switch: it asks for a place (the
 * caller opens the picker) and the switch follows once one is set.
 *
 * STORYBOARD
 *    0ms  selection changes; the pill slides under the new segment, 180ms
 *         (instant under prefers-reduced-motion — see .scope-pill)
 * ───────────────────────────────────────────────────────────────────────── */

const OPTIONS = ["near", "us"];

export default function ScopeSwitch({ scope, stateAbbr, onChange, className }) {
  const refs = useRef({});
  const boxRef = useRef(null);
  const [pill, setPill] = useState(null);

  const nearFull = stateAbbr ? `Near me · ${stateAbbr}` : "Near me";
  const nearCompact = stateAbbr || "Near me";
  const titles = {
    near: stateAbbr ? `Near me: recalls distributed to ${stateAbbr} or nationwide` : "Near me: set a location to see recalls for your state",
    us: "All US: every recall in the last year, wherever it went",
  };

  // Measure the selected segment so the pill can slide to it.
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[scope];
      if (!el) return;
      setPill({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    return () => ro && ro.disconnect();
  }, [scope, stateAbbr]);

  const onKeyDown = (e) => {
    const i = OPTIONS.indexOf(scope);
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = OPTIONS[Math.min(OPTIONS.length - 1, i + 1)];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = OPTIONS[Math.max(0, i - 1)];
    else if (e.key === "Home") next = OPTIONS[0];
    else if (e.key === "End") next = OPTIONS[OPTIONS.length - 1];
    if (!next) return;
    e.preventDefault();
    if (next !== scope) onChange(next, "header");
    refs.current[next]?.focus();
  };

  return (
    <div
      ref={boxRef}
      role="radiogroup"
      aria-label="Which recalls to show"
      onKeyDown={onKeyDown}
      className={cn("relative inline-flex shrink-0 items-center rounded-full bg-[var(--rr-track)] p-1", className)}
    >
      {pill && (
        <span
          aria-hidden="true"
          className="scope-pill absolute left-0 top-1 bottom-1 rounded-full bg-[var(--rr-thumb)] shadow-[var(--rr-shadow-2)]"
          style={{ width: pill.w, transform: `translateX(${pill.x}px)` }}
        />
      )}
      {OPTIONS.map((key) => {
        const on = scope === key;
        return (
          <button
            key={key}
            ref={(el) => { refs.current[key] = el; }}
            id={`scope-${key}`}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={titles[key]}
            onClick={() => onChange(key, "header")}
            className={cn(
              "relative z-[1] inline-flex h-8 items-center whitespace-nowrap rounded-full px-3 text-[13px] font-semibold transition-colors sm:px-3.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint pointer-coarse:h-11",
              on ? "text-paper" : "text-fog hover:text-paper",
            )}
          >
            {key === "near" ? (
              <>
                <span className="sm:hidden">{nearCompact}</span>
                <span className="hidden sm:inline">{nearFull}</span>
              </>
            ) : "All US"}
          </button>
        );
      })}
    </div>
  );
}
