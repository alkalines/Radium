# Radium Gateway

Radium Gateway is Radium's model-routing product for self-hosted operation with
user-supplied upstream credentials. It currently serves OpenAI-compatible Chat
Completions and model listing through Convex HTTP endpoints. Chatroom uses this
routing path rather than maintaining a second router.

## Implemented

- [API reference](api.md): routes, authentication, requests, and streaming.
- [Architecture](architecture.md): request flow, persistence, and current ownership.
- [AI telemetry](Radium_Gateway/Telemetry.md): optional request capture, Chatroom
  correlation, local persistence, and optional OTLP export.
- [Deployment](deployment.md): runtime and exporter configuration.

## Planned And Limited

Responses, Anthropic Messages, Gemini, and Grok protocol compatibility are future
work. Current random routing and credit-coupled ownership are existing debt, not
the target BYOK architecture. See the [task queue](tasks/README.md) for upstream
instances, ownership migration, and load-balancing work.
