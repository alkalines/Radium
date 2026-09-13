# Local Observability Follow-Up

Status: Not started. Builds on the implemented [logging foundation](../logging.md).
Coordinate telemetry boundaries with task 01 and ownership with task 03.

## Entry Points

Under `packages/website/`: `src/utils/logging/contract.ts`, `src/utils/logging/server.ts`,
`src/lib/logging.ts`, `convex/logging.ts`, `convex/components/logging/`, and existing
telemetry tables/functions. Operational events currently have no pruning or read UI.

## Work

1. First add local integration coverage for authenticated ingestion, revoked/expired sessions, actor spoofing, bounded payloads, transactional rate limits, component isolation, and primary-operation failure isolation. Existing foundation tests are unit tests, not proof of those integration behaviors.
2. Design configurable retention and bounded scheduled pruning for events and limiter state as needed. Define authorized read/delete/export operations and storage budgets before enabling high-volume instrumentation.
3. Define product namespaces and a small event catalog; evolve the shared versioned envelope rather than copying contracts. Browser event fields and timestamps remain untrusted; server identity/receipt time are authoritative.
4. Keep operational logs, opt-in request/audit capture, and analytics distinct. Plan local aggregate metrics and evaluate the Aggregate component. No required PostHog, SaaS collector, or default prompt/response capture.
5. Split retention, read UI, and analytics into separate implementation sessions. Update `docs/logging.md` as each lands; add `docs/Radium_Gateway/Auditing.md` only when addressing audit policy, linked from the product overview and docs index.

## Acceptance

- Initial session delivers executable local ingestion tests or clearly records the harness blocker and a bounded setup task.
- Later retention work proves batch bounds, access control, recovery, and privacy; analytics distinguishes usage estimates from billing.
- No claim of tamper-evident audits, complete analytics, or automatic retention in the current foundation.
