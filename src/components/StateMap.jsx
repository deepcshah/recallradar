import { ABBR_TO_NAME } from "@/lib/states";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────
 * WHERE THE NOTICE SAYS IT WENT — a tile map, not a geographic one
 *
 * A distribution list is a list of states, and every state on it carries the
 * same weight: "shipped to RI" is as much a yes for a Rhode Islander as
 * "shipped to TX" is for a Texan. A real map says the opposite — Texas is
 * eighty-five Rhode Islands of ink — so a notice sent to RI, DE and DC reads
 * as an empty map with specks on it. The tile grid gives every state one
 * equal square in roughly the right place, which is the question actually
 * being asked: is mine one of them?
 *
 * The layout is the standard 11 × 8 grid (the one NPR and most newsrooms
 * use), hardcoded because it is a published convention and not something to
 * compute. Puerto Rico is not on that grid; it is drawn in the spare bottom-
 * right cell only when the notice names it or the reader is there, so it never
 * appears as an unexplained extra square.
 *
 * Colour follows the app's rule for everything that is not a classification:
 * none. Named states are a solid neutral fill, the rest are sunken, and the
 * reader's own state is ringed rather than tinted — so "yours is not on the
 * list" never reads as a reassuring green, and "yours is" never borrows the
 * red that belongs to Class I.
 * ───────────────────────────────────────────────────────────────────────── */

// [abbr, column, row]
const GRID = [
  ["AK", 0, 0], ["ME", 10, 0],
  ["VT", 9, 1], ["NH", 10, 1],
  ["WA", 0, 2], ["ID", 1, 2], ["MT", 2, 2], ["ND", 3, 2], ["MN", 4, 2], ["IL", 5, 2],
  ["WI", 6, 2], ["MI", 7, 2], ["NY", 8, 2], ["RI", 9, 2], ["MA", 10, 2],
  ["OR", 0, 3], ["NV", 1, 3], ["WY", 2, 3], ["SD", 3, 3], ["IA", 4, 3], ["IN", 5, 3],
  ["OH", 6, 3], ["PA", 7, 3], ["NJ", 8, 3], ["CT", 9, 3],
  ["CA", 0, 4], ["UT", 1, 4], ["CO", 2, 4], ["NE", 3, 4], ["MO", 4, 4], ["KY", 5, 4],
  ["WV", 6, 4], ["VA", 7, 4], ["MD", 8, 4], ["DE", 9, 4],
  ["AZ", 1, 5], ["NM", 2, 5], ["KS", 3, 5], ["AR", 4, 5], ["TN", 5, 5], ["NC", 6, 5],
  ["SC", 7, 5], ["DC", 8, 5],
  ["OK", 3, 6], ["LA", 4, 6], ["MS", 5, 6], ["AL", 6, 6], ["GA", 7, 6],
  ["HI", 0, 7], ["TX", 3, 7], ["FL", 8, 7],
];
const PR_CELL = ["PR", 10, 7];

const CELL = 26;   // one tile plus its gutter, in viewBox units
const TILE = 23;
const COLS = 11;
const ROWS = 8;

function listForLabel(states) {
  const names = states.map((s) => ABBR_TO_NAME[s] || s);
  if (names.length <= 8) return names.join(", ");
  return `${names.length} states: ${states.join(", ")}`;
}

/**
 * @param {object}   props
 * @param {'nationwide'|'states'|'unstated'} props.kind   verdict.js coverageOf(record).kind
 * @param {string[]} [props.states]     two-letter codes the notice names
 * @param {string}   [props.userState]  the reader's two-letter state, ringed
 * @param {string}   [props.className]
 */
export default function StateMap({ kind, states = [], userState, className }) {
  const named = new Set(kind === "states" ? states : []);
  const all = kind === "nationwide";
  const cells = named.has("PR") || userState === "PR" ? [...GRID, PR_CELL] : GRID;
  const mine = userState && ABBR_TO_NAME[userState] ? userState : null;

  /* The label is the map, for anyone who cannot see it: it says what is
   * filled and where the reader stands relative to it, in the same terms as
   * the verdict line above it. */
  let label;
  if (all) label = "Map: the notice lists nationwide distribution; every state is filled.";
  else if (kind === "unstated") label = "Map: the notice names no states, so none are filled.";
  else label = `Map: the notice names ${listForLabel([...named])}.`;
  if (mine && !all) {
    label += named.has(mine)
      ? ` Your state, ${ABBR_TO_NAME[mine]}, is one of them.`
      : ` Your state, ${ABBR_TO_NAME[mine]}, is outlined and is not filled.`;
  }

  return (
    <figure className={cn("m-0", className)}>
      <svg
        viewBox={`-2 -2 ${COLS * CELL + 1} ${ROWS * CELL + 1}`}
        role="img"
        aria-label={label}
        className="block h-auto w-full max-w-[20rem]"
      >
        {cells.map(([abbr, c, r]) => {
          const on = all || named.has(abbr);
          const isMine = abbr === mine;
          return (
            <g key={abbr} transform={`translate(${c * CELL} ${r * CELL})`}>
              <rect
                width={TILE}
                height={TILE}
                rx={4}
                style={{
                  fill: on ? "var(--rr-muted)" : "var(--rr-sunken)",
                  stroke: isMine ? "var(--rr-text)" : on ? "none" : "var(--rr-line)",
                  strokeWidth: isMine ? 2.25 : 1,
                }}
              />
              <text
                x={TILE / 2}
                y={TILE / 2}
                dy="0.35em"
                textAnchor="middle"
                style={{
                  fill: on ? "var(--rr-surface)" : "var(--rr-subtle)",
                  fontSize: 8.5,
                  fontWeight: isMine ? 800 : 600,
                  letterSpacing: "0.02em",
                }}
              >
                {abbr}
              </text>
            </g>
          );
        })}
      </svg>
      {kind === "unstated" && (
        <figcaption className="mt-1.5 text-[11px] leading-snug text-subtle">
          The notice doesn't name any states, so nothing is filled — that is not the same as
          "nowhere".
        </figcaption>
      )}
      {mine && kind !== "unstated" && (
        <figcaption className="mt-1.5 flex items-center gap-3 text-[11px] leading-snug text-subtle">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] bg-fog" />
            {all ? "Nationwide" : "Named in the notice"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] border-[1.5px] border-paper" />
            Your state
          </span>
        </figcaption>
      )}
    </figure>
  );
}
