# Worker Task Coordination

Status: **status persistence and cleanup implemented locally; execution and
Chatroom dispatch integration remain planned** (2026-10-06).

Worker tasks are short-lived handoff records assigned to one enrolled Worker in
one workspace. Chats retain conversation/tool-call history; tasks keep coordination
metadata rather than another transcript or execution log.

## Entry Points And Authorization

- `packages/backend/src/worker/task-contract.ts`: validators, transitions and retention.
- `packages/backend/src/worker/tasks.ts`: creation, machine reads/updates and cleanup.
- `packages/backend/convex/worker_tasks.ts`: thin registered Convex exports.
- `packages/backend/convex/schema.ts`: `worker_tasks` and indexes.
- `packages/backend/convex/crons.ts`: five-minute terminal-task cleanup.

`internal.worker_tasks.create` validates Better Auth, workspace ownership and an
active assigned Worker. Optional `chatId` requires current chat visibility and
matching workspace; owners cannot attach another user's personal chat. Optional
`toolCallId` requires a chat. Creation is internal-only, with no browser dispatch
endpoint or executable payload in this slice.

`api.worker_tasks.assigned({ status })` returns up to 100 matching assignments for
the authenticated Worker. `updateStatus` checks the same workspace/Worker scope.
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

Updates require `expectedRevision`. Repeating the immediately preceding update
is idempotent; stale revisions cannot finish a later attempt. These checks fence
status updates, not filesystem/process effects. Automatic retries, leases,
timeouts, cancellation and execution handlers remain planned. Tools must define
execution idempotency, capabilities, approvals and durable chat outcomes.

`(workspace, workerId, requestId)` deduplicates dispatch while the task exists.
Different metadata with the same selector fails. After cleanup this receipt is
gone; future Chatroom dispatch must consult durable tool-call outcomes when needed.

## Cleanup

Every **five minutes**, the cron deletes `failed` and `success` records whose
terminal transition occurred **at least five minutes ago**. Age is measured from
`terminalAt`, not creation. The indexed transaction deletes at most 100 records
per terminal status; later ticks drain a backlog. Normally terminal records remain
five to ten minutes, depending on the next tick.

`sent`, `processing` and `retrying` records are retained. Stuck-task recovery is
future work. Cleanup touches only task records, preserving chats, tool-call history,
identities and credentials. Optional chat/tool-call links support correlation;
writing execution outcomes into chats is part of future integration.

## Reuse And Verification

The Convex Components catalog was queried but could not be read reliably. The
official [Workpool README](https://github.com/get-convex/workpool) was reviewed:
it schedules Convex actions/mutations, not external-machine assignments, and does
not replace this authorization/status contract. No dependency was added; existing
identity persistence and `convex-helpers` wrappers are reused.

```bash
bun run --cwd packages/backend test worker_tasks.test.ts workers.test.ts
bun run --cwd packages/worker test
```

Regressions cover assignment/owner/private-chat boundaries, idempotent dispatch,
stale transitions, retries, revocation, exact retention boundaries, bounded cleanup
and preserved chats. The additive table needs no existing-data backfill. No schema,
functions or cron configuration were deployed; scheduling starts after an authorized
deployment.
