# Worker Native Tools: Oh-My-Pi

## Decision and status

Radium uses Oh-My-Pi's own `@oh-my-pi/pi-natives` npm package as the native
engine for Worker file editing. The Worker adapter owns filesystem policy and the
read/preview/apply lifecycle; it does not reimplement hashline parsing or editing.

**Implemented locally (2026-10-07):** pinned `@oh-my-pi/pi-natives@18.8.3`, native
snapshot/provenance reads, staged previews, single-use application, and authorized
edit task messaging. The actual native build reports `18.8.3` and was exercised on
Linux x64 with Bun 1.4.2. Chatroom model-tool dispatch and approval UI, deployed
transport verification, search adapters, and additional tools remain follow-up
work. See [Worker tasks](Tasks.md), [transport](Convex_Transport.md), and the
[Chatroom/Worker handoff](../tasks/06_Chatroom_Worker.md).

Upstream observations below were checked against Oh-My-Pi's `main` source on
2026-10-07. They are not a guarantee that a particular published version has the
same API. The installed 18.8.3 declarations and Linux x64 native artifact were
checked for this integration; recheck them when updating the pin.

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

The dependency and platform-package pins are checked into `bun.lock`. Install from
the Radium repository root:

```sh
bun install --frozen-lockfile
```

Import native code only in the
Worker, not in frontend bundles or Convex functions. Upstream is MIT licensed;
review its third-party notices and retain required attribution when distributing
native artifacts. Consuming this package does not require adopting the whole
Oh-My-Pi agent, its model routing, or its TUI.

## Implemented Worker Adapter

- `packages/worker/src/edit/index.ts` exports `WorkerEditService`.
- `service.ts` owns native stores, read provenance, previews, result serialization,
  and the host writer; `path-policy.ts` owns local root/path checks.
- `directories.ts` binds backend-selected directories to sessions, loads native
  services lazily, and enforces the aggregate session/preview-memory budget.
- `packages/worker/src/tasks.ts` consumes owner-dispatched assignments through the
  same machine-authenticated Convex client. Inputs/results live in short-lived
  task records, not logs. The [task guide](Tasks.md#edit-messaging-and-execution)
  owns authorization, exact endpoints, size limits and recovery behavior.

Start an enrolled Worker normally; it consumes edit tasks without a directory
option:

```bash
bun run --cwd packages/worker start
```

Startup always runs the identity/control path and consumes assigned edit tasks.
The native service is loaded lazily on the first valid request whose backend-supplied
`directory` is an absolute path on this Worker. The directory router canonicalizes
that existing directory and confines edit paths to it; the backend's
owner-authorized dispatch caller selects the directory. No local directory
allowlist is required. Each native session has its own `EditStore` and is keyed by
workspace, dispatching owner, chat and runner session ID, with a binding to its
canonical directory. Changing directories within an active session fails with
`SESSION_DIRECTORY_CHANGED`. Close the session with its bound directory to release
that binding; a new directory under the same session ID starts with fresh snapshots.
Service requests are serialized, including requests from different sessions.

Stored legacy tasks may lack `request.directory`; the Worker fails those tasks with
`DIRECTORY_REQUIRED` without falling back to its current working directory. The
public `dispatchEdit` request always requires the directory field.

1. **Read:** return the matching native file header, numbered text, and the pinned
   engine's instructions/grammars. Record only displayed lines as seen. Optional
   `startLine` (one-based) and `maxLines` (1–5,000) allow paged reads; a truncated
   response includes `nextLine`. Pages are capped at 48 KiB of formatted content.
2. **Preview:** inspect every authored source/destination path before entering the
   native lifecycle. Native `EditSession.apply` uses an in-memory host writer:
   it computes edits/diffs and updates native state without touching disk. Restore
   actual filesystem snapshots after staging. Return a preview ID, diffs, warnings,
   diagnostics, and native rejection/stale-reference text.
   Each session has one pending preview: apply it or close the session before
   staging another edit. The published native API exposes no store clone or
   clipboard rollback, so this admission rule fences scratch-register changes
   made during native staging. Expiration and failed staging/application clear
   native scratch state; re-read before preparing the next edit.
3. **Apply:** consume the preview ID once, recheck complete UTF-8 file preimages and
   expected-absent destinations, and apply the staged host writes. Revalidate paths
   at admission and before writes. Return outcomes and applied paths; failures
   report potential partial application. A consumed or expired preview is never
   replayed, even if the backend task receipt has already been cleaned up.
4. **Close/restart:** dispose snapshots and pending previews. Restart cannot recover
   native session state or reuse old preview IDs.

When supplied, `writeMode: "edit"` permits only native `update` writes, while
`writeMode: "create"` permits only `create` writes. Deletes, moves, incompatible
operations in mixed patches, and applying a constrained preview with a different
mode are rejected with `WRITE_MODE_DENIED`; the complete staged batch is rechecked
before any disk write. Requests omitting `writeMode` retain the legacy native
behavior.

Hashline is the default; its patch uses tagged file headers, optionally wrapped
in `*** Begin Patch` / `*** End Patch` as in the exported grammar. An envelope with
`*** Add File`, `*** Update File`, or `*** Delete File` headers selects the native
**apply_patch** format, including file creation. Use the grammar returned by reads/previews rather than mixing the
two envelopes. Real-engine regressions exercise syntax-block replacement and named
cut/paste registers across calls, as well as range replacement/insertion, moves,
deletes, file creation, stale recovery and session separation.

## Bounds And Known Limitations

- UTF-8 text files up to 4 MiB are supported; binary/non-UTF-8 files are rejected.
  UTF-8 BOMs are preserved. A single line exceeding the read page budget returns
  `READ_LINE_TOO_LARGE`. Tool responses are at most 128 KiB.
- At most 64 live edit sessions across all directories and one preview per session
  are retained. A failed initial request releases its session slot. Staged writes
  and preimages have an 8 MiB per-preview and 32 MiB service-wide budget. Preview
  TTL is ten minutes; expiration is checked on subsequent requests. Close unused
  sessions explicitly; there is no idle session eviction.
- Root traversal, root replacement with an external symlink, and existing symlink
  escapes are rejected for reads, updates, creates, deletes and both move ends.
  Path-based checks are not an OS sandbox: an adversarial local process racing
  symlink changes between checks/syscalls remains a TOCTOU limitation.
- Multi-file writes are **not transactional**. An I/O failure after earlier writes
  can leave partial application; inspect the returned applied paths and actual
  files before preparing a new edit. Moves preserve ordinary POSIX permission bits
  subject to the host's umask; full file metadata/ACL preservation is not implemented.
- Only Linux x64 native runtime behavior was exercised. Other platform artifacts,
  system-library requirements and distribution/container paths remain unverified.

Verification uses Vitest for auth/control/consumer tests and Bun for the real native
engine, matching the Worker host:

```bash
bun run --cwd packages/worker test
bun run --cwd packages/worker test:unit tasks.test.ts
bun run --cwd packages/worker test:edit
```

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
