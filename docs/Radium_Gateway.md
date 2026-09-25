# Radium Gateway

Radium Gateway is Radium's model-routing product for self-hosted operation with
user-supplied upstream credentials. It currently serves OpenAI-compatible Chat
Completions and workspace-scoped model listing through Convex HTTP endpoints.
Chatroom uses this routing path rather than maintaining a second router.

## Implemented

- [API reference](api.md): routes, authentication, requests, and streaming.
- [Architecture](architecture.md): request flow, persistence, and current ownership.
- [Ownership](Radium_Gateway/Ownership.md): personal workspaces, BYOK keys, and
  the legacy balance migration boundary.
- [Convex authentication](Convex/Authentication.md): session and workspace
  function builders, including the distinct Gateway API-key boundary.
- [AI telemetry](Radium_Gateway/Telemetry.md): optional request capture, Chatroom
  correlation, local persistence, and optional OTLP export.
- [Deployment](deployment.md): runtime and exporter configuration.

The [Chatroom overview](Radium_Chatroom.md) describes the shared workspace chat
surface and its owner/member behavior.

The ownership boundary is a personal workspace owned by a Better Auth user. One
user may own multiple workspaces. A workspace owner may add any existing Better
Auth user directly as a `member`; members can use configured models and shared
chats, and can create or use their own personal chats. Owners manage provider
configuration, credentials, API keys, MCP servers, workspace defaults, and
telemetry across the Gateway and Chatroom surfaces. Personal chats remain private
to their creator, including chats made by the owner.

New Gateway requests are BYOK requests. Usage and upstream cost estimates are
recorded for operations and visibility, but Radium does not require prepaid
credits or charge the user.

## Planned And Limited

Responses, Anthropic Messages, Gemini, and Grok protocol compatibility are future
work. Random routing remains a known limitation. Better Auth organization
ownership, organization invitations, organization-derived membership, and
broader roles are future work; direct membership is not an invitation flow.
Application-level encryption and an optional explicit owner-auditing mode are
also future work. Any future audit view must preserve current workspace and chat
authorization rather than bypass it.
Provider and MCP endpoint configuration is owner-only. Deliberately configured
local/private endpoints remain a required self-hosted use case, but the complete
SSRF/private-network policy and configurable egress control are future work in
[task 04](tasks/04_Upstream_Instances.md).

Legacy balance-shaped fields, keys, and Secret Store namespaces remain in the
widened schema intentionally while the ownership backfill is pending. The
resumable migration and paginated verification are staged but have not been run
against a deployment. See the [ownership guide](Radium_Gateway/Ownership.md) for
the forward-only cutover warning and verification procedure.
