# Upstream Instances And Credentials

Status: Not started. Depends on task 03's agreed ownership contract.
First session: define the model and migration, then split adapter implementations.

## Entry Points

Under `packages/website/`: `convex/providers.ts`, `convex/secrets.ts`,
`convex/chatgpt_subscription.ts`, `convex/schema.ts`, `src/utils/providers.ts`,
`src/utils/ai_balancer.ts`, and `src/components/gateway/credentials-dialog.tsx`.

## Work

1. Separate provider/protocol adapter, public model identity, upstream model mapping, endpoint, account/credential, and schedulable upstream instance. Do not tie scheduling identity to a provider brand.
2. Design for multiple independently authenticated ChatGPT accounts and multiple vLLM/Ollama endpoints, including intentionally unauthenticated local servers. Preserve supported upstream auth mechanisms; do not invent universal OAuth behavior.
3. Define enablement, capacity, capabilities, secret references, credential refresh ownership, and endpoint validation. Specify private-network access policy for self-hosted admins without enabling arbitrary-user SSRF.
4. Plan migration of existing credentials without exposing or losing secrets. Keep upstream auth separate from Radium user/API-key auth.
5. Document implemented versus proposed behavior in `docs/Radium_Gateway/Upstreams.md` and the product overview. Create follow-ups for adapters and UI rather than implementing everything at once.

## Acceptance

- Fixtures describe two accounts of one provider and two local servers serving overlapping models.
- Tests planned or implemented cover credential isolation, endpoint eligibility, model IDs, disabled instances, and refresh concurrency.
- No claim of load balancing, failover, or new protocols until task 05 or protocol-specific work implements them.
