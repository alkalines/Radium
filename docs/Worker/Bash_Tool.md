# Worker Bash Tool: Oh-My-Pi Reference

## Status and responsibility

This is an implementation reference for a future Radium Worker Bash tool, based
on Oh-My-Pi's `main` source checked on 2026-10-07. **Bash execution, background
jobs, services, and interactive terminals are not implemented in Radium.**
Worker currently provides machine authentication and task status coordination.

The [native tools decision](Native_Tools.md) selects upstream's
`@oh-my-pi/pi-natives` package for file editing. The same package exports `Shell`
and `PtySession`, making it a candidate for Bash execution. Reusing these
primitives does not automatically adopt upstream's TypeScript job manager,
terminal UI, output artifacts, or tool policy. Validate the pinned published
package's declarations before implementing adapters.

Worker owns local processes and terminals. Convex owns authorization and durable
coordination; Chatroom owns conversation state, approvals, and presentation.
Use the planned [Convex transport](Convex_Transport.md) for commands and batched
output. Native shell execution belongs in Worker, not Convex functions.

## Upstream architecture

```text
Agent Bash tool (TypeScript)
  ├── local command → executeBash → native Shell → Rust pi-shell / brush-core
  ├── managed background job → session async job manager → executeBash
  ├── interactive command → native PtySession → terminal UI
  ├── named service → launch broker → supervised process/PTY
  └── editor terminal → ACP client terminal bridge
```

### Embedded shell and external processes

The ordinary local non-PTY path uses the native `Shell` class, backed by Rust
`pi-shell` and vendored `brush-core`. It parses shell syntax and runs supported
builtins/utilities in-process. External commands still spawn OS processes:
installing the addon does not supply every compiler, runtime, or project tool.
The default route is not a fresh `/bin/bash -c` process for every tool call.

Upstream's executor keeps `Shell` objects in a process-local map keyed by agent
session and shell configuration. State can survive successive calls. Explicit
cwd/env are supplied to runs; an adapter must define what persists rather than
assuming every shell or environment mutation becomes an agent-wide setting.

A retained shell runs one command at a time. When calls overlap on the same
session key, the first uses the persistent shell and the others use isolated
one-shot shells. This matters because aborting a native shell affects its
in-flight work. Broken sessions are removed/quarantined during cancellation
cleanup rather than immediately reused.

### Tool input and routing

The upstream tool accepts `command`, optional `cwd`, `timeout` in seconds,
`pty`, and dynamically enabled `async`, `name`, and readiness fields.

| Route | Selection and behavior |
| --- | --- |
| Local foreground | Default non-PTY path; stream output and return final status |
| Explicit async | `async: true` with async support; return a running job ID |
| Auto-background | Enabled non-PTY local call with available job capacity; wait, then promote |
| Interactive PTY | `pty: true` and available interactive UI; input/resize/kill |
| Named service | Service support and `name`; supervised lifetime and readiness |
| Client terminal | Editor advertises terminal capability; foreground non-PTY bridge |

The current ordinary command timeout defaults to 300 seconds; `timeout: 0`
disables its deadline. Nonzero deadlines are clamped by tool/global settings.
Changing a command to background does not disable its deadline. Named service
mode rejects `async` and a command `timeout`; readiness has a separate timeout.
These are upstream contracts, not Radium configuration defaults.

## Managed background jobs

### Explicit background execution

Upstream's Bash tool registers a job with the agent session's TypeScript async
job manager. The manager supplies a job-owned abort signal, progress callback,
owner identity, and process metadata. The job runs `executeBash` with a unique
session key containing the job ID and returns immediately to the caller:

```text
tool call → register/start job → return running job ID
                              └→ continue executing
                                 → collect progress/output
                                 → settle completed/failed/cancelled
                                 → deliver result to owning agent
```

The job's signal, not the initiating call's signal, owns ongoing execution. A
foreground caller returning must not cancel the job. Each job's shell is
isolated from other jobs, so cancelling one does not cancel another.

### Auto-backgrounding

Auto-backgrounding starts the same managed execution but initially treats it
as foreground: progress is forwarded and the job is hidden from background
listings/delivery. The tool races completion against a configured wait window
and incoming steering messages.

- If execution settles quickly, return its final result and release the
  foreground bookkeeping.
- If the wait expires, promote the existing job to background and return its
  ID plus current output preview.
- A queued steering message can trigger promotion early, allowing the agent
  to handle that message while the command continues.
- A caller abort during the foreground wait cancels that job.
- At job-manager capacity, run normally in the foreground instead.

**Promotion does not rerun the command.** PTY and editor-terminal routes do not
use this local auto-background path. The configurable wait threshold is distinct
from the command's deadline.

### Inspection, cancellation, and result delivery

Upstream's agent exposes:

- `read proc://` and `read proc://<id>` for visible jobs/status/output without
  consuming completion delivery.
- `write proc://<id>/kill` to cancel.
- `wait` when the agent has no independent work; settled results are also
  delivered through its async-result mechanism.

These URI conventions are agent-layer APIs, not exports of the npm addon.
Radium needs its own authorized job handles and delivery contract; Worker task
records are coordination state, not live process handles. See [Tasks](Tasks.md)
for the implemented boundary and cleanup behavior.

## Shell-level background children

`command &` and `nohup` are different from a managed `async: true` tool job.
Upstream explicitly handles the lifetime of shell objects that still own live
background children after a command returns.

The executor keeps those native Shell objects in a retained set and checks
`liveBackgroundJobCount()` every five seconds. Once no background children
remain, it releases the reference. This avoids dropping a per-job shell and
prematurely killing its children. Native children remain kill-on-drop: this is
not a detached, restart-persistent service mechanism. Retention is skipped when
the shell is being reset after cancellation/error.

## PTYs, services, and editor terminals

### Interactive PTY

The foreground interactive route creates a `PtySession` and starts the configured
host shell on a real pseudo-terminal with cwd, env, terminal dimensions, and
cancellation/deadline settings. Its UI forwards:

- Keyboard bytes → `PtySession.write`.
- Dimensions → `PtySession.resize`.
- Stop/escape → `PtySession.kill`.
- Output chunks → terminal renderer and a separate cleaned transcript sink.

Raw output retains ANSI control sequences for the terminal. The transcript/model
gets cleaned text and extracted graphics, not an unrestricted terminal byte
stream. Upstream's interactive route is exclusive because it takes over its TUI.
Managed async Bash jobs are not automatically interactive terminals.

### Named supervised services

Upstream routes a named service through its launch broker, with PTY enabled by
default and optional readiness checks on logs and TCP ports. Reusing a live
service name restarts it with the new specification. Status/logs are exposed
through `proc://`. Service supervision is separate from the embedded shell and
ordinary async jobs; adopting `PtySession` alone does not reproduce it.

### ACP terminal bridge

When an editor advertises terminal support, a foreground non-PTY call can use
the client's create/output/kill/release handles instead of the local shell.
Compound command text is wrapped in an explicit shell invocation because ACP
terminal creation takes an executable and argv, not an implicitly parsed shell
line. This does not describe Radium's implemented transport.

## Output, failure, and cleanup

The executor streams output through a bounded sink with throttled live previews
and optional artifact storage. Final results distinguish a normal zero exit,
nonzero exit, deadline expiry, user cancellation, and missing exit status.
Large output uses truncation metadata and artifact references where persistence
succeeds; artifact limits/failures must remain visible.

Cancellation combines native abort/deadline handling with host watchdog and
cleanup logic. Native runs that do not settle are quarantined so a broken shell
is not reused. A finished per-job shell is released unless it has live background
children. Session disposal releases retained session shells through the executor.

Do not equate this process-local state with durable recovery after Worker exit.
A Radium implementation must define terminal process cleanup, output retention,
and task reconciliation after disconnects and restarts.

## Radium implementation contract

The complete Worker adapter needs:

1. Session-scoped native shells and a Worker-owned job registry, with server-derived
   workspace/chat/task scope and stable task-to-local-handle correlation.
2. Explicit scheduling for persistent shells, concurrent jobs, and interactive
   terminals; per-job cancellation independent of tool-call delivery.
3. One execution for foreground-to-background promotion, separate runtime and
   readiness deadlines, and bounded job capacity.
4. Bounded batched output, local artifacts, final exit/error metadata, and a
   defined completion-delivery/reconnection contract over the planned transport.
5. Terminal input/resize/stop messages and Chatroom terminal presentation if PTY
   support is included; model transcript capture separate from raw terminal bytes.
6. Defined environment/cwd handling, process ownership, disposal, and restart
   reconciliation. Worker identity must be checked through the existing machine
   wrappers; executing a shell is not itself an isolation boundary.

Implement and document this alongside the
[Chatroom/Worker task](../tasks/06_Chatroom_Worker.md); importing the engine alone
does not complete that task.

## Verification for implementation

Exercise the actual native package on supported Worker platforms: pipelines,
redirection, builtin/external commands, cwd/env, streamed and oversized output,
nonzero exit, cancellation, timeout, concurrent shell calls, async completion,
auto-background promotion without duplicate execution, and child cleanup.
For terminals/services, verify input, resize, exit, readiness failures, disconnects,
and restart reconciliation. Test authorization and cross-session separation
through Radium's transport separately from native-engine behavior.

## Upstream sources

- [Bash tool routing and managed jobs](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/bash.ts)
- [Shell executor and lifetime handling](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/exec/bash-executor.ts)
- [Interactive PTY adapter](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/bash-interactive.ts)
- [Bash tool modes](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/bash.md)
- [Wait tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/wait.md)
- [Native npm distribution](https://github.com/can1357/oh-my-pi/blob/main/packages/natives/README.md)

For retained Python/JavaScript code execution rather than shell commands, see
[Eval tool reference](Eval_Tool.md).
