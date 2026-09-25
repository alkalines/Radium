# Radium Chatroom

See [Convex authentication](Convex/Authentication.md) for session and workspace
function builders used by Chatroom queries and mutations.

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
to the external Agent Runner; the checked-in Runner packages are health-check
skeletons and are not an execution platform.

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
`convex/http/aisdk.chat.ts` validates the session and chat before streaming;
the action resolves workspace tools and calls the internal Gateway provider.

The workspace's upstream credentials are BYOK credentials. Completion usage and
cost estimates are retained as operational data only. Chatroom requests do not
require prepaid credits and do not debit a Radium balance.

## Planned And Limited

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
