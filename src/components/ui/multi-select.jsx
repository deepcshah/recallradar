import * as React from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* A shadcn-shaped multi-select: a trigger that summarises the selection, a
 * popover with a filter box, and checkable rows.
 *
 * Written against plain DOM rather than Radix because the app carries no
 * Radix dependency — so the pieces Radix would give us are here explicitly:
 * outside-click and Escape dismissal, roving focus through the options with
 * the arrow keys, and listbox semantics for screen readers.
 *
 * `selected` is an array of option values; an empty array means "everything",
 * which is why the trigger reads "All Types" rather than "None".
 */
function MultiSelect({
  options,
  selected,
  onChange,
  allLabel = "All",
  itemNoun = "selected",
  searchPlaceholder = "Search…",
  emptyText = "Nothing to filter yet",
  className,
  triggerClassName,
  align = "left",
  id,
  ...props
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const rootRef = React.useRef(null);
  const searchRef = React.useRef(null);
  const listRef = React.useRef(null);

  const chosen = React.useMemo(() => new Set(selected), [selected]);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Dismissal: a click anywhere outside, or Escape from anywhere inside.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus after the popover has painted, or the caret lands nowhere.
      const t = setTimeout(() => searchRef.current && searchRef.current.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Keep the highlighted row inside the scroll box as the arrows move it.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector('[data-cursor="true"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const toggle = React.useCallback(
    (value) => {
      const next = new Set(selected);
      next.has(value) ? next.delete(value) : next.add(value);
      onChange([...next]);
    },
    [selected, onChange]
  );

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!visible.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + step + visible.length) % visible.length);
      return;
    }
    if (e.key === "Enter" && visible[cursor]) {
      e.preventDefault();
      toggle(visible[cursor].value);
    }
  }

  const count = selected.length;
  const triggerText =
    count === 0
      ? allLabel
      : count === 1
        ? (options.find((o) => o.value === selected[0]) || {}).label || `1 ${itemNoun}`
        : `${count} ${itemNoun}`;

  return (
    <div ref={rootRef} className={cn("relative", className)} {...props}>
      {/* The trigger and its clear affordance are siblings sharing one shell,
       * not nested buttons: a control inside a control is both invalid to a
       * screen reader and a click that reaches two handlers at once. */}
      <div
        className={cn(
          "inline-flex h-9 items-center rounded-lg border border-line-strong bg-panel-2",
          "shadow-[var(--rr-bevel),var(--rr-shadow-1)] transition-colors",
          "focus-within:ring-2 focus-within:ring-mint/60 focus-within:ring-offset-2 focus-within:ring-offset-[var(--rr-surface)]",
          count > 0 && "border-mint-line bg-mint-soft",
          triggerClassName
        )}
      >
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(
            "flex h-full max-w-[11rem] items-center gap-1.5 rounded-lg pl-3 text-[13px] font-semibold",
            "focus-visible:outline-none",
            count > 0 ? "pr-1 text-mint" : "pr-2 text-paper"
          )}
        >
          <span className="truncate capitalize">{triggerText}</span>
          <ChevronDown
            className={cn("size-3.5 shrink-0 text-fog transition-transform", open && "rotate-180")}
          />
        </button>
        {count > 0 && (
          <button
            type="button"
            aria-label={`Clear ${allLabel.toLowerCase()} filter`}
            title="Clear filter"
            onClick={() => onChange([])}
            className="mr-1.5 grid size-5 shrink-0 place-items-center rounded-full text-mint hover:bg-mint hover:text-mint-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/60"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {open && (
        <div
          onKeyDown={onKeyDown}
          /* Anchored to the right edge below sm: the trigger sits near the end
           * of the header row on a phone, and a left-anchored 16rem panel runs
           * off the viewport and takes the whole page into horizontal scroll. */
          className={cn(
            "pop-in absolute z-50 mt-1.5 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl",
            "border border-line bg-panel shadow-[var(--rr-shadow-3)]",
            align === "right" ? "right-0" : "right-0 sm:left-0 sm:right-auto"
          )}
        >
          <div className="relative border-b border-line">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fog" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-9 w-full bg-transparent pl-9 pr-3 text-[13px] text-paper placeholder:text-subtle focus:outline-none"
            />
          </div>

          <ul
            ref={listRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label={allLabel}
            className="max-h-64 overflow-y-auto p-1"
          >
            {visible.length === 0 && (
              <li className="px-3 py-4 text-center text-[13px] text-subtle">{emptyText}</li>
            )}
            {visible.map((o, i) => {
              const on = chosen.has(o.value);
              return (
                <li key={o.value}>
                  <div
                    role="option"
                    aria-selected={on}
                    data-cursor={i === cursor ? "true" : undefined}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => toggle(o.value)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors",
                      i === cursor ? "bg-panel-3" : "bg-transparent",
                      on ? "text-paper" : "text-fog"
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                        on ? "border-mint bg-mint text-mint-ink" : "border-line-strong bg-panel-2"
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate capitalize">{o.label}</span>
                    {o.count != null && (
                      <span className="tnum shrink-0 text-[11px] text-subtle">{o.count}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex items-center justify-between border-t border-line px-2 py-1.5">
            <button
              type="button"
              onClick={() => onChange(options.map((o) => o.value))}
              className="rounded-md px-2 py-1 text-[12px] font-semibold text-fog hover:bg-panel-3 hover:text-paper"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={count === 0}
              className="rounded-md px-2 py-1 text-[12px] font-semibold text-fog hover:bg-panel-3 hover:text-paper disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export { MultiSelect };
