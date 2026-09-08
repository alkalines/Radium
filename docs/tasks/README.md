# Future Agent Tasks

These are separate handoffs, not authorization to execute the entire roadmap in
one session. All tasks below are **not started**. The minimal operational logging
foundation is implemented separately; see [logging](../logging.md).

Give an agent one task file, ask it to inspect current source and `AGENTS.md`, and
have it update the task's status and verification evidence. If a task cannot fit
one coherent session, deliver its design or migration plan first and split the
implementation into linked follow-ups. Do not deploy or migrate remote data
without approval. Use subagents only for bounded, non-overlapping work.

| Task                                                     | Dependencies / sequencing                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [01 Telemetry boundaries](01_Telemetry_Boundaries.md)    | Can proceed independently; preserve current schema.                            |
| [02 Convex auth reuse](02_Convex_Auth_Reuse.md)          | Start with research; coordinate changes to shared auth/data functions.         |
| [03 Self-hosted ownership](03_Self_Hosted_Ownership.md)  | Design first; prerequisite for new persisted ownership contracts.              |
| [04 Upstream instances](04_Upstream_Instances.md)        | Depends on 03's agreed ownership contract, not necessarily completed backfill. |
| [05 Gateway load balancing](05_Gateway_Load_Balancer.md) | Depends on 04; do not build a second routing path.                             |
| [06 Chatroom and Runner](06_Chatroom_Runner.md)          | Security/protocol design can proceed independently; persistence follows 03.    |
| [07 Authors cleanup](07_Authors_Cleanup.md)              | Independent, but coordinate model/import changes with 04.                      |
| [08 Local observability](08_Local_Observability.md)      | Builds on logging foundation; coordinate with 01 and 03.                       |
| [09 Workspace operations](09_Workspace_Operations.md)    | Independent; fixes existing docs/build/check drift.                            |
| [10 Gateway protocols](10_Gateway_Protocols.md)          | Design after 04; implement one protocol per later session.                     |

Every task includes documentation deliverables. Link product overviews and new
subsystem guides from the [documentation index](../README.md); do not present
future behavior as implemented. Research is in [Convex reuse](../research/Convex_Reuse.md).
