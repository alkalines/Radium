# Worker Code Execution: Oh-My-Pi Eval Reference

## Status and scope

Oh-My-Pi calls its code-execution tool `eval`. This document records its
architecture as an implementation reference for Radium Worker, checked against
upstream `main` on 2026-10-07. **Radium has no implemented eval runtime or
agent-tool bridge.** This is research, not an additional package-adoption decision.

Unlike the native file editing and shell primitives, eval lives primarily in
upstream's TypeScript/Python coding-agent implementation. Installing
`@oh-my-pi/pi-natives` does not install the complete eval tool. See
[native tools](Native_Tools.md) and [Bash](Bash_Tool.md) for those boundaries.

## One tool call, one retained cell

The current input is an explicit language plus source:

```json
{
  "language": "js",
  "code": "const result = await tool.read({ path: 'package.json' }); display(result);",
  "title": "Read package configuration",
  "timeout": 30,
  "reset": false
}
```

Languages are `js` and `py`, filtered from the live tool schema when disabled.
Each call executes one cell. Subsequent cells reuse the selected runtime's
variables/imports. JavaScript and Python retain separate state; `reset: true`
recreates only the selected language runtime. Every agent session normally has
its own eval executor identity, including subagents.

This is not a sequence of fresh `python -c` or `bun -e` commands, and not a
model executing code inside Convex.

## Runtime architecture

```text
Eval tool / session lifecycle (TypeScript)
  ├── JavaScript executor → retained Bun subprocess / worker VM
  └── Python executor → retained python -u runner.py subprocess
          ↕ execution IPC and output/display frames
  Host tool dispatcher ← authenticated local tool bridge ← code helpers
          ↓
  registered tools, agent/completion handles, status and results
```

### JavaScript

Upstream uses a retained Bun-backed VM, in an isolated subprocess with a Bun
Worker fallback. If startup fails, it fails the call rather than executing model
code on the host thread. Async wrapping supports top-level `await` and bare
`return`; module loading handles static/dynamic imports and retained state.

The runtime exposes globals including `Bun`, `process`, `fetch`, `fs`, `Buffer`,
and module-loading helpers. Local file imports are cache-busted between cells,
while package imports retain cache identity. Synchronous code can block the
runtime's event loop, so cancellation may require terminating the worker.
Process separation is not a restricted filesystem/network sandbox.

### Python

The host launches a configured Python interpreter with a bundled `runner.py`:

```text
python -u runner.py
```

The runner speaks NDJSON over stdin/stdout, with request IDs and frames for
started, stdout, stderr, display, result, error, and done. It implements
IPython-style behavior itself; it does not require a Jupyter gateway or IPython
for the runner. Optional libraries still require installation.

It retains a user namespace and a persistent asyncio loop, supporting top-level
`await`. The default is session reuse; a per-call mode also exists. The host
reapplies the session cwd before each cell. Changes made before an exception can
remain in memory, so a failed cell is not a state rollback.

Cancellation first interrupts the subprocess with SIGINT. If it does not settle
within the escalation window, the host shuts it down and escalates termination;
the next call recreates the runtime. Current Python-specific documentation says
a cell that dies during execution is not replayed because completion is uncertain.
Interactive stdin is not supported: stdin is the execution control channel.

## Calling tools from code

Injected preludes provide `display`, file helpers, status helpers, and
`tool.<name>(args)`. A tool call from code crosses back to the host's registered
tool dispatcher rather than implementing another copy of the tool:

```text
cell: await tool.read({...})
  → local bridge request with session context and credentials
  → host validates/resolves the session tool
  → tool executes under that session's policy
  → structured result returns to the cell
```

Python receives local bridge URL/token/session context through managed
environment entries. Execution IPC and the callback bridge are different
channels. Upstream also supplies agent/completion handles, waiting, work pools,
and optional kernel-defined tools callable by subagents. These are agent-host
features, not native-addon exports.

Code can process tool results and choose what to display, avoiding a separate
model turn for each intermediate value. Code Mode can advertise selected tools
through generated JavaScript declarations instead of individual direct calls.
This is an additional tool transport, not a different model-routing engine.

In Radium, local execution tools would dispatch in Worker; any callback to
Chatroom-owned agent operations would need an explicit authorized transport.
Keep Gateway as the owner of model routing. Do not copy upstream's complete
agent orchestration or bypass Radium workspace/chat policies to add callbacks.

## Output and dependencies

The host captures stdout/stderr and rich `display()` values: JSON, images,
markdown, text, and status frames. Live output is coalesced, and oversized output
uses bounded previews plus artifacts. The tool returns execution status and
duration metadata alongside display results.

Standalone commands include `%load`, Python `%pip install`, JavaScript
`%bun add`, and JS managed/project environment selection. Python installs with
its kernel's interpreter. JS uses an upstream-managed project dependency
environment unless explicitly switched to the repository; lifecycle scripts
are disabled for those installs. Variables survive dependency installation,
but imported modules may remain cached. Python itself must be available or
provisioned; the native addon does not supply it.

## Timeouts, backgrounding, and disposal

The current cell timeout defaults to 30 seconds; zero disables it. The watchdog
pauses for selected host waits and package installs, then resumes with a fresh
window. Compute and ordinary tool calls count against the budget. Consequently,
this is not simply a fixed wall-clock timeout on the whole cell.

Optional auto-backgrounding uses the same agent async-job manager as Bash:
foreground wait, promote the still-running cell, return job ID/output preview,
then deliver completion later. Backgrounding does not re-execute the cell.
Dependent cells should await completion before using its mutations; foreground
exclusive scheduling alone is not a global runtime lock.

Runtimes survive calls until reset, owner disposal, or process exit. Shutdown
releases owner-scoped kernels and handles. Historical transcripts do not restore
live variable state after a fresh process starts.

## Radium implementation considerations

A complete Worker integration would need language runtime management, a
session-scoped namespace, execution IPC, tool callbacks, rich output/artifacts,
timeouts/cancellation, background delivery, and disposal/restart semantics.
Verify import/loading behavior, dependency environments, supported interpreters,
cross-session isolation, and uncertain completion without duplicate execution.

Keep this separate from adopting native edit/shell primitives. Reusing the full
Oh-My-Pi coding-agent SDK may be evaluated, but its exported integration surface,
agent ownership, and model/session lifecycle must be checked before choosing it.
These internals are not yet a verified standalone eval npm API for Radium.

## Upstream sources

- [Eval tool contract and runtime behavior](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/eval.md)
- [Eval tool orchestration](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/eval.ts)
- [Python runtime, protocol, and cancellation](https://github.com/can1357/oh-my-pi/blob/main/docs/python-repl.md)
- [JavaScript implementation](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/eval/js)
- [Python implementation](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/eval/py)
- [Eval agent callback bridge](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/eval/agent-bridge.ts)
