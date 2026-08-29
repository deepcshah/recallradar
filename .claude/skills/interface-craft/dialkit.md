# DialKit

**Part of [Interface Craft](SKILL.md) by Josh Puckett**

Generate DialKit 1.4.3 configurations — live control panels for tuning animation and style values, plus a scrubbable timeline for tuning choreography and reversible state changes. Examples use React + Motion; Timeline also supports Solid, Svelte 5, and Vue 3.

---

## When to use

- User mentions DialKit, dials, sliders, controls, tune, tweak
- User wants a live UI to adjust animation parameters
- User says "add controls for..." or "let me tune..."
- User wants to tune clip timing, sequences, loops, or event-driven playback
- User wants a timed layer, visibility, interaction, or other discrete state change
- User asks for a timeline, playhead, or scrubbing

## Choose Panels or Timeline

Use `useDialKit` when the user wants to tune individual parameters:

- Spring physics
- Scale, opacity, blur, color, spacing, or layout
- Toggles, selects, text, or actions
- A single animation's transition values

Use `useDialTimeline` when the user wants to tune when animation happens:

- Clip start times and durations
- Coordinated entrances and exits
- Multi-step sequences or independently timed properties
- Loops or intro-then-loop behavior
- Scrubbing and playhead control
- Event-driven animations that need replaying
- Declarative timeline markers such as a `tuck`, layer switch, or visibility boundary

Use both when the task needs appearance controls and choreography. For any Timeline task, read and follow [dialkit-timeline.md](dialkit-timeline.md) before generating code.

## Mode Detection

### Direct Mode
Triggers when user describes what they want with context:
- "use DialKit to give me sliders for blur and opacity"
- "add dialkit controls for scale, rotation, and a spring"
- "I need toggles and sliders for my card animation"

In direct mode, generate the config immediately based on the request.

If the request mentions timeline, clips, markers, timed events, playhead, scrubbing, sequence timing, loops, or replayable animation, route to [dialkit-timeline.md](dialkit-timeline.md).

### Guided Mode
Triggers when user invokes without specific context or asks for help:
- `/interface-craft dialkit`
- "help me set up dialkit"
- "walk me through adding dialkit"

In guided mode, ask 2-3 concise questions then generate.

## Setup Check

Before generating configs, inspect the project's instructions, package manager, `package.json`, and lockfile. This guidance targets DialKit 1.4.3.

1. Verify `dialkit` is installed at 1.4.3 and the framework's required animation package is present.
2. Never add or upgrade dependencies silently. If the user authorizes an npm change, preserve the exact version:
```bash
npm install --save-exact dialkit@1.4.3 motion
```

3. Check for the authoring surface required by the task:

- Parameter panels use `DialRoot`.
- Timelines use `DialTimeline`.
- A project using both should mount both once as siblings of the application content.

If either required surface is missing, remind the user:
```tsx
import { DialRoot, DialTimeline } from 'dialkit'
import 'dialkit/styles.css'

// Add the surfaces the project uses to the root layout:
<DialRoot position="top-right" />
<DialTimeline />
```

`DialRoot` and `DialTimeline` are independent. Do not require `DialRoot` for a timeline-only task. In 1.4.3, Timeline supports React, Solid, Svelte 5, and Vue 3; use each framework's DialKit entry point and returned-value access pattern.

## Guided Flow Questions

Keep it fast - 2-3 questions max:

1. **Component context**: "What component are you adding controls to? Share the code or describe what you're building."

2. **Property selection**: "What properties do you want to tweak? Common options:
   - **Visual**: blur, opacity, scale, borderRadius
   - **Position**: offsetX, offsetY, rotation
   - **Animation**: spring (with visualDuration/bounce controls)
   - **Interaction**: action buttons, toggles"

3. Generate with smart defaults - don't ask about ranges.

## Smart Defaults

Use these defaults for common properties (users can adjust in the panel):

| Property | Default | Min | Max | Step |
|----------|---------|-----|-----|------|
| blur | 0 | 0 | 100 | 1 |
| opacity | 1 | 0 | 1 | 0.01 |
| scale | 1 | 0.5 | 2 | 0.1 |
| rotation | 0 | -180 | 180 | 1 |
| offsetX | 0 | -100 | 100 | 1 |
| offsetY | 0 | -100 | 100 | 1 |
| borderRadius | 0 | 0 | 50 | 1 |
| shadowBlur | 16 | 0 | 48 | 1 |
| shadowOffsetY | 8 | 0 | 24 | 1 |
| gap | 16 | 0 | 48 | 1 |
| padding | 16 | 0 | 48 | 1 |

## Control Types

See [references/config-patterns.json](references/config-patterns.json) for the full schema. Summary:

### 1. Slider (explicit range)
```tsx
blur: [24, 0, 100]  // [default, min, max]
```

### 2. Slider (auto-inferred)
```tsx
scale: 1.18  // auto-infers range based on value
```

### 3. Toggle
```tsx
visible: true
```

### 4. Spring (Time mode - simpler)
```tsx
spring: {
  type: 'spring',
  visualDuration: 0.3,
  bounce: 0.2,
}
```

### 5. Spring (Physics mode - more control)
```tsx
spring: {
  type: 'spring',
  stiffness: 200,
  damping: 25,
  mass: 1,
}
```

### 6. Action Button
```tsx
reset: { type: 'action' }
next: { type: 'action', label: 'Next Slide' }
```

### 7. Select Dropdown
```tsx
theme: {
  type: 'select',
  options: ['light', 'dark', 'system'],
  default: 'system',
}
```

### 8. Color Picker
```tsx
backgroundColor: { type: 'color', default: '#3b82f6' }
// or auto-detected from hex string:
accentColor: '#3b82f6'
```

### 9. Text Input
```tsx
title: { type: 'text', default: 'Hello', placeholder: 'Enter title...' }
// or auto-detected from plain string:
label: 'Click me'
```

### 10. Folder (nested grouping)
```tsx
shadow: {
  offsetY: [8, 0, 24],
  blur: [16, 0, 48],
  opacity: [0.2, 0, 1],
}
```

## Output Format

For Timeline work, follow the output and production-handoff rules in [dialkit-timeline.md](dialkit-timeline.md).

For regular panels, always generate complete, copy-paste ready code:

```tsx
import { useDialKit } from 'dialkit'
import { motion } from 'motion/react'

function ComponentName() {
  const params = useDialKit('ComponentName', {
    // Generated config here
  })

  return (
    <motion.div
      style={{
        // Apply params
      }}
      animate={{
        // Animate params
      }}
      transition={params.spring}
    />
  )
}
```

## Example Generations

### Request: "sliders for blur and opacity"
```tsx
const params = useDialKit('Effects', {
  blur: [0, 0, 100],
  opacity: [1, 0, 1],
})

// Usage:
style={{
  filter: `blur(${params.blur}px)`,
  opacity: params.opacity,
}}
```

### Request: "spring animation with scale"
```tsx
const params = useDialKit('Animation', {
  scale: [1, 0.5, 2],
  spring: {
    type: 'spring',
    visualDuration: 0.3,
    bounce: 0.2,
  },
})

// Usage:
animate={{ scale: params.scale }}
transition={params.spring}
```

### Request: "card with shadow controls"
```tsx
const params = useDialKit('Card', {
  borderRadius: [16, 0, 50],
  shadow: {
    offsetY: [8, 0, 24],
    blur: [16, 0, 48],
    opacity: [0.2, 0, 1],
  },
})

// Usage:
style={{
  borderRadius: params.borderRadius,
  boxShadow: `0 ${params.shadow.offsetY}px ${params.shadow.blur}px rgba(0,0,0,${params.shadow.opacity})`,
}}
```

### Request: "controls with actions"
```tsx
const params = useDialKit('Slideshow', {
  autoPlay: true,
  interval: [3, 1, 10],
  next: { type: 'action' },
  prev: { type: 'action' },
  reset: { type: 'action' },
}, {
  onAction: (action) => {
    if (action === 'next') goNext()
    if (action === 'prev') goPrev()
    if (action === 'reset') reset()
  },
})
```

## Tips for Generation

1. **Infer panel name** from component name or context
2. **Group related controls** in nested objects (folders)
3. **Use Time mode springs** by default (simpler for most users)
4. **Include usage comments** showing how to apply each param
5. **Match user's coding style** if they shared code
6. **Route timing work to Timeline** instead of recreating a timeline with ordinary sliders
7. **Model reversible timed events as markers** and derive UI state from `started`, `active`, or `progress`; do not replace them with timers
