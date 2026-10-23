# Native AI Elements foundation

## Scope and ownership

The mobile app now contains native compositions for all 21 patterns listed in the [current shadcn AI Elements catalog](https://ui.shadcn.com/docs/ai-elements), checked on October 23, 2026. This targets the current Trace-based patterns, **not** compatibility wrappers for the former AI SDK Elements library. The new catalog publishes compositions, rather than a versioned package with a single public pattern API.

Pattern code lives in [`apps/mobile/src/components/ai-elements/`](../../apps/mobile/src/components/ai-elements/). Native supporting primitives live in [`apps/mobile/src/components/ui/`](../../apps/mobile/src/components/ui/), including Trace, Message, Bubble, Code Block, Marker, Input Group, Attachment, and Message Scroller. Existing Reusables Button, Text, Icon and Popover components are reused, along with maintained `@rn-primitives/collapsible` and `@rn-primitives/progress` rather than custom disclosure/overlay infrastructure. The starter app's title-based Collapsible remains unchanged.

All 21 patterns are composed in [`gallery.tsx`](../../apps/mobile/src/components/ai-elements/gallery.tsx): Chain of Thought, Chat, Checkpoint, Confirmation, Context, File Tree, Inline Citation, Message, Model Selector, Plan, Prompt Input, Queue, Reasoning, Sources, Stack Trace, Subagent, Suggestion, Task, Terminal, Test Results, and Tool. The development-only `/ai-elements` screen is protected by the existing authenticated-session navigator and uses local fixtures, not real agent execution.

No backend, model routing, credentials, approval authorization, Worker execution, or attachment upload has been wired. Screens retain ownership of those operations. An approval callback is not a substitute for server-side authorization, and a local document URI is not an upstream model attachment URL.

## Native adaptation boundary

The composition primitives retain their applicable shadcn feature props, such as `status`, `align`, `variant`, `size`, `open`, `defaultOpen`, `onOpenChange`, `keepMounted`, `wrap`, `lineNumbers`, `startLine`, and the Message Scroller provider options and imperative alignment options. Pattern-specific contracts are documented beside their exports; the gallery demonstrates their composition. These are **not** byte-for-byte DOM/Base UI prop types or legacy AI Elements drop-ins.

- Native elements accept `View`, `Text`, `Pressable`, `TextInput`, or `ScrollView` props, not HTML element attributes. Use `onPress` and `onChangeText`, and the existing Reusables `asChild` composition where supported, rather than DOM events or Base UI `render` callbacks.
- Hover previews become press-to-open Reusables popovers. Source links open HTTP(S) URLs in the system browser; file paths delegate to an explicit screen-owned callback.
- Return in the composer inserts a newline. Send and stop are explicit controls. Document Picker replaces hidden file inputs, drag/drop and browser file events. Selection limits are client feedback only; upload handlers must independently validate files.
- Running titles use a reduced-motion-aware native opacity animation rather than a CSS text gradient. Native Markdown also disables streaming animation when reduced motion is enabled.
- Code Block displays selectable literal output and diff lines; it does not execute code or supply the web Shiki `useHighlightedCode` hook.
- Native Message Scroller uses mounted row layouts and a `ScrollView`, not DOM observers. It supports follow-output, explicit jumps, short-turn anchor space, and reading-position preservation. It is not a virtualized large-history list. Native scrolling, dynamic heights, prepend preservation, accessibility announcements, and keyboard interactions still require device verification.

## Markdown and build setup

Native Markdown uses MIT-licensed `react-native-streamdown@0.3.0`, backed by `react-native-enriched-markdown`, `remend@1.3.0`, and the app's existing Worklets dependency. Web resolves a separate renderer using `streamdown`; browser code does not load the native Markdown module. These are local rendering dependencies, not required hosted services.

[`babel.config.js`](../../apps/mobile/babel.config.js) enables Worklets Bundle Mode and forwards `remend` imports. [`metro.config.js`](../../apps/mobile/metro.config.js) preserves Expo's resolver, watches generated worklet modules, and keeps Uniwind as the outermost wrapper with the existing 16px rem base. The Babel preset is declared directly in the mobile package.

Restart Metro with `bunx expo start --clear` from `apps/mobile` after updating dependencies/configuration. The native Markdown module needs a **new development build**; it is not available in Expo Go. No native project folders were generated and no EAS builds, updates, submissions, deployment changes, or publishing operations were run.

Upstream Bundle Mode documentation describes optional Metro patches for generated-module indexing and worklet Fast Refresh. They were not applied speculatively: this Expo SDK 58 setup's one-shot Android export succeeded without them. That verifies bundling, not worklet execution or native linking. Recheck [the current setup guide](https://docs.swmansion.com/react-native-worklets/docs/bundleMode/setup/) if runtime/build environments encounter generated-module indexing errors.

## Verification and remaining checks

- `bunx tsc --noEmit` in `apps/mobile`: passed.
- `bun run test:ai-elements` in `apps/mobile`: 12 composition/layout regression tests passed. Native hosts, Markdown, and disclosure primitives are mocked; this does not establish device behavior or real backend transport. The renderer emits its upstream deprecation notice.
- `bunx expo export --platform web --output-dir /tmp/opencode/radium-ai-elements-web`: passed.
- `bunx expo export --platform android --output-dir /tmp/opencode/radium-ai-elements-android`: passed. This is a JavaScript/Hermes bundle export, not an Android binary build.
- Final `bunx expo export --platform all --output-dir /tmp/opencode/radium-ai-elements-final`: passed for web, Android and iOS after the final code/configuration changes. This does not compile or link native binaries.
- Existing `node --test tests/auth.test.mjs` in `apps/mobile`: all 5 tests passed.
- Scoped `oxfmt` formatting was applied to the touched code.
- `bun run lint` in `apps/mobile`: blocked by the existing missing usable ESLint installation/configuration. Expo CLI reports that ESLint 8.57.0 or greater is required. No unrelated lint-tooling migration was made.

Before production use, verify the fixture gallery on an iOS and Android development build, including Markdown worklet execution, light/dark themes, long streamed replies, reader override of disclosure state, prepend/anchor scrolling, VoiceOver/TalkBack, popover placement, keyboard layout, clipboard denial, file-picker cancellation, and approval/submission failures. No real backend or native-device integration verification is claimed.
