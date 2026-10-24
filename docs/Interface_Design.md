# Radium Interface Design: Harness Surface Spec

Status: **v1, adopted for the whole web app.** Every screen renders on the harness surface; `/design` remains as the demo-data reference. Motion tokens: `apps/web/src/lib/motion.tsx`. Visual tokens: `:root` / `.dark` in `apps/web/src/styles/app.css`.

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** follow RFC 2119. A MUST rule is a review blocker. A deviation needs a `//` comment at the call site stating the reason.

Inspiration: the OpenCode desktop app (window chrome, session tabs) and Proton Lumo (empty-state composer). They informed the initial layout and density; Radium develops its own style from here. The Session screen sets that style, and Home and Settings reuse its surfaces (§5). Do not copy their branding, and treat the values below as Radium's starting tokens, not as a match target.

## 1. Design intent

Radium is a **tool, not a landing page**. The interface is a quiet desktop-style harness: dense, flat, neutral, and predictable. Content and agent output carry the visual weight; chrome recedes.

1. **Quiet by default.** Neutral grays, one accent, no gradients, no shadows, no decorative copy. The only expressive surface is the empty Session (§5.3).
2. **State is legible.** Which session is open, which Run is working, and what waits on the user are visible without reading prose.
3. **Motion is causal.** Animate only a state change or a direct input. Navigation between tabs and settings pages is instant.

Forbidden on product screens: hero sections, eyebrow labels (`01 / SECTION`), marketing taglines, stat strips, background grids behind content, glow outside the empty Session, and gradient text.

## 2. Vocabulary

Use these terms in component names, props, `data-*` attributes, docs, and reviews. Do not substitute synonyms.

| Term                            | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Window**                      | The full viewport. Background `--chrome`. Holds the Tab strip and one Panel.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Tab strip**                   | 44px row at the top of the Window: Home, Session Tabs, and New-tab on the left; the Workspace switcher and the User menu on the right. Home sits one Tab gap from the first Tab. There is no Settings button; Settings open from the User menu.                                                                                                                                                                                                                                                                    |
| **Tab**                         | One open Session. Open Tabs persist on the device: reopening the app restores them. The active Tab is a Connected tab. A Tab's icon is its Project tile; a Session without a Project shows the new-session icon, and a working Tab shows its RunState instead.                                                                                                                                                                                                                                                     |
| **Connected tab**               | Whatever owns the Panel (Home or the active Tab) drawn as part of it: `bg-background`, 10px top radius, 36px tall, flush with the Panel, with concave 8px corners curving into the Panel's top edge (`TabEars`). While Settings are open, no Tab strip item is connected.                                                                                                                                                                                                                                          |
| **User menu**                   | Avatar at the right end of the Tab strip: the Better Auth UI `UserButton` (`components/auth/user/user-button.tsx`, `size="icon"`). Shows the signed-in user and opens Settings, the theme picker, account switching when enabled, and Sign out. It does not switch workspaces. A Help entry is added once Radium has a help destination.                                                                                                                                                                       |
| **Workspace switcher**          | Menu that changes the current workspace, rendered by the shared `WorkspaceSwitcher` (`components/workspaces/workspace-switcher.tsx`). In the Tab strip it is a flat Chip (workspace tile, name; no chevron) directly before the User menu. In the Settings sidebar it is the workspace section heading itself: the workspace name and a chevron in heading style, with no tile, Tag, or Row surface. Both list every workspace with its role and link to workspace management.                                  |
| **Home**                        | The home screen, opened by the Home button in the Tab strip. It is not a Tab. v1 contents: side column (search, Projects) and the session list of the current workspace.                                                                                                                                                                                                                                                                                                                                           |
| **Panel**                       | The inset content surface below the Tab strip: `bg-background`, no border, 10px radius, 8px gap to the Window side and bottom edges. Exactly one per Window. It has no border so the Connected tab reads as one surface with it.                                                                                                                                                                                                                                                                                   |
| **Session**                     | One conversation with agents. Belongs to a workspace and, in future, a Project.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Project**                     | A folder grouping Sessions (planned; UI slots exist, behavior is not implemented).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Group list**                  | A `bg-card` block of rows shaped like the Composer (`rounded-2xl`), with a Hairline border and Hairline dividers between Rows. The standard container for settings and entity lists. The Home session list is not a Group list (§5.1).                                                                                                                                                                                                                                                                             |
| **Row**                         | One entity in a Group list or session list: 40–56px tall, title + optional Tag + trailing controls.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Tag**                         | Inline 11px label with 2px radius describing a Row (`API key`, `Account`, `Planned`).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Composer**                    | The prompt input: text area plus a toolbar (attach on the leading end; the Model control and send at the trailing end). The Session context sits directly below it.                                                                                                                                                                                                                                                                                                                                                |
| **Model control**               | One Composer trigger showing the model name and its reasoning level (`Claude Opus 5.5 Medium`), kept from the Chatroom prompt input. It opens a searchable picker: rows show the lab logo, `Lab: Model`, and the logos of providers that can serve it; the footer picks the inference provider and the reasoning amount (plus a token budget when the model accepts one). Changing the model keeps the provider and effort valid for it.                                                                           |
| **Session context**             | One centered line under the Composer: `Project · Worker (Agent)` / branch. The first part opens the Run target picker. Workers have no profiles; each connects once and runs as one OS user. Worker names are Inter, not Machine text; the branch is Machine text and truncates (full name in `title`). Until Projects and branches ship, the line shows the Worker (or `No Worker`) and the branch chip stays hidden (`SessionBranch` renders nothing without a branch). Members, who cannot pick Workers, see a plain label. |
| **Run target picker**           | Popover (opens upward, 320px) that stays short however many Workers a workspace has: a summary of rows (Project, Worker, Directory, Tools, Agent with their current values) drills into one searchable list per part, capped at 256px and scrolling. Project is a disabled `Planned` row until Projects ship. Workers list the workspace's active identities (Worker metadata has no online flag or OS username, so neither is shown); Directory is the absolute path on that Worker; Tools are the Worker tools the agent may call (Edit, Create, and Bash need approval). Picking returns to the summary; Backspace in an empty search steps back; closing resets to the summary. View switches are instant. |
| **Agent**                       | The harness that runs the Session: the built-in Radium agent (default; not shown in the Session context) or an external harness over ACP (Agent Client Protocol) installed on the chosen Worker, shown by name only in parentheses (`Worker (Claude Code)`); logos appear only inside the Run target picker. Changing the Worker falls back to the built-in agent when the chosen ACP agent is not installed there. ACP support is planned: `components/session/agents.ts` documents the integration and today offers only the built-in agent. |
| **Chip**                        | A compact ghost selector or label (`Button variant="ghost" size="xs"`, muted text), such as the Session context items and the Tab strip Workspace switcher.                                                                                                                                                                                                                                                                                                                                                        |
| **Run**, **Step**, **RunState** | Agent execution, its units, and their lifecycle (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Machine text**                | Code, commands, file paths, branch names, model IDs, and keyboard shortcuts.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Hairline**                    | 1px border using `border-border`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Motion token**                | A named duration, easing, spring, or stagger from `lib/motion.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 3. Visual tokens

### 3.1 Scope and source

- Harness tokens are defined in `:root` and `.dark` in `app.css`. They override the shadcn variables (`--background`, `--card`, `--muted`, `--border`, `--primary`, `--radius`, …), so shadcn components, Better Auth UI, and portaled menus restyle without per-component overrides.
- Components MUST use semantic utilities (`bg-card`, `text-muted-foreground`, `border-border`). Hex, oklch, or palette classes (`bg-zinc-900`) in components are forbidden.

### 3.2 Surfaces (dark)

| Token                 | Value                   | Use                                                               |
| --------------------- | ----------------------- | ----------------------------------------------------------------- |
| `--chrome`            | `#080808`               | Window background, Tab strip.                                     |
| `--background`        | `#161616`               | Panel.                                                            |
| `--card`              | `#222222`               | Group list, Composer.                                             |
| `--accent`            | `#2c2c2c`               | Hover and selected Row, active nav item, active Tab.              |
| `--muted`             | `#1c1c1c`               | Code blocks, terminal output.                                     |
| `--tag`               | `#2e2e2e`               | Tag background.                                                   |
| `--border`            | `rgb(255 255 255 / 8%)` | Hairlines.                                                        |
| `--foreground`        | `#ededed`               | Titles and body.                                                  |
| `--muted-foreground`  | `#a0a0a0`               | Secondary text, descriptions.                                     |
| `--subtle-foreground` | `#707070`               | Group headings (`Today`), placeholders, inactive Tab titles.      |
| `--primary`           | `#ededed`               | Primary button (near-white on dark). Not a brand color.           |
| `--brand`             | Radium orange           | Project tile and the empty Session glow. Never buttons or status. |

Surfaces stack at most three deep: `--chrome` → `--background` → `--card`. Elevation is expressed by these steps only; `shadow-*` utilities MUST NOT be added on Harness screens (shadcn's own popover shadows are acceptable).

### 3.3 Typography

| Role                             | Spec                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                             | Inter Variable, `text-sm` (14px). Dense lists MAY use `text-[13px]`.                                                                                |
| Screen title                     | `text-base font-medium`. One per screen. No serif, nothing above `text-base` on product screens; the empty Session's wordmark is artwork, not type. |
| Section heading                  | `text-sm font-medium`.                                                                                                                              |
| Group heading (`Today`, `Older`) | `text-sm text-subtle-foreground`.                                                                                                                   |
| Description                      | `text-sm text-muted-foreground`.                                                                                                                    |
| Tag                              | `text-[11px] font-medium`, 2px radius, `bg-tag`, Hairline.                                                                                          |
| Machine text                     | `font-mono text-[13px]` (JetBrains Mono), only for the values listed in §2. Labels, statuses, and numbers in prose stay in Inter.                   |
| Empty Session wordmark           | `RadiumWordmark` (`components/agentic/radium-wordmark.tsx`), 56–64px tall, inside the screen's `h1`. It replaces a text greeting.                   |

- Live-updating numbers MUST use `tabular-nums`.
- Truncate long titles with `truncate`; expose the full value in a `Tooltip` or `title`.

### 3.4 Geometry

| Element                        | Radius                          | Height             |
| ------------------------------ | ------------------------------- | ------------------ |
| Panel                          | 10px (`rounded-[10px]`)         | —                  |
| Group list                     | `rounded-2xl`, same as Composer | Rows 40–56px       |
| Connected tab                  | 10px top (`rounded-t-[10px]`)   | 36px               |
| Menu item                      | 6px (`rounded-md`)              | 28–32px            |
| Side-column item, small search | `rounded-xl`                    | 32px               |
| Chip                           | from `--radius`                 | 24px (`size="xs"`) |
| Buttons, inputs                | from `--radius` (6px base)      | 28–32px            |
| Tag                            | 2px (`rounded-[2px]`)           | 16px               |
| Composer                       | 16px (`rounded-2xl`)            | ≥ 96px             |

- Content columns: settings content 760px max; conversation 760px max.
- Home and Settings use a 240px side column + content, centered in the Panel (max 1040px) with 48px top padding. The side column holds navigation and a small search field (32px), never a large one.

## 4. Layout model

```
Window (--chrome)
├─ Tab strip (44px)  [Home] [Tab ×] [Tab ×] … [+]          [▣ workspace] (User)
└─ Panel (--background, 10px radius, 8px inset)
   └─ Screen: Home | Session | Settings
```

- The Window MUST NOT have a persistent sidebar. Navigation lives in the Tab strip, Home, and Settings; screen-level side columns (Home, Settings) are part of the screen, not the Window.
- At most one Tab strip item is a Connected tab: Home or the active Tab; none while Settings are open. Inactive Tabs are plain text on `--chrome`. Home sits flush with the Panel's left edge (8px strip padding): as a Connected tab it has no left ear, and the Panel squares its top-left corner, so Home's side continues the Panel's side.
- The current workspace is Window state: the Workspace switcher (Tab strip or Settings heading) changes it, and Home, the Session context, and Settings all show it. It persists on the device (`WorkspaceProvider`).
- The URL decides which screen owns the Panel (route `staticData.screen`): `/` is Home, `/chat?draft=<tab>` is a `New session` draft Tab, `/chat/$chatId` is a session Tab, and the Settings routes (`/settings/*`, `/gateway/*`, `/chatroom/*`) render inside the Settings sidebar. Signed-out screens (`/auth/*`) and `/design` are `shell: "bare"` and skip the Window.
- The Window (`components/window/harness-window.tsx`) keeps every open Tab's Session mounted, hidden when inactive, so a stream keeps running while another Tab or screen is shown; the chat routes render nothing themselves.
- Opening a Session (from Home, a fork, or a link) is navigation to `/chat/$chatId`: it focuses its Tab if one is open, otherwise appends a Tab and focuses it. Sending the first message of a draft keeps its Tab and moves the URL to the new chat.
- Closing the active Tab focuses its right neighbor, else the left one, else Home.
- `+` creates an empty Session Tab (`New session`).
- Open Tabs MUST persist in `localStorage` (versioned key, every read and write wrapped in `try/catch`; `components/window/window-tabs.ts`). Tabs are client UI state, so they MUST NOT be stored in Convex. A Tab stores only IDs and display hints; session content is always loaded from the backend, and a Tab whose session no longer exists or is no longer accessible is dropped.
- Settings open from the User menu and replace the Panel content with their own nav. `Back to app` returns to the previously focused Tab or Home.

## 5. Screens

Every screen reuses the Session's surfaces: settings lists sit in Composer-shaped Group lists (`rounded-2xl`, `bg-card`, Hairline border), and interactive items use the same rounded, neutral treatment (`rounded-xl` items, `bg-accent` for selection).

### 5.1 Home

- Side column (240px): `New session` (a side-column item, level with the first group heading), a small search field (`Search <workspace>`, 32px), then the `Projects` heading with a new-folder icon button and the Project list. Until Projects ship, the new-folder button is disabled and its Tooltip says `Projects are planned`.
- Content: sessions of the current workspace grouped as `Pinned`, then by recency (`Today`, `Yesterday`, `Older`), each a Group heading followed by its Rows directly on the Panel: no card, border, or dividers. A Row is a `rounded-xl` side-column-style item that gets `bg-accent` only on hover or while its menu is open.
- Session Rows show the Project tile (until Projects ship: the chat emoji, or a RunState while it streams), the title, and the relative time (always visible, `tabular-nums`). For sessions the user can manage, a `…` menu (Pin, Rename, Regenerate title, Move to project — planned, Delete) appears after the time on hover or keyboard focus and stays visible while open; it never opens the session.
- Settings and Help are not on Home; they live in the User menu.

### 5.2 Settings

- Sidebar (240px): `Back to app`, small search field, then two sections. **Account** (_Account, Security_, plus Better Auth UI plugin pages) follows the user and renders Better Auth UI views. The workspace section's heading is the Workspace switcher (`<workspace> ⌄`) and lists the workspace pages (_General, Providers, Credentials, API keys, Workers, Chat defaults, Tools, Activity, Logs, Telemetry_). Icons are lucide in `text-muted-foreground`. Wide data pages (Activity, Logs, Telemetry) MAY exceed the 760px content column.
- Workspace pages MUST name their workspace in the screen title (`<tile> workspace / Page`, `WorkspacePageHeader`). For a workspace where the user is a Member, workspace pages stay readable where the backend allows it, drop editing controls, and say that only owners can change them (`docs/Radium_Gateway/Ownership.md`).
- Content: screen title + description, then sections. Each section is a Section heading followed by one Group list. Headings indent to the Row content (`px-4`).
- Row anatomy: leading icon (16px) · title · optional Tag · optional description on a second line · trailing control (`Select`, `Switch`, `Button variant="outline" size="sm"`, or a `…` menu).
- Credentials MUST stay masked; Rows never show secret values (see `AGENTS.md`).

### 5.3 Session

- **Empty Session:** the Radium wordmark, Composer, and Session context vertically centered, max 640px wide. No text greeting. `SessionAmbient` MAY render behind it: a soft brand-tinted glow plus a masked dot field, drifting slowly. The glow and the wordmark are the only decorative elements in the product and MUST unmount once the Session has a message.
- **Wordmark motion:** on mount the letters drop in with a cascade and a brand-colored charge that cools to the foreground; afterwards each letter lifts and crossfades to `--brand` as the cursor approaches (solid per-letter fills, never gradient text). This boot is the one exception to `initial={false}` for content present at load. Under reduced motion the wordmark is static and attaches no pointer listener.
- **Active Session:** messages in a 760px column; the Composer and Session context dock to the bottom. Going from empty to active moves the Composer through a shared `layoutId` (Reflow), not a fade, and keeps it mounted so the model choice survives.
- User turns use `Bubble variant="secondary" align="end"`. Assistant turns are unboxed text with `Trace` Steps above the answer.
- Approval gates, tool output (`TerminalLog`), and diffs (`CodeBlock`) render inline in the assistant turn.
- **Run target after the first message:** the spec fixes the Session context once the agent process lives on a Worker (ACP). The built-in agent runs in Convex and only calls Worker tools, so for it the Worker, Directory, and Tools stay editable by whoever can manage the chat; the row locks once an ACP agent is chosen.

## 6. Run state contract

All agentic components take `state: RunState` (`apps/web/src/components/agentic/agent-status.tsx`) and render it as `data-state`.

```ts
type RunState =
  | "idle"
  | "queued"
  | "thinking"
  | "streaming"
  | "executing"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "cancelled";
```

| RunState                      | Signal token      | Indicator                                                                   |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `idle`, `queued`, `cancelled` | `signal-idle`     | Still dot.                                                                  |
| `thinking`                    | `signal-thinking` | Pulse + `shimmer` on the Step title.                                        |
| `streaming`, `executing`      | `signal-running`  | Pulse; caret for streamed text.                                             |
| `awaiting`                    | `signal-awaiting` | Pulse; the Approval gate is the only element that MAY use a colored border. |
| `succeeded`                   | `signal-success`  | Still dot.                                                                  |
| `failed`                      | `destructive`     | Still dot.                                                                  |

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

| Token                                 | Value                                                   | Use                                    |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| `duration.instant`                    | 0.08s                                                   | Hover and press feedback.              |
| `duration.fast`                       | 0.15s                                                   | Exits, menus, icon swaps.              |
| `duration.base`                       | 0.24s                                                   | Default enter.                         |
| `duration.slow`                       | 0.4s                                                    | Ceiling for any non-ambient animation. |
| `ease.out` / `ease.in` / `ease.inOut` | `[0.16,1,0.3,1]` / `[0.7,0,0.84,0]` / `[0.65,0,0.35,1]` | Enter / exit / on-screen move.         |
| `spring.snap`                         | visualDuration 0.2, bounce 0                            | Indicators, Tab open/close.            |
| `spring.settle`                       | visualDuration 0.35, bounce 0.15                        | Steps and messages entering.           |
| `spring.layout`                       | visualDuration 0.4, bounce 0.1                          | Composer dock, reorder.                |
| `stagger.step` / `stagger.max`        | 0.04s / 8                                               | Cascades; total ≤ 0.32s.               |

### 7.3 Rules

- Animate `opacity`, `transform`, `filter: blur()` ≤ 4px, and `clip-path` only. Size and position changes use `layout`.
- Enter offsets: `y` ≤ 6px, `scale` ≥ 0.98. Exits use `transitions.exit` and never block input.
- **Instant:** switching Tabs, switching settings pages, opening Home, theme changes. These MUST NOT animate the Panel content.
- Content present at load (history, restored Tabs) renders with `initial={false}`. Only content arriving while the user watches animates. The empty Session wordmark's boot is the only exception (§5.3).
- Ambient loops (pulse, shimmer, caret, Session glow) are CSS keyframes with a `motion-reduce:` fallback.

| Pattern                     | Trigger                                   | Implementation                                                                                                              |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Tab open/close**          | Tab added or removed                      | `AnimatePresence mode="popLayout"` + `layout`, `spring.snap`; siblings reflow.                                              |
| **Reveal**                  | Step, message, or Row arrives             | `variants.reveal`.                                                                                                          |
| **Append**                  | Streamed line or token                    | Only the new item reveals; existing items never re-animate.                                                                 |
| **Swap**                    | Approval gate → outcome                   | `AnimatePresence mode="popLayout"`, `variants.swap`.                                                                        |
| **Reflow**                  | Composer docks, Rows reorder              | Shared `layoutId` or `layout`, `transitions.layout`.                                                                        |
| **Indicator**               | Active segment changes inside one control | Shared `layoutId`, `spring.snap`.                                                                                           |
| **Pulse / Shimmer / Caret** | Active RunState                           | CSS, see §6.                                                                                                                |
| **Ambient**                 | Empty Session only                        | `SessionAmbient`, CSS drift ≥ 12s per cycle.                                                                                |
| **Wordmark**                | Empty Session mount; cursor proximity     | `RadiumWordmark`: `cascadeDelay` + `spring.settle` boot, `transitions.enter` charge fade, `spring.snap`-smoothed proximity. |

## 8. Components

- Base components: `@/components/ui` (shadcn/ui, `radix-rhea`). Chat parts from the shadcn registry: `message`, `bubble`, `trace`, `marker`, `code-block`, `attachment`, `message-scroller`, `questionnaire` (`bunx --bun shadcn@latest add @shadcn/<name>`).
- AI Elements patterns (`https://ui.shadcn.com/docs/ai-elements`) are composed from those parts in the app's own components; the legacy AI SDK Elements copies (`components/ai-elements/`) are removed. Do not reinstall them.
- Harness layout primitives (`apps/web/src/components/harness/`): `ProjectTile`, `GroupList` / `Row` / `RowBlock` / `Tag`, `PageHeader`, `SideColumnLayout` / `SideColumnItem` / `SideColumnSearch` / `SideColumnSection`, `StripTab` / `TabEars`. Workspace Settings pages use `WorkspacePageHeader` (`components/settings/`). Model pickers use `ModelList` (`components/models/`). Build new screens from these instead of restyling raw markup.
- After `shadcn add`, rewrite `import { cn } from "cn"` to `@/lib/utils` and remove the stray `cn` npm dependency some registry items add.
- Agentic primitives (`apps/web/src/components/agentic/`): `AgentStatus`, `StreamingText`, `TerminalLog`. Each sets `data-slot`, accepts `className`, and forwards props.
- Use variants for appearance; `className` is for layout.

## 9. Review checklist

1. The screen renders inside the harness Window (or is a documented `bare` route) and uses only semantic tokens.
2. No hero, eyebrow, tagline, stat strip, gradient, or added shadow on a product screen.
3. One screen title at `text-base`; lists use Group lists and Rows with the geometry in §3.4.
4. Machine text, and only Machine text, is mono.
5. Every status uses `RunState` and pairs color with a label or icon.
6. Every animation maps to a pattern in §7.3 and uses `lib/motion.tsx` tokens; navigation is instant.
7. Ambient loops stop on terminal states and under reduced motion; the glow exists only in the empty Session.
8. Light and dark checked; layout works at 360px width.
