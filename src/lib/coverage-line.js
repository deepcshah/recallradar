/* Where a notice sent the product, as one short line — shown on every
 * collapsed card, because for a reader outside those states "Sent to IL, IN,
 * IA …" is the fact they came for, and it used to be one tap away.
 *
 *   Sent to IL, IN, IA, KS, MN, OH, PA, TX     (up to 8 states, then "+N more")
 *   Distributed nationwide
 *   Where it was sold isn't stated
 *
 * Read from coverageOf (verdict.js), so it can never disagree with the
 * verdict beside it. */
import { coverageOf } from "./verdict.js";

export const COVERAGE_MAX_STATES = 8;

export function coverageLine(record, { max = COVERAGE_MAX_STATES } = {}) {
  const cov = coverageOf(record);
  if (cov.kind === "nationwide") return "Distributed nationwide";
  if (cov.kind === "states") {
    const shown = cov.states.slice(0, max).join(", ");
    const more = cov.states.length - max;
    return `Sent to ${shown}${more > 0 ? ` +${more} more` : ""}`;
  }
  return "Where it was sold isn't stated";
}

/** Compact suffix for a one-line summary: "IL, IN +6" / "nationwide" / "". */
export function coverageSuffix(record) {
  const cov = coverageOf(record);
  if (cov.kind === "nationwide") return "nationwide";
  if (cov.kind === "states") {
    const more = cov.states.length - 2;
    return cov.states.slice(0, 2).join(", ") + (more > 0 ? ` +${more}` : "");
  }
  return "";
}
