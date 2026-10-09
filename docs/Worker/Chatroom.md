# Worker Tools In Chatroom

## Implemented Locally

The prompt input's Worker menu selects an enrolled identity, an absolute directory
on that machine, and independent **Read**, **Edit**, **Create**, and **Bash** tools. The
directory is saved on blur or Enter. Existing selections without a directory stay
valid stored configuration, but execution requires an explicit directory. No
current-directory fallback is used.

The chat HTTP handler now supplies `worker_read`, `worker_edit`, and
`worker_create`, and `worker_bash` to the model when enabled. The selected model must support tool
calling. Worker authorization status `active` means enrolled and not revoked;
it does not establish that the process is online. The terminal must report
`Worker control connected.` for task consumption to be available. See the
[CLI guide](../../packages/worker/README.md) for safe disconnect diagnostics.

## Authorization And Execution Flow

1. `packages/backend/src/http/aisdk.chat.ts` validates the Better Auth session and
   chat visibility. Worker identity, directory, and tools come from the stored
   chat, rather than request-body overrides.
2. Only the workspace owner receives Worker tools. Membership alone does not
   allow machine execution, including in a shared chat. Owners cannot access or
   execute against another creator's personal chat.
3. `packages/backend/src/worker/chat-tools.ts` builds the enabled AI SDK tools.
   Read returns hashline snapshots, continuation hints, and native edit grammar.
   Edit accepts hashline patches or `apply_patch` Update File envelopes. Create
   constructs an Add File envelope from a path and text content.
4. Edit/Create/Bash return a Chatroom approval request before any task dispatch.
   AI SDK approval signatures use a domain-separated HMAC key derived from the
   existing backend `WORKER_AUTH_PRIVATE_JWK` secret, scoped to user, workspace,
   chat, Worker, directory, and enabled tools. The SDK checks the signature and
   exact tool input before executing a submitted approval. Changing configuration
   or rotating the issuer secret invalidates pending write approvals.
   Bash-only selections also derive this approval key; enabling a file-write
   tool alongside Bash is not required.
5. Internal `worker_tasks.dispatchChatEdit` rechecks visibility, ownership, active
   Worker identity, exact configured directory, and enabled tool at every stage.
   Write calls stage a preview and apply only that call's successful preview ID.
   The native session ID is derived from chat and directory, so changing the root
   starts a separate session instead of switching an existing session's directory.
6. The external Worker claims the task and performs local operations. Native
   `writeMode` checks restrict Chatroom Edit to existing-file updates and Create
   to new files. Create cannot be used to edit an existing file, and Edit cannot
   create, delete, or move files. Path and symlink confinement remain enforced by
   the Worker, not Convex.
7. Bash dispatches a single `execute` stage after approval. Native `Shell` runs in
   Worker with a 1–30 second deadline and a bounded final-output receipt. The
   directory sets cwd; it does not confine commands or their OS access. See
   [Bash execution](Bash_Tool.md#implemented-radium-foreground-tool) for shell
   state, output, environment, cleanup and failure contracts.

Read does not require a per-call approval: enabling it grants the owner-directed
read tool for that chat. Approved writes are serialized within a model turn
because the native session holds at most one pending preview. Manual owner-only
`dispatchEdit` remains a separate API with its existing contracts.

## Outcomes, Retention And Failure Behavior

The action waits at most 45 seconds per task stage with bounded polling. A
disconnected Worker, abort, or missing receipt after dispatch returns
`WORKER_OUTCOME_UNKNOWN` with the task ID. This is not proof that a write did not
run. It must not be automatically retried. A failure before successful staging
never dispatches an apply. Process restarts still discard native sessions and
previews; unknown claimed tasks are not re-executed automatically.

`worker_tasks` remains short-lived coordination data. `worker_chat_calls` stores
chat-owned stage identity and result receipts transactionally alongside task
completion, so replaying a tool call cannot execute it again after five-minute
task cleanup. Receipts include file data/patch results and are conversation data,
not operational logs or an audit ledger. Internal receipt reads require the same
owner/chat authorization. Chat deletion schedules bounded receipt cleanup; these
receipts do not have a separate time-based retention policy. The SDK also saves
tool outputs in the conversation's messages.
Completion claim/revision fencing also lets the same machine acknowledge an
identical delivery retry after transient task pruning. Bash request identities
are stored as digests rather than a duplicated durable command payload.

File task inputs/results are not printed in Worker diagnostics. Shared-chat tool
outputs are visible to that chat's members like other conversation content.

## Verification And Limits

```bash
bun run --cwd packages/backend test src/worker/chat-tools.test.ts src/http/aisdk.worker.test.ts convex/worker_chat.test.ts convex/workers.test.ts
bun run --cwd packages/worker test
```

These are local mocked-model, authorization, task coordination, and real native
engine tests. Live deployment verifier/transport and browser-to-model execution
remain unverified. Polling is currently used by the server action; reconnectable
execution UI, user cancellation of dispatched tasks, recovery of ambiguous
outcomes, configurable receipt retention, background/PTY/service execution,
eval, and OS sandboxing remain
planned. Staging has the existing size, session, and preview expiry limits in the
[native guide](Native_Tools.md).
