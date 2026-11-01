# Radium Chatroom

Radium Chatroom is the user-facing home for conversations, model selection,
reasoning controls, service tiers, approvals, and tools. It uses a lossless in-process SDK adapter through the Gateway's shared completion pipeline, not a second provider router. Signed/encrypted reasoning metadata survives history replay; visible summaries render separately from opaque continuation state.

## Implemented

Completed and failed requests both allow **Revert to this message** on a user turn. Reverting returns its text/files to the Composer, removes that turn and later turns from the local thread, hides the interruption card, and retains Restore until the next send. Submission and streaming still block revert; the next send makes the shortened history durable.

**Retry** continues a turn that stopped short instead of regenerating it. When a request ends aborted (Stop, or the browser disconnected) or with an error, the chat HTTP action saves `interruption` (`kind`, and the streamed error for failures) on the chat beside the partial messages; the next request clears it (`src/chatroom/interruption.ts`). The Session shows it as a card above the prompt; Retry drops the turn's unfinished step (partial text/reasoning, tool calls without a result), keeps steps whose tool calls have results or approval answers, and resends the conversation without a new user message, so the model resumes after those results. A tool call cut off mid-execution is dropped and may run again when the model re-issues it. A Tab that loads a chat while its request is still running reseeds from the saved messages once that request ends, so a reload mid-reply does not continue from stale history. The assistant footer's **Regenerate** still restarts the reply from its user turn.

### Chat Storage and Subscriptions

Chat documents (`aisdk_chats`) hold only metadata. History is one `chat_messages` row per message; the chat HTTP action saves the full history at request end but writes only positions whose content changed and deletes positions past a revert (`src/chatroom/messages.ts`). Attachments are uploaded by the Composer to Convex File Storage (`chat_files.generateUploadUrl`, then `chat_files.register`, 20 MiB limit) and persisted as storage URLs; the chat action inlines their bytes into the model input only (`src/chatroom/files.ts`). Files are deleted with the last chat that references them; uploads never sent, and stored files no `chat_files` or `telemetry_blobs` row references (such as uploads never registered), are pruned after a day.

Subscriptions follow what is on screen. Home subscribes to `aisdk.ListChats` per Project filter and keeps an inactive filter's subscription for five minutes, so a quick return to Home applies live updates instead of refetching; starting on a session Tab never subscribes it. Every mounted session Tab subscribes to `aisdk.GetChat` (metadata, for its title and run state) but subscribes to `aisdk.GetChatMessages` only after the Tab is first opened, then keeps it while the Tab stays open.

Chats created before this split keep their history embedded until their next save or `migrations:runChatMessages` moves it out. Inline data-URL attachments in those histories stay inline in their message rows. Narrowing the deprecated `messages`/`chat_completions` fields requires that migration to have completed on the deployment.

### Workspace Access

Each Better Auth user can own multiple personal workspaces. A workspace owner
can add any existing Better Auth user by email as an explicit `member` through
the workspace membership functions. The owner is implicit and is not stored as a
membership row. Adding a member is direct: there is no pending invitation or
invitation-acceptance flow.

The full workspace contract is documented in the [Gateway ownership guide](Radium_Gateway/Ownership.md).

The access boundary is:

| Actor    | Access                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Owner    | Manages provider configuration, credentials, API keys, MCP servers, workspace defaults, and telemetry. |
| Member   | Uses the workspace's configured models, workspace-scoped shared chats, and their own personal chats.   |
| Outsider | Cannot resolve the workspace, its models, or its chats.                                                |

Members do not receive provider secret values or Gateway management access.
General Gateway activity, usage, logs, and telemetry queries are owner-only.

### Chat Scopes

Every new chat has an explicit workspace and a `scope`:

- `personal` chats are visible only to their creator. This remains true when the
  creator is the workspace owner; the owner cannot see a member's personal chat.
- `workspace` chats are visible to the workspace owner and explicit members.

The default scope is `personal`. Only the chat creator can change a chat's
scope. Chat reads, mutations, message streaming, and tool resolution re-check
the authenticated user against the chat's workspace on the server; a
browser-supplied workspace or user identifier is not trusted.

The workspace owner or chat creator can rename, pin, delete, regenerate the
title of a shared chat, and set its per-chat tool override. Workspace
defaults, MCP servers, provider configuration, credentials, API keys, and
telemetry remain owner-managed. A personal chat is managed only by its creator;
the workspace owner cannot administer a member's personal chat through the
workspace boundary.

The Chatroom sidebar lists the current user's personal chats and the workspace's
shared chats. Members can start personal chats in a workspace and use models
from that workspace's enabled provider snapshots and credentials. Chatroom
completions are attributed to the chat and workspace for visibility filtering
and operational usage estimates.

### Models And Tools

Workspace provider configuration supplies the endpoint, adapter metadata, model
mapping, pricing, and supported parameters used by Chatroom. The global
`providers` and `models` tables remain catalogue data; workspace changes do not
replace another workspace's configuration.

Workspace owners configure default models, MCP servers, built-in tool selection,
and Exa web search credentials. Secret values are loaded server-side from
Secret Store and are not returned to the browser. Members can use the configured
workspace tools in chats, subject to the chat's effective selection.

Two session tools act only on the conversation (`packages/backend/src/chatroom/session-tools.ts`). They are built-in tool sets of the same id, listed in the Tools dialog and Settings → Tools like Web Search, but **default-on**: stored selections record them as opt-outs (`disabledBuiltinToolSets` on workspace defaults and chat overrides), so workspaces and chats saved before they existed get them, and switching one off persists. Their shapes follow OpenCode's `question`/`todowrite` tools and ACP plan entries so a future ACP agent can reuse the same UI:

- `question` asks one or more questions (`header`, `question`, `options[{label, description?}]`, `multiple?`). It has no server execution: the stream ends at the call, the browser shows the Question prompt in the Composer's place, and `addToolOutput` returns `{ answers: string[][] }` (one list per question, empty for a skipped one), which the client continues automatically like an approval. The model receives OpenCode's `"Question"="Answer"` text. Dismissing returns an `output-error` and does not continue; the user's next message does.
- `todo_write` replaces the Session's todo list (`content`, `status`: `pending` | `in_progress` | `completed`). The list lives in the call input of the persisted messages, so it needs no extra storage; the Session shows the latest complete list above the Composer while it has open items or the run is working.

The Chatroom currently supports HTTP MCP servers, web search when configured,
and approval UI for tool calls. Filesystem, command, and coding execution belong
to the external Worker. Its Convex component owns identity persistence, and the
external service consumes owner-dispatched file tasks. See the [Worker guide](Worker.md).

Workspace owners have a compact Worker selector inside the prompt input on the
home page and in existing conversations. The menu lists active identities from
that composer's workspace and provides independent Read/Edit/Create/Bash toggles.
Choosing a Worker starts with all Worker tools disabled. New-chat selection is saved
when creating the chat; existing-chat changes are saved immediately. Switching
the home composer's workspace clears its effective selection. Existing chats use
their own workspace even if the sidebar points elsewhere.

Worker configuration is owner-only and also requires access to the chat. Members
cannot select or change Workers, including in shared chats, and owners cannot
configure another user's personal chat. The server rejects cross-workspace and
revoked Worker selections. A previously saved revoked identity is displayed as
unavailable and can be cleared. Active means enrolled and not revoked, not online.
The menu also takes an absolute directory on the Worker. Enabled tools are now
exposed to the model for owner requests. Read executes directly; Edit and Create
require signed approval before staging and applying. Bash requires signed approval
before running a foreground command, with bounded final output and a 30-second
maximum deadline. Its directory is cwd, not a sandbox; see the
[Bash guide](Worker/Bash_Tool.md#implemented-radium-foreground-tool). Tool dispatch rechecks the
workspace and selection on every stage; Worker-side write modes enforce the
individual toggles. See [Worker tools in Chatroom](Worker/Chatroom.md) for flow,
durable receipts, timeouts, and verification limits.

`packages/backend/convex/aisdk_tools.ts` owns workspace-authorized MCP server
management and Exa credential operations. The web UI calls its public functions;
the chat action loads built-in tool credentials through its provider-scoped internal runtime query and
loads MCP bearer tokens server-side. Configuration normalization and tool-name
collision rules live in `packages/backend/src/chatroom/aisdk-tools.ts`. Exa is
the current agentic search integration; additional search integrations can use
their own credential and runtime rules under the same Chatroom tool boundary.
Missing Exa keys omit web search; a failing MCP connection is skipped. Secret
Store recovery failures remain errors for credential management.

### Code Mode

Code Mode is the default-on **Code Mode** built-in tool set (stored id `code_interpreter`, which shipped as the "Code Interpreter" placeholder), switched in the tools menu like the other sets. While it is on and the model supports tools, the request gets an `execute` tool (`packages/backend/src/chatroom/code-mode-runtime.ts`) that runs a JavaScript program in [`@opencode/codemode`](https://github.com/anomalyco/opencode/tree/dev/packages/codemode), an interpreter for a JavaScript subset rather than a sandbox: timers, `process`, the filesystem, the network, imports, and modules do not exist, so the only way out is `tools.*`. Limits are set explicitly (10 minutes including time spent waiting for the user, 100 tool calls, 64 KiB of retained output). Design background: [OpenCode Code Mode research](research/OpenCode_Code_Mode.md).

- **Direct tools** (`question`, `todo_write`, `web_search`, `worker_*`) stay normal tool calls and are also callable inside `execute` under the same name and input, e.g. `tools.worker_bash({ command })`.
- **MCP servers** run only inside Code Mode by default, as `tools.<server prefix>.<tool>`, which keeps their schemas out of the model's tool list. Owners switch a server to direct tool calls with **Code Mode only** in its settings (`mcp_servers.codeMode`, absent means on); a direct server is not callable inside `execute`, so a server that runs code itself is never nested. With the Code Mode set off, or when `execute` cannot be built for the request, every MCP server is exposed as direct tool calls. The `# Code Mode` system prompt section lists MCP tools with TypeScript-like signatures within a ~2,000-token budget; when they do not fit, it tells the model to find the rest with the interpreter's built-in `search(...)`. When the workspace turns the system prompt off, the catalog is appended to the `execute` description instead.
- **Permissions are unchanged.** An inner call to a tool that needs approval (Worker edit/create/Bash) or a `question` opens a `codemode_interactions` prompt; the browser shows the same approval or question prompt in the Composer slot while the request streams, with a countdown, and answers through `api.code_mode.answerInteraction` (only the user who sent the request). Every open prompt shows at once (stacked; keyboard shortcuts go to the first), since each has its own deadline. The chat action polls for the answer once a second; unanswered after 180 seconds (`CODE_MODE_INTERACTION_TIMEOUT_MS`), the call is denied (or the questions dismissed) automatically. A denial, dismissal, or timeout rejects that call inside the program with the same kind of text a direct call would get. Rows carry `expiresAt` (deadline plus one minute); a cron deletes expired rows the action never closed.
- **UI.** `execute` streams preliminary outputs listing its inner calls (`CodeModeOutput` in `packages/backend/src/chatroom/code-mode.ts`). The Session shows a "Ran code" step whose body (the program and its result) folds away once it starts running, and beneath it, on an always-visible rail, each inner call as the same step a direct call of that tool gets. Inner call outputs are not stored, only their inputs and status; the program's return value is what the model sees.

One chat request makes at most 50 model calls (`MAX_CHAT_STEPS` in `src/http/aisdk.chat.ts`). A request whose last step still asked for tools when it hit the cap ends with a `step_limit` interruption, and the Session offers **Continue**, which resumes from the last completed step.

### System Prompt

By default every chat request sends one system prompt built by `chatSystemPrompt` in `packages/backend/src/chatroom/system-prompt.ts`; `internal.chatroom.resolveSystemPrompt` reads the workspace switches and model identity and the chat action assembles the text once it knows the Code Mode catalog. It is deliberately minimal and sets no style or conduct, because Chatroom is general-purpose: it says the model runs inside Radium, outlines Chatroom (including what the Markdown renderer supports), Gateway, and Worker, adds the `# Code Mode` catalog when the request has the `execute` tool, and gives the model's name, author, and slug from the global `models` catalogue (unknown slugs fall back to the slug). Its `# Rules` hold the few always-on harness rules: paths outside the selected Worker directory are out of scope and the UI asks the user's permission for them, so the model does not ask on its own; files it did not make may be the user's work; file reads and changes go through the `worker_*` file tools and everything else, including CLIs, through `worker_bash` (new capabilities are expected to arrive as CLIs and Code Mode, not more native tools); and independent tool calls run in parallel. The orientation is invariant so providers can cache it as a prefix; the catalog follows it because it changes with the enabled tools. Opt-in rule packs (like Oh-My-Pi's) and a Project's AGENTS.md are planned sections; their insertion points are marked in `chatSystemPrompt`.

Workspace owners control it in Settings → Chat defaults (`workspace_settings.systemPrompt`, absent means both on): **System prompt** turns the whole prompt off, so requests carry no system message; **Model identity** drops only the `# Model` section and is disabled while the prompt is off. The identity choice is kept while the prompt is off, so turning it back on restores it. The switches apply to every chat in the workspace, existing ones included.

Agent Markdown (`apps/web/src/components/markdown.tsx`) renders KaTeX math between `$$` delimiters (single `$` stays text, so prices are safe), CJK-aware emphasis through Streamdown's `math` and `cjk` plugins, and closed `mermaid` fences as a `MermaidDiagram`; a fence still streaming shows as source.

### Notifications

When a request ends, the user who sent it is notified that the session finished, waits for an approval or an answer, or failed: a toast and sound in an open tab, a system notification when that tab is in the background, or Web Push when no tab claims it. Stopped requests notify nobody. See [Notifications](Notifications.md).

### Telemetry

Telemetry is optional and disabled by default. It is captured at the Gateway, so
each Chatroom model call is recorded as a Gateway request in the chat's session.
Input and output capture are separate controls. The workspace owner manages the
settings and views. Shared-chat requests may be visible to the owner; requests
from another user's personal chat record no content and are hidden. See the
[Gateway telemetry guide](Radium_Gateway/Telemetry.md).

## Auth And Runtime Flow

The browser authenticates with Better Auth and calls authenticated Convex
queries and mutations. `convex/aisdk.ts` creates and lists chats, while
`convex/workspaces.ts` resolves owner/member access and chat visibility.
`src/http/aisdk.chat.ts` validates the session and chat before streaming;
the action resolves workspace tools and calls the internal Gateway provider.

`packages/backend/convex/chatroom.ts` owns workspace defaults, per-chat tool
resolution, internal title-generation handlers, and database-backed chat visibility
checks used by Gateway usage, logs, and telemetry. Runtime-neutral title generation,
prompt extraction, title sanitization, and title-model eligibility live in
`packages/backend/src/chatroom/titles.ts`. Chat creation, forking, and manual title
regeneration schedule `internal.chatroom.generateForChat`; title generation uses the
workspace's configured title/default model or an available text-chat fallback.
Generation failures leave the chat usable, and generated titles do not overwrite an
existing title unless regeneration is forced.

The former `chat_titles` internal function paths have moved to `chatroom`; callers
and offline API bindings are updated together. When deploying this rename, account
for already queued jobs that reference the old paths.

The workspace's upstream credentials are BYOK credentials. Completion usage and
cost estimates are retained as operational data only. Chatroom requests do not
require prepaid credits and do not debit a Radium balance.

## Planned And Limited

- Live in-flight replies in every Tab and device, Stop from any Tab, run
  admission against overlapping turns, and reload resume are proposed in
  [Live sessions](Radium_Chatroom/Live_Sessions.md). Today only the sending
  Tab sees a reply stream; others see it when the turn is saved.
- ACP agents as a Session's Agent are proposed in [ACP agents](ACP.md): the
  harness runs on a Worker, owns the conversation, and Radium stores only
  metadata and relays content transiently.
- Worker identity, enrollment/recovery, machine authentication, task coordination,
  owner-dispatched file tasks, composer configuration, model file tools, signed
  write approvals, and durable stage receipts are implemented locally. Deployed
  verifier/transport and browser-to-model execution remain unverified. Cancellation
  and ambiguous-outcome recovery remain planned. See the [Worker overview](Worker.md),
  [task contracts](Worker/Tasks.md), and [Convex transport plan](Worker/Convex_Transport.md).
- Better Auth organization ownership, invitations, organization-derived
  membership, and broader workspace roles are not implemented. Direct membership
  of existing users is the only sharing policy.
- Broader application-level encryption and an optional explicit owner-auditing
  mode are future work. A future audit mode must not bypass workspace or chat
  authorization.
- Provider and MCP endpoint configuration is owner-only. Deliberately configured
  local/private endpoints remain a required self-hosted use case, but the complete
  SSRF/private-network policy and configurable egress control are future work in
  [task 04](tasks/04_Upstream_Instances.md).
- Legacy balance fields and per-user Chatroom records remain during the staged
  ownership migration; they are not being deleted as part of this cutover.
- The ownership migration runner and its paginated verification queries are
  staged but have not been executed against a deployment. The audited offline
  API-only binding generator is documented in
  [deployment](deployment.md#offline-api-binding-codegen); it writes only
  `convex/_generated/api.d.ts` and does not verify a deployment.

## Verification

Run the backend unit and Convex handler suites from the repository root:

```sh
bun run test
```

The workspace policy tests cover owner/member workspace access, private and
shared chat scopes, archived workspaces, and legacy ownership isolation. The
Convex suite covers handler-level workspace/member chat authorization and related
ownership regressions.

Title and visibility refactor regressions can be run with:

```sh
bun run --cwd packages/backend test convex/chatroom.test.ts src/chatroom/titles.test.ts
```

These cover initial-prompt extraction, existing-title preservation and forced
replacement, enabled workspace model selection and fallback, archived workspaces,
the consolidated scheduled title action, and private-chat sibling filtering for
telemetry list and direct reads. The scheduler test uses an unconfigured workspace
and makes no upstream model request.
