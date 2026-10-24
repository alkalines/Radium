# Radium Interface Design: Harness Surface Spec

Status: **v1, adopted for new UI.** Existing screens migrate one at a time; an unmigrated screen is not a template. Motion tokens: `apps/web/src/lib/motion.tsx`. Visual tokens: the `[data-design="harness"]` block in `apps/web/src/styles/app.css`.

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** follow RFC 2119. A MUST rule is a review blocker. A deviation needs a `//` comment at the call site stating the reason.

Inspiration: the OpenCode desktop app (window chrome, session tabs, settings) and Proton Lumo (empty-state composer). They informed the initial layout and density; Radium develops its own style from here. Do not copy their branding, and treat the values below as Radium's starting tokens, not as a match target.

## 1. Design intent

Radium is a **tool, not a landing page**. The interface is a quiet desktop-style harness: dense, flat, neutral, and predictable. Content and agent output carry the visual weight; chrome recedes.

1. **Quiet by default.** Neutral grays, one accent, no gradients, no shadows, no decorative copy. The only expressive surface is the empty Session (§5.3).
2. **State is legible.** Which session is open, which Run is working, and what waits on the user are visible without reading prose.
3. **Motion is causal.** Animate only a state change or a direct input. Navigation between tabs and settings pages is instant.

Forbidden on product screens: hero sections, eyebrow labels (`01 / SECTION`), marketing taglines, stat strips, background grids behind content, glow outside the empty Session, and gradient text.

## 2. Vocabulary

Use these terms in component names, props, `data-*` attributes, docs, and reviews. Do not substitute synonyms.

| Term | Definition |
| --- | --- |
| **Window** | The full viewport. Background `--chrome`. Holds the Tab strip and one Panel. |
| **Tab strip** | 44px row at the top of the Window: Home button, Session tabs, New-tab button. |
| **Tab** | One open Session. Open Tabs persist on the device: reopening the app restores them. |
| **Home** | The home screen, opened by the Home button in the Tab strip. It is not a Tab. v1 contents: Projects column and session list. |
| **Panel** | The inset content surface below the Tab strip: `bg-background`, Hairline border, 10px radius, 8px gap to the Window edge. Exactly one per Window. |
| **Session** | One conversation with agents. Belongs to a workspace and, in future, a Project. |
| **Project** | A folder grouping Sessions (planned; UI slots exist, behavior is not implemented). |
| **Group list** | A `bg-card` block of rows divided by Hairlines, 8px radius. The standard container for settings and entity lists. |
| **Row** | One entity in a Group list or session list: 40–56px tall, title + optional Tag + trailing controls. |
| **Tag** | Inline 11px label with 2px radius describing a Row (`API key`, `Account`, `Planned`). |
| **Composer** | The prompt input: text area plus a toolbar (attach, model, effort, send). |
| **Context bar** | The row under the Composer that shows workspace, Worker, and branch as Chips. |
| **Chip** | A compact selector or label in the Context bar. |
| **Run**, **Step**, **RunState** | Agent execution, its units, and their lifecycle (§6). |
| **Machine text** | Code, commands, file paths, branch names, model IDs, and keyboard shortcuts. |
| **Hairline** | 1px border using `border-border`. |
| **Motion token** | A named duration, easing, spring, or stagger from `lib/motion.tsx`. |

## 3. Visual tokens

### 3.1 Scope and source

- Harness tokens are defined under `[data-design="harness"]` in `app.css`, for dark and light. They override the shadcn variables (`--background`, `--card`, `--muted`, `--border`, `--primary`, `--radius`, …), so shadcn components restyle without per-component overrides.
- A migrated screen MUST render inside an element with `data-design="harness"`. Once every screen migrates, the block moves to `:root` and the attribute is removed.
- Components MUST use semantic utilities (`bg-card`, `text-muted-foreground`, `border-border`). Hex, oklch, or palette classes (`bg-zinc-900`) in components are forbidden.

### 3.2 Surfaces (dark)

| Token | Value | Use |
| --- | --- | --- |
| `--chrome` | `#080808` | Window background, Tab strip. |
| `--background` | `#161616` | Panel. |
| `--card` | `#222222` | Group list, Composer. |
| `--accent` | `#2c2c2c` | Hover and selected Row, active nav item, active Tab. |
| `--muted` | `#1c1c1c` | Code blocks, terminal output. |
| `--tag` | `#2e2e2e` | Tag background. |
| `--border` | `rgb(255 255 255 / 8%)` | Hairlines. |
| `--foreground` | `#ededed` | Titles and body. |
| `--muted-foreground` | `#a0a0a0` | Secondary text, descriptions. |
| `--subtle-foreground` | `#707070` | Group headings (`Today`), placeholders, inactive Tab titles. |
| `--primary` | `#ededed` | Primary button (near-white on dark). Not a brand color. |
| `--brand` | Radium orange | Project tile and the empty Session glow. Never buttons or status. |

Surfaces stack at most three deep: `--chrome` → `--background` → `--card`. Elevation is expressed by these steps only; `shadow-*` utilities MUST NOT be added on Harness screens (shadcn's own popover shadows are acceptable).

### 3.3 Typography

| Role | Spec |
| --- | --- |
| Base | Inter Variable, `text-sm` (14px). Dense lists MAY use `text-[13px]`. |
| Screen title | `text-base font-medium`. One per screen. No serif, nothing above `text-base` on product screens except the greeting. |
| Section heading | `text-sm font-medium`. |
| Group heading (`Today`, `Older`) | `text-sm text-subtle-foreground`. |
| Description | `text-sm text-muted-foreground`. |
| Tag | `text-[11px] font-medium`, 2px radius, `bg-tag`, Hairline. |
| Machine text | `font-mono text-[13px]` (JetBrains Mono), only for the values listed in §2. Labels, statuses, and numbers in prose stay in Inter. |
| Empty Session greeting | `text-3xl font-medium tracking-tight`. The only large type in the product. |

- Live-updating numbers MUST use `tabular-nums`.
- Truncate long titles with `truncate`; expose the full value in a `Tooltip` or `title`.

### 3.4 Geometry

| Element | Radius | Height |
| --- | --- | --- |
| Panel | 10px (`rounded-[10px]`) | — |
| Group list | 8px (`rounded-lg`) | Rows 44–56px |
| Tab, nav item, menu item | 6px (`rounded-md`) | 28–32px |
| Buttons, inputs | from `--radius` (6px base) | 28–32px |
| Tag | 2px (`rounded-[2px]`) | 16px |
| Composer | 16px (`rounded-2xl`) | ≥ 96px |

- Content columns: settings content 712px max; session list 720px max; conversation 760px max.
- Settings use a 240px nav + content, centered in the Panel with 48px top padding.

## 4. Layout model

```
Window (--chrome)
├─ Tab strip (44px)  [Home] [Tab ×] [Tab ×] … [+]
└─ Panel (--background, 10px radius, 8px inset)
   └─ Screen: Home | Session | Settings
```

- The Window MUST NOT have a persistent sidebar. Navigation lives in the Tab strip, Home, and Settings.
- Opening a Session from Home focuses its Tab if one is open, otherwise appends a Tab and focuses it.
- Closing the active Tab focuses its right neighbor, else the left one, else Home.
- `+` creates an empty Session Tab (`New session`).
- Open Tabs MUST persist in `localStorage` (versioned key, every read and write wrapped in `try/catch`). Tabs are client UI state, so they MUST NOT be stored in Convex. A Tab stores only IDs and display hints; session content is always loaded from the backend, and a Tab whose session no longer exists or is no longer accessible is dropped on restore.
- Settings replace the Panel content with their own nav. `Back to app` returns to the previously focused Tab or Home.

## 5. Screens

### 5.1 Home

- Left column (240px): `Projects` heading with a new-folder icon button, the Project list, then `Settings` and `Help`. Until Projects ship, the new-folder button is disabled and its Tooltip says `Projects are planned`.
- Right column: search input (`Search sessions in <workspace>`), then sessions grouped by recency (`Today`, `Yesterday`, `Older`) with `New session` aligned to the first group heading.
- Session Rows show the Project tile and the title; the relative time appears on hover. No previews.

### 5.2 Settings

- Nav: `Back to app`, search, then groups separated by 16px: *Preferences, Appearance, Shortcuts* · *Workspace, Members* · *Providers, Models, API keys, Workers* · *About*. Icons are lucide in `text-muted-foreground`.
- Content: screen title + description, then sections. Each section is a Section heading followed by one Group list.
- Row anatomy: leading icon (16px) · title · optional Tag · optional description on a second line · trailing control (`Select`, `Switch`, `Button variant="outline" size="sm"`, or a `…` menu).
- Credentials MUST stay masked; Rows never show secret values (see `AGENTS.md`).

### 5.3 Session

- **Empty Session:** greeting, Composer, and Context bar vertically centered, max 640px wide. `SessionAmbient` MAY render behind it: a soft brand-tinted glow plus a masked dot field, drifting slowly. It is the only decorative element in the product and MUST unmount once the Session has a message.
- **Active Session:** messages in a 760px column; the Composer docks to the bottom. Going from empty to active moves the Composer through a shared `layoutId` (Reflow), not a fade.
- User turns use `Bubble variant="secondary" align="end"`. Assistant turns are unboxed text with `Trace` Steps above the answer.
- Approval gates, tool output (`TerminalLog`), and diffs (`CodeBlock`) render inline in the assistant turn.

## 6. Run state contract

All agentic components take `state: RunState` (`apps/web/src/components/agentic/agent-status.tsx`) and render it as `data-state`.

```ts
type RunState =
  | "idle" | "queued" | "thinking" | "streaming" | "executing"
  | "awaiting" | "succeeded" | "failed" | "cancelled";
```

| RunState | Signal token | Indicator |
| --- | --- | --- |
| `idle`, `queued`, `cancelled` | `signal-idle` | Still dot. |
| `thinking` | `signal-thinking` | Pulse + `shimmer` on the Step title. |
| `streaming`, `executing` | `signal-running` | Pulse; caret for streamed text. |
| `awaiting` | `signal-awaiting` | Pulse; the Approval gate is the only element that MAY use a colored border. |
| `succeeded` | `signal-success` | Still dot. |
| `failed` | `destructive` | Still dot. |

- Map backend status to `RunState` once, at the data boundary. Components MUST NOT derive status from booleans.
- Status MUST pair color with an icon or text label.
- Terminal states stop every Ambient loop on that element.

## 7. Motion (motion.dev)

### 7.1 Setup

- Library: **Motion for React**, package `motion`. `framer-motion` MUST NOT be added.
- `Providers` mounts `MotionProvider`: `LazyMotion features={domMax}` + `MotionConfig reducedMotion="user"`.
- Components use `import * as m from "motion/react-m"`. Helpers (`AnimatePresence`, `LayoutGroup`, `useReducedMotion`, `stagger`) come from `motion/react`.

### 7.2 Tokens

All timing comes from `lib/motion.tsx`; raw numbers in `transition` props are forbidden elsewhere.

| Token | Value | Use |
| --- | --- | --- |
| `duration.instant` | 0.08s | Hover and press feedback. |
| `duration.fast` | 0.15s | Exits, menus, icon swaps. |
| `duration.base` | 0.24s | Default enter. |
| `duration.slow` | 0.4s | Ceiling for any non-ambient animation. |
| `ease.out` / `ease.in` / `ease.inOut` | `[0.16,1,0.3,1]` / `[0.7,0,0.84,0]` / `[0.65,0,0.35,1]` | Enter / exit / on-screen move. |
| `spring.snap` | visualDuration 0.2, bounce 0 | Indicators, Tab open/close. |
| `spring.settle` | visualDuration 0.35, bounce 0.15 | Steps and messages entering. |
| `spring.layout` | visualDuration 0.4, bounce 0.1 | Composer dock, reorder. |
| `stagger.step` / `stagger.max` | 0.04s / 8 | Cascades; total ≤ 0.32s. |

### 7.3 Rules

- Animate `opacity`, `transform`, `filter: blur()` ≤ 4px, and `clip-path` only. Size and position changes use `layout`.
- Enter offsets: `y` ≤ 6px, `scale` ≥ 0.98. Exits use `transitions.exit` and never block input.
- **Instant:** switching Tabs, switching settings pages, opening Home, theme changes. These MUST NOT animate the Panel content.
- Content present at load (history, restored Tabs) renders with `initial={false}`. Only content arriving while the user watches animates.
- Ambient loops (pulse, shimmer, caret, Session glow) are CSS keyframes with a `motion-reduce:` fallback.

| Pattern | Trigger | Implementation |
| --- | --- | --- |
| **Tab open/close** | Tab added or removed | `AnimatePresence mode="popLayout"` + `layout`, `spring.snap`; siblings reflow. |
| **Reveal** | Step, message, or Row arrives | `variants.reveal`. |
| **Append** | Streamed line or token | Only the new item reveals; existing items never re-animate. |
| **Swap** | Approval gate → outcome | `AnimatePresence mode="popLayout"`, `variants.swap`. |
| **Reflow** | Composer docks, Rows reorder | Shared `layoutId` or `layout`, `transitions.layout`. |
| **Indicator** | Active segment changes inside one control | Shared `layoutId`, `spring.snap`. |
| **Pulse / Shimmer / Caret** | Active RunState | CSS, see §6. |
| **Ambient** | Empty Session only | `SessionAmbient`, CSS drift ≥ 12s per cycle. |

## 8. Components

- Base components: `@/components/ui` (shadcn/ui, `radix-rhea`). Chat parts from the shadcn registry: `message`, `bubble`, `trace`, `marker`, `code-block`, `attachment`, `message-scroller`, `questionnaire` (`bunx --bun shadcn@latest add @shadcn/<name>`).
- `src/components/ai-elements/` is legacy. Do not add imports where a registry equivalent exists; migrate a consumer when you touch it.
- After `shadcn add`, rewrite `import { cn } from "cn"` to `@/lib/utils` and remove the stray `cn` npm dependency some registry items add.
- Agentic primitives (`apps/web/src/components/agentic/`): `AgentStatus`, `StreamingText`, `TerminalLog`. Each sets `data-slot`, accepts `className`, and forwards props.
- Use variants for appearance; `className` is for layout.

## 9. Review checklist

1. The screen renders inside `data-design="harness"` and uses only semantic tokens.
2. No hero, eyebrow, tagline, stat strip, gradient, or added shadow on a product screen.
3. One screen title at `text-base`; lists use Group lists and Rows with the geometry in §3.4.
4. Machine text, and only Machine text, is mono.
5. Every status uses `RunState` and pairs color with a label or icon.
6. Every animation maps to a pattern in §7.3 and uses `lib/motion.tsx` tokens; navigation is instant.
7. Ambient loops stop on terminal states and under reduced motion; the glow exists only in the empty Session.
8. Light and dark checked; layout works at 360px width.
