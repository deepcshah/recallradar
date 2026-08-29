/* DialKit authoring surface.
 *
 * Every motion constant in the app is routed through here so it can be tuned
 * live instead of by editing a number, rebuilding, and looking again. The
 * values come back as CSS custom properties, which is what the animations
 * actually read — see the `--rr-*` variables in index.css.
 *
 * DialKit is an authoring tool, not a runtime dependency: the panel only
 * mounts in development, and the tuned numbers are meant to be baked back
 * into the defaults below (and the dependency dropped) before shipping.
 *
 * Defaults sit on DialKit's inferred step grid (0.1s for seconds, 10ms for
 * the card stagger). Off-grid values get snapped in the panel, which would
 * make the tuned preview disagree with what production actually renders.
 */
import { useDialKit } from "dialkit";

export const DEV = import.meta.env.DEV;

/* The shipped values. In production these are used verbatim; in development
 * DialKit seeds its sliders from them. Ranges are [default, min, max]. */
export const MOTION = {
  radar: {
    duration: [2, 0.6, 4],      // seconds for one ring to expand and fade
    stagger: [0.7, 0.1, 1.5],   // seconds between successive rings
    size: [240, 120, 420],      // px diameter a ring expands to
  },
  card: {
    rise: [8, 0, 32],           // px a card travels up as it fades in
    duration: [0.4, 0.1, 1.2],  // seconds for one card's entrance
    stagger: [50, 0, 160],      // ms between successive cards in a list
  },
};

const shipped = (group) =>
  Object.fromEntries(Object.entries(group).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

/** Tuned motion values, as a style object of CSS custom properties. */
export function useMotionTuning() {
  // Hook order is stable: useDialKit runs on every render in every build.
  // Only <DialRoot /> decides whether a panel is visible, and it renders null
  // in production builds on its own.
  const params = useDialKit("Motion", MOTION, {
    id: "rr-motion-v1",
    persist: DEV ? { storage: "localStorage" } : false,
  });
  const v = DEV ? params : { radar: shipped(MOTION.radar), card: shipped(MOTION.card) };
  return {
    "--rr-radar-duration": `${v.radar.duration}s`,
    "--rr-radar-stagger": `${v.radar.stagger}s`,
    "--rr-radar-size": `${v.radar.size}px`,
    "--rr-card-rise": `${v.card.rise}px`,
    "--rr-card-duration": `${v.card.duration}s`,
    "--rr-card-stagger": `${v.card.stagger}ms`,
  };
}

/** ms between successive items in a staggered list, read back from the tuner. */
export function cardStagger(style) {
  return parseFloat(style["--rr-card-stagger"]) || MOTION.card.stagger[0];
}
