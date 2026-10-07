# Worker Native Tools: Oh-My-Pi

## Decision and status

Use Oh-My-Pi's own `@oh-my-pi/pi-natives` npm package as the intended native
engine for Worker file editing, rather than implementing a reduced hashline
editor in TypeScript. Integrate the full read/edit lifecycle, snapshot state,
previews, application results, and stale-reference handling.

**Planned in Radium:** the dependency has not been installed, and no native tool
adapter or execution integration is implemented. Worker authentication and task
status coordination do not provide execution. See [Worker tasks](Tasks.md),
[transport](Convex_Transport.md), and the
[Chatroom/Worker handoff](../tasks/06_Chatroom_Worker.md).

Upstream observations below were checked against Oh-My-Pi's `main` source on
2026-10-07. They are not a guarantee that a particular published version has the
same API. Select and pin a published version and verify its declarations,
runtime requirements, and native artifacts before adoption.

## Package and distribution

Oh-My-Pi implements its editing engine in the Rust `pi-edit` crate and exposes
native functionality through N-API bindings in `pi-natives`. Its npm package
exports `EditSession`, `EditStore`, hashline formatting/hash helpers, and edit
description/grammar helpers. It also exports `Shell` and `PtySession` for command
execution and terminals. The package includes functionality beyond editing.

The published core package contains a JavaScript loader and TypeScript
declarations. Release publishing injects pinned platform packages as
`optionalDependencies`, such as `@oh-my-pi/pi-natives-linux-x64` and
`@oh-my-pi/pi-natives-darwin-arm64`. Each platform package declares its `os` and
`cpu` and carries the precompiled `.node` shared library. The package manager
installs the matching package; the loader chooses the native artifact, including
baseline/modern CPU variants on x64.

Users install one npm dependency, not a separate executable on `PATH`. Rust is
compiled by upstream during release; a supported prebuilt installation does not
require a local Rust toolchain. Unsupported targets, system-library requirements,
and installs that omit optional dependencies still need explicit verification.
The upstream source manifest currently requires Bun >= 1.3.14.

Proposed installation from the Radium repository root, when implementation begins:

```sh
bun add --cwd packages/worker @oh-my-pi/pi-natives
```

Pin the validated version for the integration. Import native code only in the
Worker, not in frontend bundles or Convex functions. Upstream is MIT licensed;
review its third-party notices and retain required attribution when distributing
native artifacts. Consuming this package does not require adopting the whole
Oh-My-Pi agent, its model routing, or its TUI.

## Full file editing integration

The original hashline article described content-hash anchors on individual
lines. Current upstream uses numbered lines and a four-hex file snapshot tag:

```text
*** Begin Patch
[src/hello.ts#1A2B]
PUT 2.=2:
+  return "hello";
*** End Patch
```

The grammar includes range replacement, before/after insertion, append,
cut/paste registers, syntax-block operations, file removal, and moves. The
snapshot tag uses XXHash32 truncated to 16 bits, with trailing spaces, tabs, and
CRs stripped per line. It is a compact snapshot reference, not a cryptographic
integrity or authorization mechanism. The engine retains bounded session-scoped
snapshots and supports displayed-line provenance, staging, previews, and
stale-snapshot recovery machinery.

The Worker adapter must:

- Keep native edit state scoped to the authorized execution/agent session and
  execution directory; never share snapshots across unrelated workspace sessions.
- Record snapshots and visible-line provenance through reads and searches, and
  return the engine's matching file headers and numbered content.
- Supply the model with instructions and grammar matching the pinned engine.
- Route edit requests through the native staging/application lifecycle and
  expose previews, diffs, results, and stale-reference context.
- Define disposal, restart behavior, and how file changes made by shell commands
  affect cached snapshots. Validate actual engine behavior rather than assuming
  a short tag alone prevents every stale edit.

Chatroom owns tool presentation and approvals. Convex owns authorization,
durable task coordination, and the planned output transport. Filesystem operations
and native execution remain local to Worker. Installing the engine does not
implement this surrounding lifecycle.

## How upstream implements Bash and background work

The [Bash tool reference](Bash_Tool.md) owns the detailed shell, managed-job,
PTY, service, output, and lifecycle explanation. `Shell` and `PtySession` are
native-package primitives; upstream's TypeScript agent layer owns background
registration, result delivery, and terminal presentation. Radium needs its own
Worker adapter and transport for that lifecycle.

The [eval tool reference](Eval_Tool.md) covers persistent Python/JavaScript code
execution and callbacks into agent tools. That stack lives in upstream's
coding-agent implementation, not in the native npm package; adopting it is a
separate decision.

## Acceptance checks for implementation

- Install and import the pinned package on each supported Worker platform;
  verify the project's Bun version and native system-library requirements.
- Exercise read/search to edit, replacement/insertion, cut/paste, syntax blocks,
  moves/deletes, stale files, and concurrent edits using the real native engine.
- Verify session/workspace separation, path policy, previews, application errors,
  and disposal/restart behavior through the Worker adapter.
- If adopting shell primitives, verify streaming, deadlines, cancellation,
  concurrent jobs, foreground-to-background promotion without re-execution,
  process cleanup, and PTY input/resize/exit handling.
- Verify Chatroom dispatch and output/approval transport separately from native
  engine tests. Native execution must not move into Convex.

## Upstream references

- [Native package architecture](https://github.com/can1357/oh-my-pi/blob/main/packages/natives/README.md)
- [Native export surface](https://github.com/can1357/oh-my-pi/blob/main/packages/natives/native/index.js)
- [Platform package generation](https://github.com/can1357/oh-my-pi/blob/main/packages/natives/scripts/gen-npm-packages.ts)
- [Rust edit engine](https://github.com/can1357/oh-my-pi/tree/main/crates/pi-edit)
- [Hashline instructions](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/edit/hashline-compact.md)
- [Snapshot store and hashing](https://github.com/can1357/oh-my-pi/blob/main/crates/pi-edit/src/store.rs)
- [Bash tool and background routing](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/bash.ts)
- [Shell executor and lifetime management](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/exec/bash-executor.ts)
- [Interactive PTY adapter](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/bash-interactive.ts)
- [Bash modes reference](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/bash.md)
- [Wait tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/wait.md)
