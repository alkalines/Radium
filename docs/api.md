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
stream terminates with `data: [DONE]`. If the selected provider fails after the
first chunk, the stream ends with a `data: {"error": {"message", "code", "provider"}}`
event and no `[DONE]`.

## Provider Selection

Radium routes among the enabled providers configured for the key's workspace
that offer the requested model and have matching BYOK credentials, using the
workspace's routing strategy, priorities, session affinity, retries, and
cooldowns. See [Gateway routing](Radium_Gateway/LoadBalancer.md).

`provider` accepts a configured provider slug, which pins the request to that
provider without fallbacks, or an OpenRouter-compatible object:

```json
{
  "provider": {
    "order": ["openai"],
    "allow_fallbacks": true,
    "ignore": ["slow"],
    "sort": "throughput"
  }
}
```

Supported fields are `order`, `allow_fallbacks`, `only`, `ignore`, and `sort`
(`price`, `throughput`, `latency`, or `{ "by": … }`); slugs name the workspace's
providers. Session affinity reads `session_id` from the body, client session
headers such as `X-Session-ID`, or `prompt_cache_key`.

Provider-specific model IDs are internal catalogue configuration. API callers
send the global Radium model slug returned by the models endpoint.

Provider endpoint configuration is owner-only. Local or private upstream
endpoints are a required self-hosted use case, but SSRF/private-network policy
and configurable egress controls are not part of the current API contract; see
[task 04](tasks/04_Upstream_Instances.md).

## Compatibility Scope

Radium implements a provider-dependent Chat Completions subset, not every OpenRouter extension. Unknown top-level fields and unsupported provider-selection constraints are rejected rather than silently discarded. `trace` is an explicitly supported telemetry-only object. Provider slugs refer to workspace connections, not OpenRouter's nested upstream endpoint names.

Supported paths include text and supported image/audio/inline-file inputs, JSON response formats with intact JSON Schema, function tools and tool selection, reasoning continuation, token limits (`max_completion_tokens` or `max_tokens`), and stop sequences where supported upstream. Only `n=1` is supported. Native OpenAI uses Responses upstream; this does not add a public Responses endpoint. Provider-specific unsupported settings return an error instead of pretending they were applied.

### Service tiers and costs

`service_tier` selects an advertised provider-model tier: `default`, `flex`, `priority` (`fast` alias), or `ultrafast`. Omission/`auto` keeps the provider default. Every model, including older workspace snapshots, exposes Default initialized from its existing base prices; Default cannot be disabled in the editor. Explicit tiers restrict eligible workspace connections. OpenRouter capabilities and unambiguous rates are loaded from its endpoint catalogue during model import. Native provider modes and rates are imported from models.dev's experimental metadata where supported; owners can also configure tier rates on existing mappings.

The response's `service_tier`, when known, describes what upstream actually served, not what was requested. Routing retains dispatch-time rates and uses the served tier's snapshot on fallback. Estimates and provider-reported costs remain distinct. Missing prices or usage remain unknown, not zero; historical estimates are not retroactively repriced. Rates are per token internally; configuration forms use USD per million tokens.

models.dev `experimental.modes` is imported separately from service tiers. `inference_mode` selects an advertised named mode (`inferenceMode` in Chatroom requests): a `fast` mode can set `service_tier: "priority"`, while `pro` sets `reasoning.mode: "pro"` rather than inventing a pro service tier. Anthropic speed modes preserve their allowlisted beta header. Modes without a separate cost inherit the base price schedule. Explicit service-tier selection takes precedence over a mode's speed/tier override.

In Chatroom, **Inference mode** contains only Standard and supported Pro reasoning. Fast/Priority, Flex and Ultrafast belong exclusively to **Service tier**; speed-only catalog modes are not duplicated in the inference-mode menu.

Context-dependent `cost.tiers` schedules use their exact context threshold and price the whole request above that boundary, including cached input. The older `context_over_200k` field is used only when no modern context tiers exist. Small positive per-million prices are converted without rounding them to zero.

To restore already-zero or outdated imported prices and load new modes, open the provider's model manager and choose **Refresh existing models from models.dev**, then select the mappings to refresh. This deliberately updates their pricing and modes while preserving unrelated model configuration. It does not silently replace configured free/custom rates or reprice historical completions.

Cache reads and writes are disjoint from uncached input. `usage.prompt_tokens_details.cache_write_tokens` reports writes; 1-hour writes have a separate rate from 5-minute writes. Text-part `cache_control` directives preserve supported cache boundaries and TTLs. Unknown mixed-retention write usage produces an unknown estimate rather than a guessed price.

### Reasoning and custom tools

Assistant `reasoning_details` preserves structured text, summaries and encrypted continuation state. Clients continuing a conversation must replay the entire ordered detail array, including opaque data and signatures, unchanged. A provider-specific `provider_metadata` extension retains native continuation information. Summaries are not raw chain-of-thought; encrypted content is not displayable text.

OpenAI Responses-backed connections support `type: "custom"` tools with exact string input and optional regex/Lark grammar. Runtime-discovered JSON-schema tools remain function tools. Unsupported custom-tool connectors fail explicitly. Parallel calls retain separate IDs/indexes in streaming and nonstreaming responses.

With streaming, `stream_options.include_usage: true` requests a separate terminal usage chunk with an empty `choices` array. Unsupported audio output/modalities, prediction, log probabilities, advanced sampling controls, plugins, model fallback lists and unimplemented routing constraints are rejected.

Radium does not expose public OpenAI Responses, Embeddings, Images, Audio, Files, Fine-tuning, or Batch endpoints.

## Errors

| Status | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| `400`  | The JSON body failed validation, or the provider rejected it |
| `401`  | The bearer token is missing or invalid                       |
| `429`  | Every eligible provider is cooling down; see `Retry-After`   |
| `500`  | Routing configuration or another internal operation failed   |
| other  | Last upstream status after routing exhausted its retries     |

Upstream failures after routing return `{"error": {"message", "code", "provider"}}`
with the last provider's status. Provider/model configuration failures (unknown
model, no credentialed provider, a pinned provider that cannot serve the model)
still surface through the generic server error path. There is no prepaid-credit
or balance-required error in the new workspace path.

Usage and `cost` values in completion records are operational upstream estimates.
They are not invoices, prepaid credits, or a debit against the workspace.

## Internal Chat Endpoint

`POST /api/aisdk/chat` serves the bundled chatroom and emits an AI SDK UI
message stream. It uses browser session authentication and is not part of the
public OpenAI-compatible contract.

## HTTP Routing And CORS

`packages/backend/src/http/router.ts` owns the implemented application routes:
Gateway completions/models, Chatroom chat, and the subscription subrouter.
Handlers under `packages/backend/src/http/` accept the Convex `ActionCtx` and raw
`Request`; Hono receives that context through `c.env`. Database access remains
through the existing Convex queries/mutations, with the same key, workspace,
session, and chat authorization checks.

`packages/backend/convex/http.ts` connects this app with `HttpRouterWithHono`
from `convex-helpers/server/hono`. Better Auth continues to register native
Convex routes and owns its own CORS; native routes take precedence over Hono.

Hono handles Chatroom and subscription preflights before authentication and
adds CORS headers to their responses, including errors and streams:

- Chatroom: exact `/api/aisdk/chat` path; POST/OPTIONS.
- Subscriptions: `/api/subscription/*`; GET/POST/OPTIONS.
- Both allow credentials and Content-Type/Authorization only for the origin
  of Convex's `SITE_URL`. Missing `SITE_URL` grants no cross-origin access.
- Gateway bearer-key endpoints retain their existing behavior without a CORS
  middleware policy. CORS does not replace endpoint authentication.

These routes run on the Convex site, not a separate Hono server. There is no
persisted-data migration or new protocol compatibility from this refactor.
Local routing/CORS/streaming regressions can be run with:

```bash
bun run --cwd packages/backend test src/http src/subscriptions
```

Live provider streaming and browser cookie behavior require a configured
deployment; local tests do not verify upstream availability.
