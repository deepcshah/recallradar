import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * HOW FRESH IS WHAT YOU'RE READING
 *
 *   Data: FDA as of Sep 24 · USDA Sep 27 · CPSC Sep 25
 *
 * One quiet line wherever the app gives an answer that could be read as "not
 * here": the digest, an empty search, the recall list, a "Not reported in"
 * card. "Not in our copy from Sep 24" and "doesn't exist" are different
 * claims, and without the date they read the same.
 *
 * Entries come from freshnessOf() in lib/search-index.js. An unknown date is
 * "not loaded", never assumed fresh; a stale one gets an amber dot and says
 * how old it is in its accessible name.
 * ───────────────────────────────────────────────────────────────────────── */

const SHORT = { FDA: "FDA", "USDA FSIS": "USDA", CPSC: "CPSC" };

export function fmtAsOf(iso, { long = false } = {}) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { month: long ? "long" : "short", day: "numeric", timeZone: "UTC" });
}

/** The oldest known "as of" date among the entries — the honest bound on
 *  "a recall announced after this may not be here yet". */
export function oldestAsOf(entries) {
  const known = (entries || []).map((e) => e.asOf).filter(Boolean).sort();
  return known[0] || null;
}

/** True when this list has no FDA records and FDA's date is unknown or stale:
 *  the list is missing an agency, and the reader must be told. */
export function fdaMissing(entries, records) {
  const fda = (entries || []).find((e) => e.source === "FDA");
  if (!fda || !(fda.asOf == null || fda.stale)) return false;
  return !(records || []).some((r) => String(r && r.source).startsWith("FDA") && r.source !== "FDA announcement");
}

export default function FreshnessLine({ entries, variant = "inline", className }) {
  if (!entries || !entries.length) return null;
  const spoken = entries.map((e) => (e.asOf
    ? `${e.source === "USDA FSIS" ? "USDA" : e.source} as of ${fmtAsOf(e.asOf, { long: true })}${e.stale ? ", may be out of date" : ""}`
    : `${SHORT[e.source] || e.source} not loaded`)).join(", ");
  return (
    <p
      aria-label={`Data freshness: ${spoken}`}
      className={cn("tnum text-[11px] leading-relaxed text-subtle", variant === "block" && "text-[12px]", className)}
    >
      <span aria-hidden="true">
        Data:{" "}
        {entries.map((e, i) => {
          const name = SHORT[e.source] || e.source;
          const when = e.asOf ? fmtAsOf(e.asOf) : "";
          const tip = e.stale
            ? (e.asOf ? `${name} data may be out of date (last ${when})` : `${name} data isn't loaded`)
            : undefined;
          return (
            <span key={e.source} title={tip} className="whitespace-nowrap">
              {i > 0 && " · "}
              {e.stale && <span className="mr-1 inline-block size-1.5 translate-y-[-1px] rounded-full bg-amber align-middle" />}
              {e.asOf ? `${name}${i === 0 ? " as of" : ""} ${when}` : `${name} not loaded`}
            </span>
          );
        })}
      </span>
    </p>
  );
}

/** "FDA recalls aren't in this list yet" — no alarm styling, one amber dot. */
export function FdaGapNote({ className }) {
  return (
    <p className={cn("flex gap-1.5 text-[12px] leading-snug text-fog", className)}>
      <span aria-hidden="true" className="mt-[5px] inline-block size-1.5 shrink-0 rounded-full bg-amber" />
      <span>
        FDA recalls aren't in this list yet. They load after the next data refresh. Search still checks FDA directly.
      </span>
    </p>
  );
}
