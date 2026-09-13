# Radium Gateway

Radium Gateway is Radium's model-routing product for self-hosted operation with
user-supplied upstream credentials. It currently serves OpenAI-compatible Chat
Completions and model listing through Convex HTTP endpoints. Chatroom uses this
routing path rather than maintaining a second router.

## Implemented

- [API reference](api.md): routes, authentication, requests, and streaming.
- [Architecture](architecture.md): request flow, persistence, and current ownership.
- [Ownership](Radium_Gateway/Ownership.md): personal workspaces, BYOK keys, and
  the legacy balance migration boundary.
- [AI telemetry](Radium_Gateway/Telemetry.md): optional request capture, Chatroom
  correlation, local persistence, and optional OTLP export.
- [Deployment](deployment.md): runtime and exporter configuration.

## Planned And Limited

Responses, Anthropic Messages, Gemini, and Grok protocol compatibility are future
work. Random routing and legacy credit-coupled records remain known limitations;
new Gateway operation is workspace-owned and BYOK-oriented. See the [task
queue](tasks/README.md) for upstream instances, migration rollout, and
load-balancing work.
