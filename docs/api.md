# API Reference

Radium exposes a focused subset of the OpenAI API from the Convex site origin.
The examples below assume:

```bash
export RADIUM_URL="https://your-deployment.convex.site"
export RADIUM_API_KEY="rad-sk-..."
```

Create the API key in **Gateway > API Keys**. Provider credentials and at least
one enabled model/provider mapping must also be configured before requesting a
completion.

## Authentication

Both OpenAI-compatible endpoints require a bearer token:

```http
Authorization: Bearer rad-sk-...
```

Gateway keys are different from the browser's Better Auth session. The key's
balance must have available credits.

## List Models

`GET /api/openai/v1/models`

```bash
curl "$RADIUM_URL/api/openai/v1/models" \
  -H "Authorization: Bearer $RADIUM_API_KEY"
```

The response is an OpenAI-style model list enriched with Radium's model,
architecture, parameter, pricing, and provider metadata.

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

By default, Radium resolves an enabled provider that offers the requested
model and has credentials for the key's balance. Requests may include a
`provider` slug to constrain routing to a specific configured provider.

Provider-specific model IDs are internal catalogue configuration. API callers
send the global Radium model slug returned by the models endpoint.

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
| `402`  | The key's balance has no usable credits                           |
| `500`  | Routing, provider execution, or another internal operation failed |

Provider/model configuration failures currently surface through the generic
server error path. Do not depend on a stable error envelope beyond the explicit
authentication and credit errors.

## Internal Chat Endpoint

`POST /api/aisdk/chat` serves the bundled chatroom and emits an AI SDK UI
message stream. It uses browser session authentication and is not part of the
public OpenAI-compatible contract.
