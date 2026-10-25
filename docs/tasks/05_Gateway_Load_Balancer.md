# Gateway Load Balancer

Status: First slice implemented (2026-10-25): CLIProxyAPI-style routing across workspace providers. See [Gateway routing](../Radium_Gateway/LoadBalancer.md). Remaining work depends on task 04's credential pools.

## Entry Points

Under `packages/backend/`: `src/routing/`, `convex/routing.ts`, `convex/providers.ts`
(`resolveRoutableProviders`), and `src/http/chat_completion.ts`; UI in
`apps/web/src/components/gateway/routing-panel.tsx`.
Design background and proposed next policies: [auto-routing research](../research/Gateway_Auto_Routing.md).

## Done

- Eligibility (model, enablement, credentials, request preferences, cooldowns) separated from selection (priority tiers, round-robin, smooth weighted round-robin, fill-first).
- Session affinity, cooldown classes with upstream reset parsing, error rules, bounded retry rounds, pre-output failover, and abort handling; failed attempts are not recorded as completions.
- Owner configuration UI and offline tests for strategies, cooldowns, affinity, failover before/after output, and request-invalid errors.

## Remaining

1. Schedule individual credentials once task 04 adds credential pools (per-credential priority, weight, and cooldowns; N subscription accounts).
2. Concurrency limits per provider and attempt timeouts; neither exists yet.
3. Forward cache hints upstream (`prompt_cache_key`, OpenRouter `session_id`) and bind sessions to cache domains with the upstream cache lifetime.
4. Quota-aware pacing and live usage ingestion, as proposed in the research doc.
5. Correlate attempts in local observability; outcomes currently live only in routing state and logs.

## Acceptance

- Deterministic tests cover multi-account and multi-server pools (pending credential pools), exhausted capacity, cancellation, cooldown expiry, zero eligible upstreams, and failures before/after stream output.
- Concurrent requests do not exceed the defined capacity policy; avoid a global hot record.
- Attempts and outcomes are correlated using local observability without recording credentials/content or double-counting usage.
- No second Chatroom router, unbounded retries, or unrelated protocol expansion.
