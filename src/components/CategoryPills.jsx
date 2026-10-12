import { Apple, Beef, LayoutGrid, Package, Pill, Stethoscope } from "lucide-react";
import { PRIMARY_CATEGORIES } from "@/lib/primary-category";

/* ─────────────────────────────────────────────────────────────────────────
 * CATEGORY PILLS — filter at a glance
 *
 *   ( All 4,910 ) ( Food 120 ) ( Meat & poultry 6 ) ( Drugs 66 ) …
 *
 * One row under the search card, scrolling sideways on a phone. Each pill
 * carries a quiet count for what is below it right now — the latest list in
 * the current scope (Near me / All US), or the search results while there is
 * a query — so a choice is never a surprise. A pill with nothing in it stays
 * pressable: an honest "none here" is a result, not a dead end.
 *
 * Selected is ink-filled; the accent is kept for actions. aria-pressed, not
 * radio semantics: each pill is a toggle back to All on a second press.
 * ───────────────────────────────────────────────────────────────────────── */

const ICONS = { all: LayoutGrid, food: Apple, meat: Beef, drug: Pill, device: Stethoscope, product: Package };

/**
 * @param {string}   props.value     "all" | primary key
 * @param {Function} props.onChange  (key) => void
 * @param {Map}      [props.counts]  key → number; omitted while loading
 * @param {string}   [props.label]   accessible group label
 */
export default function CategoryPills({ value = "all", onChange, counts, label = "Filter by category", className = "" }) {
  return (
    <div role="group" aria-label={label} className={"pill-row -mx-4 px-4 sm:-mx-6 sm:px-6 " + className}>
      {PRIMARY_CATEGORIES.map(({ key, label: text }) => {
        const Icon = ICONS[key];
        const on = value === key;
        const n = counts ? counts.get(key) : null;
        return (
          <button
            key={key}
            type="button"
            data-cat={key}
            aria-pressed={on}
            onClick={() => onChange(on && key !== "all" ? "all" : key)}
            className="pill"
          >
            <Icon aria-hidden="true" strokeWidth={1.9} />
            <span>{text}</span>
            {n != null && (
              <span className="pill-count">
                <span className="sr-only">, </span>
                {n.toLocaleString("en-US")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
