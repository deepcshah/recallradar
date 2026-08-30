# DialKit Timeline

Use DialKit 1.4.3 Timeline to author and tune animation choreography: clip timing, sequences, independent property tracks, loops, replayable interactions, reversible timeline events, and scrubbing. Examples use React; Timeline also supports Solid, Svelte 5, and Vue 3.

## Contents

- [Setup](#setup)
- [Core model](#core-model)
- [Recommended authoring pattern](#recommended-authoring-pattern)
- [Choose a clip shape](#choose-a-clip-shape)
- [Discrete timeline events](#discrete-timeline-events)
- [Playback and loops](#playback-and-loops)
- [Rendering semantics](#rendering-semantics)
- [Production handoff](#production-handoff)
- [Output rules](#output-rules)

## Setup

Inspect project instructions, `package.json`, and the lockfile. Verify `dialkit` is version 1.4.3 and the framework's required animation package is installed. Do not add or upgrade dependencies without the user's authorization. Import the shared styles and mount `DialTimeline` once. `DialRoot` is optional unless the project also uses regular parameter panels.

```tsx
import { DialTimeline } from "dialkit";
import "dialkit/styles.css";

export function App({ children }) {
  return (
    <>
      {children}
      <DialTimeline />
    </>
  );
}
```

Use the adapter that matches the project:

| Framework | Import | Timeline function | Read returned values |
| --- | --- | --- | --- |
| React | `dialkit` | `useDialTimeline` | `timeline.card.current` |
| Solid | `dialkit/solid` | `createDialTimeline` | `timeline().card.current` |
| Svelte 5 | `dialkit/svelte` | `createDialTimeline` | `timeline.card.current` |
| Vue 3 | `dialkit/vue` | `useDialTimeline` | `timeline.value.card.current` in script; auto-unwrapped in templates |

## Core model

- Keep animation structure in code. Let the dock edit timing, values, and curves; do not expect it to invent clips, steps, loops, or relationships between elements.
- Give every clip a semantic name and an `at` start time, such as `enter`, `idle`, `cardReveal`, or `dismiss`.
- Give discrete state boundaries semantic names such as `tuck`, `enableInput`, or `moveBehind`.
- Use separate clips for separate behaviors even when one element combines their output.
- Treat top-level `duration` as a minimum editing window. Omit it for an initially exact-fit window. Allow the timeline to extend when edited content, especially a physics spring, grows past the boundary.
- Keep loop behavior code-defined.
- Use a stable `id` when persisting edits. In application projects, prefer development-only persistence unless the user explicitly wants authored overrides in production.
- For a reusable configuration, declare it separately with `satisfies TimelineConfig` so TypeScript checks its shape without losing literal inference.

## Recommended authoring pattern

Use `clip.current` by default so every intermediate state remains scrubbable. Apply the returned values directly and preserve any expressions that combine multiple clips.

```tsx
import { useDialTimeline } from "dialkit";

function Toast() {
  // TODO(production): DialKit's clip.current values are the scrubbable authoring preview.
  // Replace them with equivalent real Motion animations using the tuned timeline
  // timings and transitions, then remove useDialTimeline and <DialTimeline />.
  const toast = useDialTimeline(
    "Toast",
    {
      enter: {
        at: 0,
        duration: 0.45,
        from: { y: 16, scale: 0.94, opacity: 0 },
        to: { y: 0, scale: 1, opacity: 1 },
        transition: {
          type: "spring",
          visualDuration: 0.45,
          bounce: 0.2,
        },
      },
      dismiss: {
        at: 2,
        duration: 0.25,
        from: { y: 0, opacity: 1 },
        to: { y: -12, opacity: 0 },
        transition: {
          type: "easing",
          duration: 0.25,
          ease: [0.55, 0, 1, 0.45],
        },
      },
    },
    { autoplay: false },
  );

  const enter = toast.enter.current;
  const dismiss = toast.dismiss.current;

  return (
    <>
      <div
        style={{
          opacity: Math.min(enter.opacity, dismiss.opacity),
          transform: `translateY(${enter.y + dismiss.y}px) scale(${enter.scale})`,
        }}
      >
        Changes saved
      </div>
      <button onClick={() => toast.replay()}>Show toast</button>
    </>
  );
}
```

DialKit does not automatically compose `enter` and `dismiss`; the application owns expressions such as `enter.y + dismiss.y`. Preserve that composition while editing and during production conversion.

## Choose a clip shape

### One transition: `from` and `to`

Use one clip for one transition. A time spring or easing takes its length from the bar. A physics spring using `stiffness`, `damping`, or `mass` derives its duration from its settle time; edit the physics instead of resizing its bar.

```tsx
cardEnter: {
  at: 0.4,
  duration: 0.6,
  from: { y: 32, opacity: 0 },
  to: { y: 0, opacity: 1 },
  transition: { type: "spring", visualDuration: 0.6, bounce: 0.2 },
}
```

### Sequential legs: `steps`

Use `steps` for explicit sequential states on one clip. Declare every animated property in `from`. A step changes only properties named in its `to`; all other properties hold their previous value.

```tsx
path: {
  at: 0,
  from: { x: -70, y: 0, opacity: 0 },
  steps: [
    { duration: 0.5, to: { x: 0, opacity: 1 } },
    { duration: 0.4, to: { y: 36 } },
    { duration: 0.6, to: { x: 80, y: 0 } },
  ],
}
```

### Independent property timing: `props`

Use `props` when properties need separate delays, durations, curves, or steps.

```tsx
card: {
  at: 0.4,
  props: {
    opacity: { from: 0, to: 1, duration: 0.3 },
    y: { from: 32, to: 0, duration: 0.6, delay: 0.1 },
  },
}
```

### Markers

- Use a clip with only `at` and optional `duration` as a timing marker. Read its `started`, `active`, or `progress`; it has no `current` values.

### Groups

Nest clips one level inside a named object to create a presentational group. Grouping does not compose their animation values.

## Discrete timeline events

Model a reversible event as a zero-duration marker. DialKit does not invoke a callback; it derives marker state from the playhead. Use `started` for the before/after boundary so scrubbing backward restores the earlier state automatically.

```tsx
const close = useDialTimeline(
  "Gift close",
  {
    duration: 1.6,
    letter: {
      travel: {
        at: 0.01,
        duration: 0.92,
        from: { progress: 0 },
        to: { progress: 1 },
        transition: { type: "spring", bounce: 0.25 },
      },
      tuck: {
        at: 0.31,
        duration: 0,
      },
    },
  },
  {
    id: "gift-close-v1",
    persist: process.env.NODE_ENV === "development",
    autoplay: false,
  },
);

const letterLayer = close.letter.tuck.started ? 10 : 50;

return <div style={{ zIndex: letterLayer }}>{/* letter */}</div>;
```

This makes the `tuck` visible and movable in the authoring timeline while the application owns its meaning: before 0.31s the letter is above the envelope; at and after 0.31s it is behind the envelope front.

Follow these rules:

- Use `started` for an instantaneous marker (`duration: 0`). A zero-duration marker has no sustained active interval, so do not use `active` as its event flag.
- Use `active` for a finite on/off interval and `progress` for a finite custom effect. Markers do not return `current` values.
- Derive render state directly from the marker. Do not mirror it into React state or recreate it with `setTimeout`; both approaches make reverse scrubbing and seeking harder to reason about.
- Use markers for reversible UI state such as layer order, visibility, pointer interaction, labels, or mode changes. When switching `zIndex`, ensure the affected layers share the intended stacking context.
- Do not treat a marker as an imperative one-shot callback for analytics, network requests, purchases, destructive actions, or other external side effects. The playhead can cross the same marker repeatedly while replaying or scrubbing; keep those effects attached to the application's real event lifecycle.

## Playback and loops

- Use `autoplay: false` for event-driven UI and call `replay()` from the application's real trigger.
- Use `loop: true` on a clip to repeat that clip's cycle.
- Use the hook option `{ loop: { from: number } }` for a one-time intro followed by a looping region.
- Use `play()`, `pause()`, `replay()`, and `seek(time)` only as authoring transport or intentional application controls.
- Keep the real application trigger wired to the timeline while authoring so replay behavior is tested in context.
- Respect reduced-motion preferences. For an event-driven sequence, seek to the end and complete the application's state transition immediately instead of playing the choreography.

## Rendering semantics

### Recommended: `current`

Bind `clip.current` directly while tuning. DialKit deterministically samples the configured easing or damped-spring equation, making intermediate states scrubbable. The sampler is designed to closely preview Motion but does not guarantee frame-for-frame identity with Motion's runtime implementation.

Hiding or removing only `<DialTimeline />` hides the dock; it does not change what renders the animation. As long as code reads `clip.current`, DialKit's sampled values still drive the element.

Do not feed `clip.current` into a second animated `animate` layer that smooths those values, because that breaks deterministic scrubbing.

### Alternative: real Motion during authoring

Use `clip.animate` with `clip.transition` when actual Motion playback matters more than scrubbing. Motion then runs the curve, but seeking the timeline jumps between endpoints rather than rendering intermediate states.

## Production handoff

Treat the Timeline as an authoring system. Do not remove or convert it until the user explicitly asks to finalize the animation for production.

1. Generate the timeline with `clip.current` and the `TODO(production)` comment shown above.
2. Tune and scrub the animation in its real interface context.
3. Use Copy to bake the tuned values into the `useDialTimeline` configuration. Keep `clip.current` during authoring.
4. When explicitly asked to finalize, inspect both the timeline configuration and every consumer of its values.
5. Inventory marker consumers such as `started`, `active`, and `progress`; zero-duration clips can be easy to miss because they have no `current` values.
6. Translate the tuned choreography and every discrete marker boundary to the application's real Motion animation system or state sequence.
7. Remove DialKit only after every value binding, marker consumer, transport call, hook, component, and unused import has been replaced.

Use this mapping as a guide, not as a blind textual rewrite:

- `at` → delay or sequence offset relative to the application's trigger
- `from` / `to` → Motion `initial` / `animate` or imperative animation controls
- Spring transition → pass the tuned spring parameters to Motion
- Easing transition → translate to Motion's equivalent duration/ease tween
- `steps` → keyframes or an imperative animation sequence
- `props` → independently timed property keyframes or controls
- Marker `started` / `active` / `progress` → an equivalent reversible discrete state boundary or finite custom effect at the same offset
- Clip loop → Motion repetition
- Timeline loop region → an explicit intro followed by a repeated production sequence
- `replay()` or other transport calls → application state or Motion controls
- Expressions combining multiple `current` values → equivalent composed production behavior

Preserve behavior before removing DialKit. Do not assume that copying values alone performs this conversion.

## Output rules

1. Generate complete, copy-paste-ready code for the project's framework, using the matching adapter and returned-value access pattern.
2. Mount `DialTimeline` once and only when Timeline is used.
3. Prefer `clip.current` for authoring and apply every returned value to the actual interface.
4. Preserve the application's existing triggers and value-composition expressions.
5. Keep clip structure, sequences, and loops explicit in code.
6. Use zero-duration markers plus `started` for reversible timeline events; never substitute timers or attach irreversible external side effects to the playhead.
7. Add the `TODO(production)` handoff comment immediately above every generated timeline hook/function call.
8. Do not convert to production Motion or remove DialKit unless explicitly requested.
9. When finalizing, verify that no timeline hook/function, `DialTimeline`, `current`, marker-state, or transport references remain.
