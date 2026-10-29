# Gateway Usage Limits

Each pooled [credential](Credentials.md) keeps a snapshot of its upstream usage limits and balances, shown to owners in **Gateway > Limits** and on credential rows, and turned into limit events when thresholds are crossed. Limits never affect routing: cooldowns remain the only quota effect ([Gateway routing](LoadBalancer.md)). The design and upstream signal survey are in the [usage limits research](../research/Gateway_Usage_Limits.md).

## Implemented

### Meters

Every signal is normalized to a meter (`src/limits/meters.ts`): `id`, `label`, `scope` (`credential`, or `account` when every key of the upstream account shares it), `unit` (`percent`, `usd`, `credits`, `requests`), `used`/`limit`/`remaining`, optional `windowSeconds` and `resetsAt`, `source` (`header`, `poll`, `error`, `metered`), and `observedAt`. A meter past `resetsAt` is shown as reset until fresh data arrives.

`credential_limits` holds one row per pooled credential: meters, plan, poll state (`polledAt`, `nextPollAt`, `pollError`, failure streak), armed alerts, and expiry. Rows are created when a credential is added, on its first routed attempt, or by the owner actions below. An OAuth login may pass its plan to `bindOAuthCredential` (ChatGPT does), which seeds the row's plan until headers or polls report it; the account preview holds only the email. Credentials from before this feature are backfilled once with `bunx convex run migrations:runCredentialLimits`, which also moves the plan out of older ChatGPT previews (`email · plus plan`). Removing a credential removes its row and limit key; its events remain.

### Adapters

Provider-specific parsing lives in `src/limits/adapters/`; other providers get metered budgets only.

| Adapter    | Matches                                                            | Response headers                                                                                                                           | Error bodies                                                                                                         | Poll                                                                                                                |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ChatGPT    | `oauth_flow: "chatgpt-device"`                                     | `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at,reset-after-seconds}`, credits, plan type, extra `x-<limit>-*` families | `usage_limit_reached` (raw or inside the library's `responses_request_failed` wrapper) → exhausted until `resets_at` | `GET chatgpt.com/backend-api/wham/usage` with the session's access token and `ChatGPT-Account-Id`                   |
| OpenRouter | npm `@openrouter/ai-sdk-provider` or base URL host `openrouter.ai` | —                                                                                                                                          | 402/403 `error.metadata.limit_source`                                                                                | `GET /api/v1/key` (key limit, budgets, free-model requests); `GET /api/v1/credits` with the optional management key |

Windows are labelled by length (5-hour, Weekly, 30-day), not by primary/secondary. Extra Codex limits use Codex's limit ID (`x-codex-other-*` and `metered_feature: "codex_other"` both become `codex:codex_other:<window>`).

### Capture

- **Passive:** `createRoutedProvider` wraps the connector fetch for credentials with an adapter and reads every upstream response, plus failed bodies from a clone. For ChatGPT the wrapper is the library's raw upstream fetch (`createChatGPTHandler({ fetch })`), since its proxy drops upstream headers. Captured meters ride on the existing per-attempt `routing.reportResult`; writes are skipped when every meter moved under 1 point within 60 s and no alert or state changed.
- **Poll:** a 5-minute cron (`limits.pollDue`) claims up to 25 due credentials of enabled credentials and providers with a pollable adapter, skipping those with passive data under 10 minutes old. Failures keep the last meters, store `pollError`, and back off 5 minutes doubling to 1 hour. ChatGPT tokens are exported from the library only inside the poll action (`getChatGPTTokens`); they never reach a client.
- **Refresh:** owners poll one credential immediately with `limits.refresh`, at most once a minute.
- **Budgets:** an owner budget (USD per UTC day, ISO week, or month) adds a `budget` meter summed from `chat_completions.response.pricing.cost` for the credential since the period start (at most 4,000 completions per recompute). Recorded completions schedule a debounced recompute; the cron rolls budgets over at period end. It counts Radium traffic only.

### Events

`recordLimitEvent` (`src/limits/events.ts`) is the single place events are created. Each `limit_events` row stores the whole payload (provider and credential identity, meter before and after, threshold, upstream status, the full snapshot, and the thresholds in force) so delivery channels need no other reads; `internal.limits.exportEvent` returns it with the workspace. Each event also notifies the workspace owner (toast in an open tab, else Web Push; see [Notifications](../Notifications.md)); email and webhooks are not implemented.

| Kind                                             | Fires when                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `limit_low`, `limit_critical`, `limit_exhausted` | A meter crosses the warn or critical percentage, or 100 %; balances without a cap alert under the low-balance amount (USD) and at 0. One event per upward crossing, at the highest level crossed |
| `limit_reset`                                    | An alerted meter re-arms: its window reset, or it fell 5 points below the threshold                                                                                                              |
| `credential_expired`, `credential_restored`      | A routed attempt returns 401, or a poll returns 401/403; the next success restores it                                                                                                            |
| `poll_failed`                                    | Once per poll failure streak                                                                                                                                                                     |

Thresholds default to warn 80 %, critical 95 %, low balance $5 and are stored in `workspace_settings.limits`. Events older than 30 days are pruned hourly.

### API

Owner-only functions in `convex/limits.ts`: `list` (every pooled credential with meters, plan, poll state, budget, and limit-key preview), `refresh` (action), `setBudget`, `setLimitKey` (adapters that declare one; OpenRouter's management key is stored as its own secret `<credential>:limit-key` and never used for inference), `getSettings`, `setSettings`, `listEvents`.

### Interface

- **Gateway > Credentials:** each credential row shows its plan as a tag and its two tightest meters; the tooltip adds every meter, when the data is from, and the poll error. The edit form sets the budget and, for OpenRouter, the management key.
- **Gateway > Limits:** credentials grouped by provider with plan tag, one "Updated … from …" line per credential (its newest upstream meter), every meter with reset countdown, poll error, and Refresh; the threshold settings; and recent events (read-only).

## Limitations

- Legacy credentials without a row ID are not tracked until the ownership migration copies them.
- `wham/usage`, `x-codex-*`, and the OpenRouter budget and `limit_source` shapes are verified against Codex CLI source and OpenRouter docs with fixtures, not against live upstreams. `wham/usage` is undocumented and may change.
- Per-minute rate-limit headers (OpenAI, Anthropic, Groq) are not tracked; budgets are the only option for those providers.
- Usage outside Radium shows up only through upstream signals; budgets cannot see it.
- Events reach only the workspace owner, through [notifications](../Notifications.md); email and webhook delivery are not implemented.

## Verification

```bash
bun run test
bun run --cwd apps/web vite:build
```

`src/limits/adapters/*.test.ts` covers header, error-body, and poll parsing with recorded-shape fixtures; `src/limits/meters.test.ts` covers fractions, throttling, threshold hysteresis, and budget periods; `convex/limits.test.ts` covers owner-only access, polling and backoff, passive capture through `reportResult`, budgets, events, and cleanup with `convex-test`; `convex/migrations.test.ts` covers the backfill. These are offline checks; the schema has not been pushed to a deployment.
