# Future Gateway Protocols

Status: Not started. Design after task 04 clarifies adapter and upstream contracts.
OpenAI-compatible Chat Completions and model listing are current; other protocols
are roadmap items, not implemented compatibility promises.

## Work

1. Inventory the current HTTP routes, translators, streaming/error handling, tool calls, usage attribution, and client tests under `packages/website/convex/http/` and `packages/website/src/utils/translators/`.
2. Research official OpenAI Responses, Anthropic Messages, Gemini, and Grok APIs. Distinguish protocol differences from provider branding and existing OpenAI compatibility.
3. Propose a shared routing boundary with protocol-specific request/stream/error translation and explicit capability negotiation. Preserve fields that cannot be translated losslessly; reject unsupported combinations instead of silently dropping semantics.
4. Create one scoped task per approved protocol, with fixtures and streaming, cancellation, tool-call, error, and usage checks. Do not implement all protocols in one session.
5. Update `docs/Radium_Gateway.md` and `docs/api.md` as support actually ships; add protocol-specific guides below `docs/Radium_Gateway/` where needed.

## Acceptance

- Design identifies reused Gateway auth, upstream eligibility, scheduling, capture policy, and accounting boundaries rather than duplicating them in each endpoint.
- A compatibility matrix distinguishes implemented, unsupported, and planned behavior.
- No public route or compatibility claim changes during the research-only session.
