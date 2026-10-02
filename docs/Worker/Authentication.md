# Worker Authentication And Connectivity Research

Research snapshot: **2026-10-01**. Status: **proposal, not implemented**.
Transport follow-up: the 2026-10-02 [Convex Client plan](Convex_Transport.md)
supersedes the WSS/Tailscale recommendation and transport-specific verification
slice below. Enrollment/key identity research remains relevant; all interactive
traffic is now planned through Convex, with machine JWTs and app authorization.
Naming follow-up: the service is now **Worker**. This research snapshot uses
"Runner" in its original protocol discussion. The standalone HTTP client was
removed in favor of app-owned Convex queries/mutations and authenticated wrappers.
Implementation follow-up: the [Worker identity component](Component.md) now owns
the enrollment/identity persistence subset in `packages/worker-component`.
The protocol, app authorization and cryptographic verification below remain proposed.
See the [Worker overview](../Worker.md) for the health service and identity component
and [task 06](../tasks/06_Chatroom_Worker.md) for the wider execution boundary.

## Recommendation

Keep token-based setup, but make the token a **single-use enrollment credential**,
not a permanent shared execution password. Enroll a **separate asymmetric identity
for each runner**. For interactive ACP sessions, use a **Runner-hosted WSS endpoint
reached through operator-configured Tailscale Serve or optional Funnel**, with
Convex owning low-frequency authorization,
session coordination and durable checkpoints. See
[interactive connectivity](Connectivity.md) for the revised transport recommendation.
The original short-polling baseline was superseded by the cloud-cost and ACP
requirements; polling is only an explicit fallback for sparse background work.
Prefer proof-of-possession for connection admission and signed HTTPS control
requests. Use transactional job leases and a durable local journal independently
of authentication.

Tailscale supplies NAT traversal and network relay fallback without a custom Radium
relay. The Runner application endpoint still needs implementation. Private Serve
requires browser tailnet reachability; optional Funnel exposes a public endpoint.
Keep ordinary authenticated HTTPS/WSS usable over other operator-configured networks
so Tailscale is not a required hosted dependency. Authentication cannot create
connectivity by itself.

Connect to the **application's control plane** hosted on Convex for durable state,
not for every live frame. Never give the Runner deployment/admin credentials or
access to general browser APIs. A narrowly scoped Convex SDK subscription can
deliver control changes without idle polling; it is not a raw ACP message bus.

## Current Source And Constraints

- `packages/worker/src/index.ts`: public health endpoint only.
- `packages/worker-component/src/component/`: enrollment/identity persistence;
  no standalone HTTP client or app authentication wrappers.
- `packages/backend/convex/http.ts` and `packages/backend/src/http/router.ts`:
  existing Hono/Convex HTTP bridge, with Better Auth registered separately.
- `packages/backend/convex/convex.config.ts`: Better Auth, rate limiter,
  migrations, logging, and Secret Store are already mounted.
- `packages/backend/package.json`: Convex range `^1.46.0`, Better Auth `1.6.33`,
  adapter `^0.12.5`, and direct `convex-helpers` `0.1.124`.
- Workspace owner/member and private-chat policy already belong to the app.
  Runner identity must not become a Better Auth user, Gateway API key, or legacy
  balance identity. One runner belongs to one workspace initially; multiple runners
  per workspace are supported by the proposed shape.

## Connectivity Options

| Pattern                            | Applicability                                                     | Assessment                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Convex pushes HTTPS to Runner      | Runner has a reachable endpoint or VPN                            | Simple request/response, but requires inbound exposure, endpoint/egress policy, and two-direction authentication. Poor default for NAT.                                                                      |
| Runner polls Radium HTTP API       | Runner can reach Convex HTTP surface                              | Optional sparse-work fallback, not the interactive default. Idle polling adds calls even with no work.                                                                                                       |
| Runner uses Convex reactive client | Outbound WebSocket allowed                                        | Good low-latency option with a dedicated machine JWT issuer and tightly authorized wrapper functions. Notifications are hints; a mutation must still claim work.                                             |
| Tailscale Serve / optional Funnel  | Private tailnet clients / ordinary internet browsers respectively | Preferred deployment profile. Browser connects to Runner WSS through existing infrastructure; live frames bypass Convex. Tailscale supplies network relay fallback, not ACP storage or Radium authorization. |
| VPN plus HTTPS/mTLS                | Operator controls both networks                                   | Useful optional transport, not a substitute for per-runner/workspace permissions. No required hosted VPN provider.                                                                                           |

Convex HTTP actions accept Fetch `Request`/`Response` and call mutations for
database work. They are not an application-owned indefinitely running WebSocket
server. Use the supported reactive client protocol for control subscriptions and a
Runner-hosted WSS endpoint for custom persistent channels. Keep interactive ACP traffic on that external
data path, not a polling loop inside a long-running action. Bound request sizes and batch output; validate actual
self-hosted backend/proxy timeouts rather than assuming Cloud limits apply.

## Authentication Concepts

| Concept                                          | What it solves                                                               | Cost / decision                                                                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unique opaque bearer per runner over TLS         | Straightforward machine identity; hashed storage, expiry, revocation, scopes | Viable simpler profile. A copied token works without the original machine; rotating it does not prevent current-token theft. Avoid one global Runner token.                                                                    |
| HMAC-signed requests                             | Integrity and replay controls without bearer transmission                    | Both sides hold the same secret; a verifier compromise can mint valid messages. Requires canonicalization and nonce storage. Less attractive than public-key verification for this boundary.                                   |
| RFC 9421 HTTP Message Signatures                 | Possession of a runner private key and binding to exact request              | Preferred hardened HTTP profile. Needs a reviewed implementation, explicit covered fields, replay policy, and transactional enforcement. It is not an enrollment or authorization system by itself.                            |
| OAuth client credentials / `private_key_jwt`     | Standard service token issuance and client authentication                    | Useful with an existing self-hosted issuer. `private_key_jwt` authenticates the token request; ordinary issued bearer tokens remain stealable. Adds issuer/rotation/availability dependencies.                                 |
| DPoP (RFC 9449)                                  | Binds OAuth access tokens to a client key                                    | Strong option if OAuth interoperability is needed. Per-request proof, `ath`, `jti`, nonce and audience validation still required; DPoP does not sign the request body.                                                         |
| mTLS / certificate-bound OAuth tokens (RFC 8705) | Mutual transport identity; optionally token-to-certificate binding           | Excellent for operator-managed infrastructure. Usually terminates at a self-hosted proxy; do not assume a Convex HTTP handler receives a trusted client certificate. PKI issuance/renewal and proxy trust are additional work. |
| SPIFFE/SPIRE                                     | Automated short-lived workload identities and attestation                    | Suitable for a managed fleet. Too much mandatory infrastructure for a single self-hosted Runner; keep optional.                                                                                                                |

Do not combine every mechanism. For Radium's standalone baseline, choose one
versioned proof-of-possession HTTP profile. Add OAuth/DPoP or mTLS integration only
when operator requirements justify it. A JWT alone is not proof of possession or
immediate revocation. Do not mint a Convex deployment key for a runner.

## Proposed Enrollment And Trust Flow

1. A workspace owner authenticates through **Better Auth session validation** and
   creates an enrollment record. Generate at least 32 random bytes; store only its
   hash, workspace, expiry, allowed capabilities, and consumed/revoked state.
   A short expiry such as 10 minutes is a proposed default, not a standard limit.
2. Runner setup receives the control URL and token through a protected input/file,
   not a URL query parameter. Verify HTTPS hostname and CA; support a configured
   private CA, never a production `skip TLS verification` switch. TLS authenticates
   the control endpoint to the Runner. Operators must trust that endpoint to dispatch
   work within the Runner's locally allowed capabilities.
3. Runner generates and durably stores its private key **before enrollment**. Prefer
   an OS-protected file/keystore, outside executed workloads and their environment.
   Candidate algorithms are P-256/ES256 or Ed25519; choose one after verifying
   WebCrypto/Bun/Convex runtime and the signature library, not by implementing crypto.
   Convex's built-in custom JWT verifier currently supports RS256/ES256, which is a
   separate constraint from an HTTP signature verifier.
4. An enrollment challenge binds deployment identity, token record, public-key
   thumbprint, and enrollment request ID. Runner proves possession of that key.
   One mutation atomically consumes enrollment and registers the identity. Token
   possession alone is enrollment authority: a stolen unused token can win the race.
   An optional owner fingerprint confirmation or pre-bound public key protects
   higher-assurance deployments against that bootstrap risk.
5. Persist the successful enrollment mapping. If the response is lost, the same key
   can prove possession and recover its runner ID; it cannot enroll a second runner
   or change workspace. Expired/revoked tokens cannot create a fresh enrollment.
   Do not design one-use consumption that permanently strands a successful setup
   after an ordinary network timeout.
6. Normal operations authenticate the enrolled key, derive runner/workspace on the
   server, and enforce capabilities plus job assignment. A runner can claim eligible
   jobs, renew its own lease, and report its own attempts; it cannot browse chats,
   retrieve upstream credentials, configure workspaces, or create arbitrary jobs.
7. Rotation registers a new key with proof from the existing and new keys, supports
   a bounded overlap, then retires the old key after acknowledgment. If the old key
   is compromised/lost, the owner revokes and re-enrolls instead. Revocation advances
   an identity epoch and invalidates sessions/leases as policy requires.

A live Runner connection authenticates the client using a fresh challenge and an
identity-bound, Runner-audience-scoped connection grant. Check scoped permissions locally
for every frame; do not persist a Convex nonce or re-read Convex for each frame.
The Runner watches revocation/control state and bounds stale authority with expiring
grants and fail-closed revalidation. This is bounded revocation propagation, not
an assertion of instantaneous revocation during a partition. Signed HTTPS control
operations still check current runner/key status transactionally. See
[connection security](Connectivity.md#connection-security-and-revocation).

### Signed HTTP Profile And Replay

Use RFC 9421 canonicalization, not ad hoc concatenated JSON signatures. Cover the
method, agreed target URI/authority/path, body `Content-Digest` (RFC 9530), content
type, deployment audience, operation request ID, and signature parameters including
key ID, creation/expiry, and nonce. Hash the exact transmitted body bytes and verify
that digest. Reject duplicate/ambiguous headers and unrecognized algorithms/keys.
The profile must specify URI handling behind proxies so normalization does not
silently change what is authenticated. Do not follow cross-origin redirects with
credentials or signatures.

Cryptographic verification in an HTTP action is only the first check. The mutation
must re-check current key status/epoch, authorize the operation, and atomically
record a nonce/request ID with the state transition. A precheck followed by an
unrelated mutation permits replay races and revocation races. An internal call can
carry the verified key ID/epoch and request digest; this must never be an exposed
client argument accepted as proof.

Separate **replay rejection** from **operation idempotency**. Retrying with a fresh
signature/nonce and the same operation ID returns the previously committed outcome.
The same operation ID with a changed body is rejected. Bound records per runner,
index by runner/request ID and expiry, and retain through the full acceptance/retry
window. Time validation requires bounded clock skew; offer a server challenge/time
exchange for recovery rather than widening the replay window indefinitely.

TLS provides control-plane identity for the baseline. If jobs travel through an
untrusted relay or must be verifiable after storage, add control-plane-signed job
envelopes bound to deployment, runner, workspace, capability, job/attempt, payload
digest, expiry, and approval version. That requires its own signing-key lifecycle;
a runner signature only authenticates the runner-to-control direction.

## Reliability Is A Separate Contract

- Claim a bounded number of jobs atomically using indexed eligibility. Issue an
  attempt ID, lease expiry and monotonically increasing fencing value. Renewal,
  output, result and cancellation acknowledgments match runner, job and attempt.
- Maintain a durable Runner journal before starting a side effect, plus bounded
  output spool with event sequence numbers and acknowledged cursors. Reconnect
  resumes uploads; duplicate results/events are idempotent.
- Leases/fencing stop stale database writes, **not an already running shell process**.
  Stop new work when control/lease authority is lost. Define best-effort process
  termination separately; commands may already have produced irreversible effects.
- Do not automatically redispatch an ambiguous non-idempotent command after a
  runner crash or lease timeout. Mark the attempt `unknown` and reconcile. A local
  journal cannot guarantee exactly-once execution across a crash between the side
  effect and durable completion.
- Retry transient transport errors with exponential backoff and jitter; respect
  `Retry-After`, cap concurrency and queues. Authentication failures trigger bounded
  clock/key recovery, not endless fast polling. Offline runners are unavailable,
  not silently replaced for every job.
- Bind approval to the authorized chat/user, exact payload digest, runner/workspace,
  and policy version. Re-check permission before dispatch. Owner management of a
  runner must not expose another user's private chats or execution output.
- Enrollment/auth/control records contain metadata, not credentials, command
  transcripts or file contents in logs. Output storage needs its own access,
  retention, size and backpressure policy. Runner-local confinement and secret
  isolation remain part of the execution design.

## Existing Convex Components Evaluated

The full [catalog](https://www.convex.dev/components/llms.txt) was fetched on the
research date. These are candidates, not audited/adopted dependencies.

| Candidate                                                                                               | Evidence and fit                                                                                                                                                                                                                                                                              | Decision                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`convex-invite`](https://www.convex.dev/components/convex-invite)                                      | 0.1.1; Apache-2.0; inspected package and integration README. Peer `convex >=1.43.0`, direct helpers `0.1.124`, test export/script. Documents 256-bit hash-only tokens, audience binding, single-use acceptance, transactional host grants, idempotent acceptance results and bounded pruning. | Strongest enrollment-lifecycle candidate. Evaluate a machine-key thumbprint as the verified audience and runner ID as the acceptance result. No machine proof verification, key rotation or request authentication. This is runner enrollment, not a change to workspace membership. |
| [`@vllnt/convex-api-keys`](https://www.convex.dev/components/vllnt/convex-api-keys)                     | Catalog 0.2.0; repository main 0.2.1. MIT; inspected main package, hashing and mutations. Main peer `convex ^1.45.0` accommodates this app's range; sharded-counter subcomponent; test files and test export exist. Has SHA-256 storage, finite-use keys, revoke, overlap rotation.           | Best focused candidate for an opaque bearer/bootstrap profile. Does not supply proof-of-possession, enrollment recovery, runner authorization or jobs. Audit the exact release before adoption.                                                                                      |
| [`@00akshatsinha00/convex-api-keys`](https://www.convex.dev/components/00akshatsinha00/convex-api-keys) | Catalog 0.1.0; documents hashing, RBAC, rotation, quotas, analytics and verification logging.                                                                                                                                                                                                 | Broader coupled scope than needed, including credits. Not selected; license/peers/source and tests not independently audited in this research.                                                                                                                                       |
| [`@akshatgiri/convex-orchestrator`](https://www.convex.dev/components/akshatgiri/convex-orchestrator)   | 0.1.5, Apache-2.0; main package peer `convex ^1.31.6` and React peer, test script. External workers pull with leases/heartbeats; README says side effects are at-least-once.                                                                                                                  | Closest connectivity/coordination reference. Explicitly lacks built-in worker auth, cancellations and production hardening; not the secure Runner solution. Do not copy unprotected `exposeApi` examples.                                                                            |
| [`@codefox-inc/oauth-provider`](https://www.convex.dev/components/codefox-inc/oauth-provider)           | Catalog 0.4.2 beta; documents authorization-code + PKCE, refresh rotation and Better Auth integration.                                                                                                                                                                                        | Consider for third-party OAuth/MCP needs. Documented grants do not establish client credentials, RFC 8705 or DPoP support. Not evidence of a machine-identity solution; license/peers/tests not audited here.                                                                        |
| Existing Better Auth component                                                                          | Supported-plugin docs omit API Key and Device Authorization from the out-of-box list; schema-changing plugins may need local install.                                                                                                                                                         | Retain for human owner enrollment/revocation. Do not assume runner/device plugins are drop-in with the installed adapter.                                                                                                                                                            |
| Official Rate Limiter                                                                                   | Already installed; transactional application quotas.                                                                                                                                                                                                                                          | Reuse for enrollment/challenge/authenticated control. Add proxy/network limits for unauthenticated floods; not a DDoS shield.                                                                                                                                                        |
| Official Workpool / Workflow / Action Retrier                                                           | Durable Convex-side orchestration and retries.                                                                                                                                                                                                                                                | Optional later orchestration. They neither authenticate external workers nor make arbitrary execution exactly-once. No automatic retry of side-effecting dispatch.                                                                                                                   |
| `convex-helpers` Hono / customFunctions                                                                 | Direct dependency; existing HTTP bridge and app auth wrappers.                                                                                                                                                                                                                                | Reuse adapter and appropriate wrappers. Stateless convenience, not runner credential persistence or identity verification.                                                                                                                                                           |

The inspected VLLNT main at commit
[`9b260a848958c75e80fe6684899f33af538a6865`](https://github.com/vllnt/convex-api-keys/tree/9b260a848958c75e80fe6684899f33af538a6865)
generates 32-byte secrets, hashes full keys, and decrements finite-use counters in
`validate`. Validation writes a usage counter and logs successful validation;
lookups use a prefix index with `.collect()`, and bulk revocation collects all
matching owner keys. Assess contention, log volume, collision bounds and paginated
cleanup. Its JavaScript equality loop is not a demonstrated runtime timing guarantee.
Creation/rotation returning raw secrets once still needs lost-response recovery.
If used for enrollment, validation/consumption and runner registration must be
called from the **same parent mutation**, not two HTTP-action mutation calls.
Tests were located, not executed, and no independent security audit is claimed.

These components operate in Convex without requiring a separate hosted key service
in their documented model; this is not verification against a self-hosted deployment.
None of the inspected candidates covers the complete proposed hardened protocol.

## Proposed Local Component Shape

A component is justified for **reusable isolated enrollment/identity/replay state**,
not merely as a place to put HTTP middleware. Start with a `workerIdentity`
component; keep execution/job persistence separate until task 06 defines that
contract. Avoid a generic auth framework or an abstraction supporting every scheme.

The initial persistence implementation uses the workspace package below. The app
wrappers and Worker execution pieces remain proposed. Challenges, request admission
and rotation are deferred; see the [implemented component contract](Component.md).

```text
packages/backend/src/worker/                 runtime-neutral versioned wire contracts (planned)
packages/backend/src/http/worker.ts          optional HTTP parsing/signature verification (planned)
packages/backend/convex/workers.ts           app policy and authenticated query/mutation wrappers (planned)
packages/worker-component/src/component/
  convex.config.ts
  schema.ts
  enrollment.ts                             enroll/recover/revoke
  identities.ts                             key lifecycle and current status
  requests.ts                               transactional replay/idempotency admission
packages/worker/src/                         key store, Convex subscriptions, local execution journal (planned)
```

Proposed component tables (app IDs cross the boundary as strings):

| Table         | Records / indexes                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrollments` | Workspace, token hash, capabilities, expiry, consumed key thumbprint/request ID and runner ID. Index token selector/hash and expiry.        |
| `runners`     | Workspace, status, identity epoch, allowed capabilities, coarse last-seen. Index workspace/status; runner ID lookup.                        |
| `keys`        | Runner, public key, algorithm, thumbprint, validity, retirement/revocation. Index runner/status and thumbprint. No private keys.            |
| `challenges`  | Enrollment/key context, nonce, expiry, consumption. Indexed bounded expiry cleanup.                                                         |
| `requests`    | Runner, operation ID, request digest, nonce, expiry and bounded committed receipt. Index runner/operation and runner/nonce, expiry cleanup. |

App-facing internal operations: `createEnrollment`, `completeEnrollment`,
`recoverEnrollment`, `getVerificationKey`, `admitRequest`, `registerRotation`,
`retireKey`, `revokeWorker`, and bounded metadata listing/cleanup. Precise names,
schemas and return validators are implementation deliverables, not existing APIs.
`admitRequest` participates in the same parent mutation as the authorized operation;
do not commit a replay record and then lose the job transition in another transaction.

**App responsibilities:** Better Auth owner validation, current workspace/chat/job
authorization, HTTP mounting, trusted principal derivation, rate-limit context,
signature verification and configuration. Components do not inherit application
auth or table access. Wrappers pass server-derived identity, key epoch and digest;
never trust a caller's workspace ID or `verified: true` field. App policy controls
which capabilities owners may grant; runner-local policy can further narrow them.
Configuration stays in app wrappers in this design; current Convex also supports
explicitly declared/mapped component environment variables, not inherited app env.

If the first slice chooses only bearer credentials, evaluate the VLLNT component
before writing duplicate key lifecycle code, and keep runner metadata/policy in
the app. For proof-of-possession, its bearer storage adds little to public-key
identity state; a small local component is a clearer owner. Do not build two
parallel credential stores for the same identity.

Before implementing the proposed `enrollments` table, evaluate `convex-invite`
against machine audiences and lost-response recovery. If it fits, compose a
separate named mount for enrollment and let it own token lifecycle/acceptance
receipts, while `workerIdentity` owns keys and request admission. Its documented
host-grant transaction can register the runner atomically. The app must verify
key possession before supplying `acceptedBy`/`audienceRef`; the package's user/email
examples are not machine authentication. If proof-bound recovery cannot fit its
API, record that mismatch and keep enrollment in the local identity component.

## Implementation Gates And Verification

1. Choose a single profile and reviewed RFC 9421 implementation; verify crypto,
   signature canonicalization and body hashing in Bun and the actual Convex runtime.
   Specify URL/proxy handling, clock skew, retry windows and retention bounds.
2. Implement **enrollment + authorized WSS connection only**, with a Runner-generated
   key, transactional single-use consumption, lost-response recovery and owner
   revoke. Use the Tailscale connectivity profile and keep heartbeat/liveness frames
   in Runner connection state rather than persisting each
   one in Convex. No arbitrary shell endpoint in this slice.
3. Tests: non-owner creation/revoke; cross-workspace and archived-workspace denial;
   expired/consumed token; concurrent enrollment/replay; wrong key/body/URI/audience;
   revoke between signature check and commit; response loss; clock skew; rotation
   acknowledgment loss; no secret logging. Check that replay receipt access is also
   scoped to the same runner and operation.
4. Run a local integration across separately networked processes with TLS/private
   CA, proxy routing, blocked inbound Runner ports and reconnect. Test backend and
   Runner restart plus pending enrollment recovery. No deployment/admin key in Runner.
5. Design execution confinement and approval-bound jobs separately. Then test claim
   contention, stale attempts, ambiguous crash outcomes, cancellation, output limits
   and private-chat visibility. Passing a build is not these behavior tests.

This research installed no dependencies, ran no remote codegen/migrations, and
made no deployment changes. Runtime/library adoption and execution isolation are
still unverified.

## Sources

- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions),
  [custom JWTs](https://docs.convex.dev/auth/advanced/custom-jwt),
  [limits](https://docs.convex.dev/production/state/limits), and
  [component authoring](https://docs.convex.dev/components/authoring).
  Consulted current official docs through Context7 and direct pages. Current Cloud
  limits pages differ on HTTP request-size wording; apply explicit smaller limits
  and verify the intended backend version rather than relying on that discrepancy.
- [Better Auth supported plugins](https://labs.convex.dev/better-auth/supported-plugins).
- [Convex Components catalog](https://www.convex.dev/components/llms.txt) and
  [convex-helpers](https://github.com/get-convex/convex-helpers).
- [VLLNT package/source](https://github.com/vllnt/convex-api-keys),
  [Invite package/source](https://github.com/dciccale/convex-invite),
  [external-worker orchestrator](https://github.com/akshatgiri/convex-orchestrator),
  [OAuth provider](https://github.com/codefox-inc/convex-oauth-provider).
- [RFC 9421: HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421),
  [RFC 9530: Digest Fields](https://www.rfc-editor.org/rfc/rfc9530),
  [RFC 9449: DPoP](https://www.rfc-editor.org/rfc/rfc9449),
  [RFC 8705: OAuth mTLS](https://www.rfc-editor.org/rfc/rfc8705),
  [RFC 7523: JWT client authentication](https://www.rfc-editor.org/rfc/rfc7523).
- [RFC 6750: Bearer tokens](https://www.rfc-editor.org/rfc/rfc6750),
  [RFC 9700: OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700), and
  [RFC 9110: retry/idempotency](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2).
- [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe-about/overview/).
