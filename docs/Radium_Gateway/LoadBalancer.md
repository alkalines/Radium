# Gateway Routing

Gateway routing chooses which workspace provider serves each completion, retries failures on other providers, and cools down failing providers. The policy follows [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (`routing`, `request-retry`, `cooldown`, and request-scoped error rules); the comparison and the longer-term design live in the [auto-routing research](../research/Gateway_Auto_Routing.md). Gateway API completions and Chatroom share this path.

## Implemented

The schedulable unit is a workspace provider: one enabled provider configuration with stored credentials that offers the requested model. Several accounts of the same provider are not representable yet; add a second custom provider for another key until credential pools land.

### Selection

1. Eligibility: the provider offers the model, is enabled, has credentials, matches the request's `provider` preferences, and has no active cooldown for the provider or for this model.
2. Priority: only the highest priority tier with an eligible provider is considered. Lower tiers serve only when every higher-priority provider is blocked or already tried in the current round.
3. Strategy inside the tier, per workspace and model:
   - `round-robin` (default): the next provider after the last pick in slug order; tracking the last provider instead of an index keeps rotation stable when a provider drops out.
   - `weighted-round-robin`: nginx smooth weighted round-robin on provider weights; weight 0 excludes a provider.
   - `fill-first`: the first provider in slug order until it is blocked.

The cursor is one `routing_cursors` document per workspace and model, updated in the same `routing.pick` mutation that reads it, so concurrent requests never reuse a stale position.

### Session affinity

Off by default. When enabled, a conversation is bound to the provider that first served it for `sessionAffinityTtlSeconds` (sliding, default 1 hour), regardless of priority or weight, while that provider stays eligible. The session key is the first of:

1. Chatroom chat ID (server-derived).
2. `X-Claude-Code-Session-Id`, Codex `session-id`/`session_id`, `X-Session-ID`, `X-Session-Affinity`, `X-Conversation-Id`, `X-Thread-Id` headers.
3. Body `session_id`, `prompt_cache_key`, then deprecated `user`.
4. A hash of the first 100 bytes of the system prompt, first user message, and first assistant message. Later turns also look up the first turn's hash, so a binding made before the assistant reply carries over.

Bindings are keyed by session and model. `X-Parent-Session-ID` (or `X-Claude-Code-Parent-Agent-Id`) marks a subagent: an unbound child inherits the parent's provider when `sessionAffinitySubagents` is on, without extending or moving the parent's binding.

`sessionAffinityRebindOn` decides what a failure does to a binding:

- `any` (default): any provider failure removes the binding; the provider that succeeds next is bound.
- `quota`: transient failures (408, 5xx, empty streams, transport errors) fail over for that request only and keep the binding; quota, auth, payment, not-found, and model-unsupported failures move it.

### Failures and cooldowns

Each attempt outcome is reported to `routing.reportResult`. Cooldowns are stored in `routing_cooldowns`, provider-wide (`model` is empty) or for one model:

| Upstream result                          | Cooldown                                                                                               | Scope                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 429                                      | `max(Retry-After or reset, 10 s)`; otherwise exponential 1 s → 30 min, escalating once per open window | Model; provider-wide for plan-limit bodies (`usage_limit_reached`, `insufficient_quota`) unless the provider uses model-level cooling |
| 401, missing API key                     | 30 min                                                                                                 | Provider                                                                                                                              |
| 402, 403                                 | 30 min                                                                                                 | Provider                                                                                                                              |
| 404, model not found                     | Reset or 12 h                                                                                          | Model                                                                                                                                 |
| 408, 500, 502–504, 520–526, empty stream | Reset, or `transientErrorCooldownSeconds` (0 = 60 s, -1 = none)                                        | Model                                                                                                                                 |
| Other statuses                           | 60 s                                                                                                   | Model                                                                                                                                 |
| 400, 413, 422                            | None; returned to the caller without failover                                                          | —                                                                                                                                     |
| Transport errors                         | None; failover continues                                                                               | —                                                                                                                                     |

Reset deadlines come from `retry-after-ms`, `Retry-After`, rejected `anthropic-ratelimit-unified-*-reset` windows, and `resets_at`/`resets_in_seconds` error bodies; deadlines more than 7 days and 1 hour away are ignored. Later failures only extend a cooldown. A success clears model cooldowns and expired provider-wide cooldowns, but only when the attempt was dispatched after the cooldown was recorded. `disableCooling` (workspace) or the provider's `disableCooling` turns cooldowns off. Rows are pruned 24 hours after they expire; expired session bindings are pruned every 10 minutes.

Owners can add error rules per provider: an exact status plus body substrings or regular expressions, with action `stop` (return the error), `continue` (try the next provider), or either with `-and-cooldown`. Rules run before the status classes above.

### Retries

Each round tries untried eligible providers, up to `maxRetryCredentials` per round (0 = all). After a round that ended on a retryable failure (403, 408, 429, 5xx, transport, empty stream) or with every provider cooling, the next round waits for the soonest cooldown if it ends within `maxRetryIntervalSeconds`, with jitter. At most `requestRetry` extra rounds run. Aborted requests stop immediately.

Streaming commits on the provider's first payload. Failures before it fail over; failures after it are recorded for cooldown and sent to the client as an SSE `data: {"error": …}` event without `[DONE]`. Non-streaming requests fail over only when the failed attempt produced no output. Failed attempts are not recorded as completions. When routing gives up, the response uses the last upstream status and an OpenAI-style error body with the provider slug; exhaustion caused only by cooldowns returns 429 with `Retry-After`.

### Request preferences

`provider` accepts a slug (pin, no fallbacks) or an OpenRouter-compatible object: `only`, `ignore`, `order`, `allow_fallbacks`, and `sort` (`price`, `throughput`, `latency`, or `{ by }`). `order` places listed providers above every owner priority in list order; `allow_fallbacks: false` drops unlisted providers. `sort` ranks providers by model pricing or by throughput and TTFT averaged over the workspace's last 200 completions. Unknown values rank last. Session bindings still win while the bound provider remains eligible.

### Configuration

Owners edit everything in **Gateway > Routing**: workspace strategy, session affinity, retry, and cooling settings; each provider's priority, weight, cooling overrides, and error rules; and active cooldowns with a reset action. Backend functions: `routing.getConfiguration`, `routing.setSettings`, `routing.setProviderRouting`, `routing.resetCooldown` (owner-only). Settings are stored in `workspace_settings.routing` and `workspace_configurations.routing`; absent values mean the defaults above.

## Limitations

- One credential per provider; credential pools are separate work.
- Quota and usage-limit data only exclude providers through cooldowns; nothing ranks providers by remaining quota (same as CLIProxyAPI). Pacing is a proposal in the research doc.
- Bindings target a provider, not a cache domain, and their lifetime is the configured TTL rather than the upstream cache lifetime.
- Cache hints are not forwarded upstream yet (`prompt_cache_key`, OpenRouter `session_id`).
- `pick` and `reportResult` add two mutations per attempt; the per-model cursor is a single document, so very high request rates on one model contend on it.

## Verification

```bash
bun run test
bun run --cwd apps/web vite:build
```

`src/routing/policy.test.ts` covers strategies, cooldown classes, session keys, and preferences; `convex/routing.test.ts` covers selection, cooldown fencing, affinity rebinding, and owner configuration with `convex-test`; `src/http/handlers.test.ts` covers streaming failover, post-output failures, and request-invalid errors. These are offline checks, not deployment verification.
