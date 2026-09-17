# API Reference

Radium exposes a focused subset of the OpenAI API from the Convex site origin.
The examples below assume:

```bash
export RADIUM_URL="https://your-deployment.convex.site"
export RADIUM_API_KEY="rad-sk-..."
```

Create the workspace API key as its owner in **Gateway > API Keys**. Provider
credentials and at least one enabled model/provider mapping must also be
configured in that workspace before requesting a completion, except that a
legacy-balance workspace with no local provider configuration may temporarily
use enabled catalogue providers while its migration is pending. Any existing
local configuration row disables that fallback.

## Authentication

Both OpenAI-compatible endpoints require a bearer token:

```http
Authorization: Bearer rad-sk-...
```

Gateway keys are different from the browser's Better Auth session. A bearer key
authenticates to its workspace, not to a particular workspace member. The key's
workspace must have an enabled provider configuration and matching BYOK
credentials. New requests do not require prepaid credits or a Radium charge.
Legacy balance keys remain usable through the bounded compatibility path while
their workspace mapping and credential backfill are pending.

## List Models

`GET /api/openai/v1/models`

```bash
curl "$RADIUM_URL/api/openai/v1/models" \
  -H "Authorization: Bearer $RADIUM_API_KEY"
```

The response is an OpenAI-style model list enriched with Radium's model,
architecture, parameter, pricing, and provider metadata. It is limited to models
offered by enabled providers configured for the API key's workspace; provider
endpoints and model mappings come from that workspace's local configuration.
While legacy migration is pending, a legacy-balance workspace with no local
configuration may instead list models from enabled catalogue providers. Any
existing local configuration row, including a disabled or tombstoned row,
disables that fallback.
Workspace members use the same workspace-scoped model set through the Chatroom
session path.

## Create Chat Completion

`POST /api/openai/v1/chat/completions`

### JSON Response

```bash
curl "$RADIUM_URL/api/openai/v1/chat/completions" \
  -H "Authorization: Bearer $RADIUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-slug",
    "messages": [
      { "role": "system", "content": "Answer concisely." },
      { "role": "user", "content": "What is Radium?" }
    ],
    "stream": false
  }'
```

### Streaming Response

Set `stream` to `true` to receive `text/event-stream` data:

```bash
curl -N "$RADIUM_URL/api/openai/v1/chat/completions" \
  -H "Authorization: Bearer $RADIUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-slug",
    "messages": [{ "role": "user", "content": "Count to three." }],
    "stream": true
  }'
```

Each event contains an OpenAI-compatible JSON chunk prefixed with `data:`. The
stream terminates with `data: [DONE]`.

## Provider Selection

By default, Radium resolves an enabled provider configured for the key's
workspace that offers the requested model and has matching BYOK credentials.
Requests may include a `provider` slug to constrain routing to a specific
configured provider.

Provider-specific model IDs are internal catalogue configuration. API callers
send the global Radium model slug returned by the models endpoint.

Provider endpoint configuration is owner-only. Local or private upstream
endpoints are a required self-hosted use case, but SSRF/private-network policy
and configurable egress controls are not part of the current API contract; see
[task 04](tasks/04_Upstream_Instances.md).

## Compatibility Scope

The request validator and translators under `src/utils/types/openai/` and
`src/utils/translators/` are the source of truth for accepted fields. Common
chat messages, sampling settings, reasoning settings, tools, tool choice,
structured response formats, token limits, and streaming are supported where
the selected provider/model supports them.

Radium does not currently expose OpenAI Responses, Embeddings, Images, Audio,
Files, Fine-tuning, or Batch endpoints.

## Errors

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `400`  | The JSON body failed request validation                           |
| `401`  | The bearer token is missing or invalid                            |
| `500`  | Routing, provider execution, or another internal operation failed |

Provider/model configuration failures currently surface through the generic
server error path. There is no prepaid-credit or balance-required error in the
new workspace path. Do not depend on a stable error envelope beyond the explicit
authentication and validation errors.

Usage and `cost` values in completion records are operational upstream estimates.
They are not invoices, prepaid credits, or a debit against the workspace.

## Internal Chat Endpoint

`POST /api/aisdk/chat` serves the bundled chatroom and emits an AI SDK UI
message stream. It uses browser session authentication and is not part of the
public OpenAI-compatible contract.
