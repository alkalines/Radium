# Radium Chatroom

Radium Chatroom is the user-facing home for conversations, model selection,
reasoning controls, approvals, and tools. It uses the Gateway's internal
OpenAI-compatible completion path; it does not implement a second provider
router.

## Implemented

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

### Telemetry

AI telemetry is optional and disabled by default. Input and output capture are
separate controls. The workspace owner manages the settings and general
telemetry views. Shared-chat traces may be visible to the owner, while traces
associated with another user's personal chats are filtered out. See the
[Gateway and Chatroom telemetry guide](Radium_Gateway/Telemetry.md).

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
