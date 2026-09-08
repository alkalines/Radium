# Gateway Load Balancer

Status: Not started. Depends on task 04's upstream instance contract.

## Entry Points

Under `packages/website/`: `src/utils/ai_balancer.ts`, `src/utils/providers.ts`,
`convex/providers.ts`, and `convex/http/chat_completion.ts`.
Current behavior randomly chooses an eligible provider; it is not a health-aware pool.

## Work

1. Specify eligibility separately from selection, including model capability, owner, credential, endpoint, enablement, and health.
2. Agree on the first selection policy and capacity model. Implement a bounded slice with weights/concurrency limits and explicit cooldown/health behavior; split further policies into later tasks.
3. Define attempt budgets, cancellation, timeouts, retryable statuses, and safe failover. Never restart after stream output has reached the caller; account for duplicated upstream cost before retrying non-idempotent work.
4. Keep pure routing decisions outside Convex; keep durable capacity/health state with its persistence owner. Evaluate existing components for coordination, not for product-specific selection policy.
5. Write `docs/Radium_Gateway/LoadBalancer.md` alongside implementation, linked from `docs/Radium_Gateway.md`, with policy, configuration, failure behavior, and current limitations.

## Acceptance

- Deterministic tests cover multi-account and multi-server pools, exhausted capacity, cancellation, cooldown expiry, zero eligible upstreams, and failures before/after stream output.
- Concurrent requests do not exceed the defined capacity policy; avoid a global hot record.
- Attempts and outcomes are correlated using local observability without recording credentials/content or double-counting usage.
- No second Chatroom router, unbounded retries, or unrelated protocol expansion.
