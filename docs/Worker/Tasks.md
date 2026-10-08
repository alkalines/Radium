# Worker Task Coordination

Status: **status persistence, cleanup, and edit-only dispatch/results implemented
and tested locally; Chatroom model-tool integration is implemented locally,
with deployed transport still unverified** (2026-10-07).

Worker tasks are short-lived handoff records assigned to one enrolled Worker in
one workspace. Chats retain conversation/tool-call history; tasks keep coordination
metadata. Edit tasks additionally carry bounded tool requests/results with the
same short retention; they are not durable conversation history.

## Entry Points And Authorization

- `packages/backend/src/worker/task-contract.ts`: validators, transitions and retention.
- `packages/backend/src/worker/edit-contract.ts`: edit requests, results and size bounds.
- `packages/worker/src/tasks.ts`: serialized consumption and result delivery.
- `packages/backend/src/worker/tasks.ts`: creation, machine reads/updates and cleanup.
- `packages/backend/convex/worker_tasks.ts`: thin registered Convex exports.
- `packages/backend/convex/schema.ts`: `worker_tasks` and indexes.
- `packages/backend/convex/crons.ts`: five-minute terminal-task cleanup.

`internal.worker_tasks.create` validates Better Auth, workspace ownership and an
active assigned Worker. Optional `chatId` requires current chat visibility and
matching workspace; owners cannot attach another user's personal chat. Optional
`toolCallId` requires a chat. Creation is internal-only, with no browser dispatch
endpoint or executable payload on this legacy metadata endpoint. The edit-only
`dispatchEdit` endpoint described below is separate.

`api.worker_tasks.assigned({ status })` returns up to **four** matching assignments
for the authenticated Worker, bounding payload reads. Optional `operation: "edit"`
uses the assignment index to isolate the edit queue. `updateStatus` checks the same
workspace/Worker scope and rejects executable edit tasks.
Both use `workerQuery` / `workerMutation` from `src/worker/machine.ts` to recheck
current workspace/key/epoch authority. Humans, foreign and revoked Workers cannot
use these machine endpoints.

## Status Lifecycle

The statuses are `sent`, `processing`, `failed`, `retrying`, `success`:

```text
sent -> processing -> success
            |-> failed -> retrying -> processing
            |-----------> retrying
```

Creation sets revision and attempt to zero. Every accepted change advances the
revision; entering `processing` increments the attempt. `failed` and `success`
set `terminalAt`; `retrying` clears it. Success is immutable. Failure can be
explicitly retried before cleanup.

Legacy metadata updates require `expectedRevision`. Repeating the immediately preceding update
is idempotent; stale revisions cannot finish a later attempt. These checks fence
status updates, not filesystem/process effects. Automatic retries, leases,
timeouts and cancellation remain planned. Other execution tools still need
their own idempotency, capabilities, and approvals.

`(workspace, workerId, requestId)` deduplicates dispatch while the task exists.
Different metadata with the same selector fails. After cleanup this receipt is
gone. Chatroom dispatch additionally uses durable `worker_chat_calls` stage receipts,
which preserve request identity and outputs across terminal-task cleanup.

## Cleanup

Every **five minutes**, the cron deletes `failed` and `success` records whose
terminal transition occurred **at least five minutes ago**. Age is measured from
`terminalAt`, not creation. The indexed transaction deletes at most 100 records
per terminal status; later ticks drain a backlog. Normally terminal records remain
five to ten minutes, depending on the next tick.

`sent`, `processing` and `retrying` records are retained. Stuck-task recovery is
future work. Cleanup touches only task records, preserving chats, tool-call history,
identities and credentials. Optional chat/tool-call links support correlation;
Chatroom outputs are also copied into durable stage receipts on completion. Edit request
and result fields are deleted with their terminal task.

## Edit Messaging And Execution

The owner-authenticated `api.worker_tasks.dispatchEdit` mutation accepts
`workspace`, `workerId`, a unique `requestId`, and `request`. The public request
must include `directory`, an absolute path on the target Worker, as well as its
runner session ID and action:

```ts
{
  directory: "/absolute/path/on/target-worker/project",
  sessionId: "agent-session",
  action: { kind: "read", path: "src/hello.ts" }
}
{
  directory: "/absolute/path/on/target-worker/project",
  sessionId: "agent-session",
  action: { kind: "preview", patch: "[src/hello.ts#1A2B]\nPUT 2.=2:\n+replacement\n*** End Patch" }
}
{
  directory: "/absolute/path/on/target-worker/project",
  sessionId: "agent-session",
  action: { kind: "apply", previewId: "<preview-id>" }
}
{
  directory: "/absolute/path/on/target-worker/project",
  sessionId: "agent-session",
  action: { kind: "close" }
}
```

Use a different request ID for each step. Requests are at most 32 KiB UTF-8;
session IDs are 1–128 ASCII letters, digits, underscores or hyphens. Optional chat
and tool-call links have the same visibility policy as metadata dispatch.
Dispatch goes through the owner-authorized backend mutation; the owner caller controls the target
Worker's directory through `request.directory`. Workspace members cannot dispatch
or read results. The directory is canonicalized on the Worker; no local directory
allowlist is part of this contract. Edit paths are confined to that selected
canonical directory.
`api.worker_tasks.outcome({ workspace, taskId })` reactively returns the record,
or null after cleanup, rechecking owner and private-chat visibility each time.
Tool outputs intentionally contain file content/diffs; they are not operational logs.
Reads optionally accept one-based `startLine` and `maxLines` (1–5,000), with
`nextLine` returned when a page is truncated. Hashline patches use tagged file
headers, with an optional Begin/End Patch envelope. Apply_patch instead uses
`*** Add File`, `*** Update File`, or `*** Delete File` headers.

`start` always consumes edit tasks; it does not select a directory through a CLI
option. The native package is loaded lazily when the Worker receives its first
valid backend-selected directory request. A stored task's `request.directory` is
optional only for legacy-record compatibility. Any older queued edit task without
that field fails with `DIRECTORY_REQUIRED`; the Worker never substitutes its
current working directory.

The Worker canonicalizes each selected directory and binds a live native session
to that canonical directory. Session identity is scoped by workspace, dispatching
owner, chat (or no chat), and runner session ID. A request that changes directories
within a live session fails with `SESSION_DIRECTORY_CHANGED`. Send `close` for the
currently bound directory to release the binding; reusing that session ID with a
new directory starts with fresh snapshots and previews. At most 64 live edit
sessions are retained across all directories. The native adapter owns snapshot
provenance and staged previews; see [native tools](Native_Tools.md).

`claimEdit` atomically changes `sent` to `processing`, storing a random
per-consumer claim token. A repeat with that token returns the same claim; another
connection receives null. The consumer serializes local execution. `completeEdit`
accepts only the assigned machine, matching claim token and revision, and an
identical completion retry is idempotent. Results contain either an output string
(at most 128 KiB UTF-8) or a bounded error code with optional native error output.
Native rejections produce failed tasks while retaining actionable stale-reference
context. The Worker retries result delivery
on reconnect/every five seconds, never the filesystem operation. It pauses further
work while a result receipt is undelivered. Neither inputs nor outputs are logged.
Graceful shutdown stops new claims, waits for in-flight local work, then makes a
best-effort completion flush with a two-second network deadline before disposal.

**Crash boundary:** there is no distributed filesystem transaction. A crash after
claim leaves `processing`; a crash after applying but before reporting leaves an
unknown outcome. Edit tasks cannot enter the generic retry path. Inspect the files
and issue a new read/preview/request ID deliberately. Restart discards native
snapshots/previews, so old preview IDs cannot be applied. An already-running local
operation cannot be rolled back by revocation or transport loss; new claims and
result writes recheck machine authority. Automatic recovery and cancellation
remain follow-up work. Chatroom model file tools, signed write
approvals, and durable stage receipts are documented in [Chatroom integration](Chatroom.md).

### Chatroom Dispatch

`internal.worker_tasks.dispatchChatEdit` accepts only server-derived session
identity and persisted chat selection. It rechecks owner and chat visibility,
the active Worker in that workspace, exact configured directory, enabled tool,
and stage/action compatibility. It derives the native session and write mode.
Apply must select a successful preview from that same tool call. Internal
`chatEditOutcome` uses the same authorization and reads durable receipts even
after the transient task is pruned. Chat deletion schedules `cleanupChatCalls`
in indexed batches. These internal paths are not browser or machine APIs.

Enrollment alone does not authorize a task: the owner-only backend dispatch selects
the directory and the machine claim authorizes its assigned task. Task claims do
not lock a filesystem against unrelated processes. No ACP agent is implemented by
this initial edit path.

## Reuse And Verification

The Convex Components catalog was queried but could not be read reliably. The
official [Workpool README](https://github.com/get-convex/workpool) was reviewed:
it schedules Convex actions/mutations, not external-machine assignments, and does
not replace this authorization/status contract. The catalog was retried during edit
implementation and timed out. The `convex-helpers` custom-function surface was
reviewed and existing session/owner and machine policies reused. No backend
infrastructure dependency was added.

```bash
bun run --cwd packages/backend test worker_tasks.test.ts workers.test.ts
bun run --cwd packages/worker test
```

Regressions cover assignment/owner/private-chat boundaries, idempotent dispatch,
stale transitions, retries, revocation, exact retention boundaries, bounded cleanup
and preserved chats. The additive table needs no existing-data backfill. No schema,
functions or cron configuration were deployed; scheduling starts after an authorized
deployment.
