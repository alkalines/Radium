# E2EE Phase 7 (Workers and ACP): shared contract

Implementation/review status and observed verification: [task 11, phase 7](11_E2EE.md#phase-7-workers-and-acp). Slice ownership below records the implementation handoff, not a separate authorization policy.

Repository: `/home/arthu/Projects/alkalines-radium`. Read `AGENTS.md` first and follow it (code placement, TSDoc, comments, no `_generated` edits, no deploys/commits). Design docs: `docs/E2EE.md`, `docs/E2EE/Keys.md` ("Workers", "Request Keys", "Trust System"), `docs/E2EE/Data.md` ("ACP", "Worker Tasks From The Built-In Agent"), `docs/tasks/11_E2EE.md` (phases 5–6 "Done" notes describe how keys/chat keys/content work now). Phase 7 line: "Setup code v2 with pairing secret, Worker encryption and signing keys and certificate, mutual pins; signed ACP commands and interaction answers; capsule-encrypted ACP frames; sealed session index (remove `search_title`); sealed Worker task requests, request-key results, sealed receipts, user-signed approvals and auto-approve grants."

Goal from the user: EFFICIENT and SAFE. Threat model: Convex is untrusted persistence and relay. A paired Worker requires user-signed authority before executing and never persists plaintext content there. The built-in loop intentionally runs in a backend action: standing Read grants delegate backend-authored reads, while privileged tools require exact-input approvals. That active action necessarily sees tool inputs and outputs.

## Decisions (taken with the user; do not relitigate)

1. **Existing (v1) Workers keep their identity.** New command `radium-worker pair` reads a *pairing code* made by the owner's browser (pairing secret + owner key, no enrollment token); the Worker generates its E2EE keys and publishes them. New Workers get the same through the v2 setup code during `setup`.
2. **Directories stay plaintext** in phase 7 (Project folders, `acp_sessions.cwd`, `aisdk_chats.agent.cwd`, `acp_agent_sessions.cwd`, `worker_presence.tempDirectory`, `worker_chat_calls.directory`): recorded as residual leakage. But the Worker takes `cwd`/directory only from user-signed data (binding, grant, approval), never from an unsigned server field.
3. **Standing tool grant expires after 7 days** (`WORKER_GRANT_TTL_MS`, revised after the PR #25 review; originally no expiry). A newer grant (`issuedAt`) for the same chat replaces it; the Worker refuses a grant older than the newest it has seen for that chat (persisted locally) or issued more than the clock skew in its future. Read uses it; Edit/Create/Bash need a per-call approval signature (also in the Code Mode approval path). Grants list tools, so a future autonomous agent can extend them.
4. **Shared ACP sessions are enabled.** The creator signs the ACP binding including the member list; re-signs (higher version) on every scope/member change.

## General rules

- **Paired Worker** = has E2EE keys and an owner pin (from v2 setup or `pair`). It never executes an unsigned command, answer or tool task, never applies unsigned config/draft/cwd from the server, and never writes plaintext content. An **unpaired Worker** keeps today's plaintext behavior only when its operator starts it with `radium-worker start --allow-plaintext` (revised after the PR #25 review; otherwise `start` refuses and asks for `pair`), and only in a workspace without keys (`workspaces.keyEpoch` unset). In a workspace with keys, the backend refuses to dispatch ACP commands/sessions or Worker tool tasks to a Worker that is not listed in the latest roster (`ConvexError({ code: "WORKER_NOT_PAIRED" })`), and the web shows "Pair this Worker".
- **ACP chats in keyed workspaces always get chat keys** (like `aisdk.CreateChat`'s `e2ee` arg). For legacy keyless ACP chats, any unlocked current authorized reader may create the initial keys for the exact current audience. Execution remains blocked until the creator opens the chat unlocked and signs its ACP binding; key setup does not authorize execution or widen access.
- No content in logs, scheduler arguments, `ConvexError` data or thrown messages. Reuse helpers (`sealBox`/`openBox`, `createCapsule`/`sealWithCapsule`, `openRequestSender`/`openRequestRecipient`, web `openChatSeed`, `openTitle`, `fetchIdentities`, `verifyWorkspaceState`, `trust`), never duplicate them.
- Mutations/queries never create randomness; sealing happens in clients, Workers or actions. Mutations may `verify` signatures.
- Byte fields are `v.bytes()` (ArrayBuffer) in Convex; bound sizes server-side.
- Keep wire validators in the owning `src/` domain; thin exports in `convex/*.ts`.

## Already implemented (packages/crypto, do not change signatures)

`radium-crypto` now exports (see `packages/crypto/src/statements.ts`, `roster.ts`):
- `workerKeysStatement({workspaceId, workerId, keyId, suite, encryptionPublicKey, signingPublicKey})`, `workerPairingMac(pairingSecret, statement)` (HKDF label `LABELS.workerPairing`).
- `acpAgentDefinitionStatement({workspaceId, issuedAt, definition})` — the owner authorizes every executable definition field; canonical field ordering ignores attached `authorization: {issuedAt, signerKeyId, signature}`. Workers verify before probing, persist issuance/digest pins and observe signed disables before skipping disabled definitions. Server-row deletion cannot guarantee delivery of revocation.
- `acpBindingStatement({workspaceId, chatId, chatE2eeId, creatorUserId, workerId, agentId, profile, cwd, scope, members, version})` — signed by the chat creator.
- `acpCommandStatement({workspaceId, workerId, chatId ("" for agent-level), kind, clientId, payload})` — `payload` = the stored sealed box bytes.
- `acpAnswerStatement({workspaceId, workerId, chatId, requestKey, answer})` — `answer` = stored sealed box bytes.
- `workerObjectStatement({workspaceId, workerId, table, parent, record, field, object})` — Worker signs objects clients must trust (frame epoch capsule, interaction request box).
- `toolApprovalStatement({workspaceId, chatId, workerId, directory, tool, toolCallId, input, approvedAt, receipt: {chatE2eeId, scope, creatorId, keyId} | null})` — label `radium/v2/tool-approval`; `input` = UTF-8 `JSON.stringify(toolPart.input)`; `receipt` mirrors `WorkerSealedTaskRequest.receipt` (null without one); Workers accept the approval for 24 hours and consume it once.
- `toolGrantStatement({workspaceId, chatId, workerId, directory, tools, issuedAt, receipt: {chatE2eeId, scope, creatorId} | null})` — label `radium/v2/tool-grant`; accepted for `WORKER_GRANT_TTL_MS` (7 days), never from more than `WORKER_APPROVAL_CLOCK_SKEW_MS` in the future.
- `signRoster(body, seed)` / `verifyRoster({...signed, workspaceId, owner: {userId,keyId,fingerprint,signingPublicKey}, highWater})`; `WorkspaceRoster` v2 adds `workers: {workerId, keyId, fingerprint}[]` (v1 bodies verify with `workers: []`). `signRoster` always writes v2. Fingerprint of a Worker = `fingerprint({encryptionPublicKey, signingPublicKey})`, same as users.

## AAD conventions (new objects; `AadParts = {table, workspace, parent, record, field}`)

| Object | Sealed to | table | parent | record | field |
|---|---|---|---|---|---|
| Pairing secret (owner's copy, `sealBox`) | owner's own identity encryption key | `e2ee_worker_pairings` | owner userId | pairingId | `secret` |
| ACP command payload (`sealBox`, pad `content`) | Worker encryption key | `acp_commands` | chatId or `""` | clientId | `payload` |
| ACP answer (`sealBox`) | Worker encryption key | `acp_interactions` | chatId | requestKey | `answer` |
| ACP interaction request (`sealBox`) + Worker signature | chat key (current epoch) | `acp_interactions` | chat e2eeId | requestKey | `request` |
| Frame epoch capsule (`createCapsule`) + Worker signature | chat key | `acp_streams` | chat e2eeId | `String(epoch)` | `capsule` |
| One frame (`sealWithCapsule`, pad `content`) | epoch capsule key | `chat_frames` | chat e2eeId | `${epoch}:${seqFrom}` | `payload` |
| ACP chat title (same as Chatroom `sealTitle`) | chat key | `aisdk_chats` | e2eeId | `String(chatEpoch)` | `title` |
| ACP session error text (`sealBox`, pad `short`) | chat key | `acp_sessions` | e2eeId | `String(chatEpoch)` | `error` |
| Agent session index title (`sealBox`, pad `short`) | workspace owner key (current epoch) | `acp_agent_sessions` | workerId | `${agentId}:${sessionId}` | `title` |
| Built-in task request (`openRequestSender(...).seal`) | Worker encryption key (request context) | `worker_tasks` | chatId | requestId | `request` (aad = `buildAad(parts)`) |
| Built-in task result (`sealSym` under the request `responseKey`) | request response key | `worker_tasks` | chatId | requestId | `result` |
| Durable receipt (`sealBox`, pad `content`) | chat key | `worker_chat_calls` | e2eeId | `${toolCallId}:${stage}` | `result` |

Frames seal `{seqTo, kind, ops}`, with `seqFrom` in the AAD. Retry bytes are identical: the Worker seals each frame once and keeps the bytes until acknowledged; viewers authenticate routing metadata before advancing their cursor.

## Cross-slice interfaces (owner in brackets)

### Backend [Slice 1: Worker keys]
- Tables: `e2ee_worker_keys {workspace, workerId: string, keyId, suite, encryptionPublicKey, signingPublicKey, selfSignature, pairingMac, pairingId, createdAt}` (one current key set per Worker; re-pairing replaces it), `e2ee_worker_pairings {workspace, pairingId, ownerUserId, workerId?: string, enrollment?: Id<"worker_enrollments">, sealedSecret, expiresAt}`.
- `src/e2ee/worker-keys.ts` exports for other slices:
  - `certifiedWorkerKeys(ctx, workspace: Id<"workspaces">, workerId: string): Promise<{ keyId: string; encryptionPublicKey: ArrayBuffer; signingPublicKey: ArrayBuffer } | null>` — the key set only when the latest roster lists this Worker with the same keyId (server-side parse of the stored roster, not a trust decision; clients/Workers verify themselves).
  - `requireDispatchableWorker(ctx, workspace, workerId): Promise<WorkerKeys | null>` — `null` means "keyless workspace, legacy plaintext path"; throws `WORKER_NOT_PAIRED` when the workspace has keys and the Worker is not certified.
- Worker-facing (`workerQuery`, `convex/e2ee.ts`): `e2ee.workerTrustState()` → `{ roster: {version, body, signature, signerKeyId} | null, epochs: {epoch, memberKeyId, memberPublicKey, ownerKeyId, ownerPublicKey}[] }` for `ctx.worker.workspaceId`; `e2ee.workerIdentities({ keyIds: string[] })` → public identity rows `{userId, keyId, suite, encryptionPublicKey, signingPublicKey, selfSignature, status}` (bounded, workspace users only).
- Browser-facing: `e2ee.workerKeys({ workspace })` → key rows for the workspace's Workers (public data) for verification by clients.

### Worker package [Slice 1]
- `packages/worker` depends on `radium-crypto` (`workspace:*`).
- `packages/worker/src/e2ee/trust.ts` exports `class WorkerTrust` (constructed in `cli/start.ts` when the Worker is paired; `null`/absent when unpaired) with at least:
  - `readonly workerId: string; readonly workspaceId: string; readonly keyId: string;`
  - `encryptionSeed(): Uint8Array` (for `openBox` / `openRequestRecipient`), `signObject(parts: {table,parent,record,field,object}): Promise<Uint8Array>` (signs `workerObjectStatement` with the Worker's signing key).
  - `roster(): Promise<WorkspaceRoster>` — fetches `e2ee.workerTrustState`, verifies with the pinned owner, enforces and persists the roster high-water mark. Throws `WorkerTrustError` when the owner key changed, rollback, or the Worker itself is no longer listed (revoked) → caller refuses and logs a fixed reason.
  - `verifyUser(input: { signerKeyId: string; message: Uint8Array; signature: Uint8Array }): Promise<{ userId: string; role: "owner" | "member" } | null>` — resolves the identity by keyId (`e2ee.workerIdentities`), checks its self-signature and that it is the pinned owner or a roster member with matching keyId+fingerprint, then verifies the signature.
  - `ownerPublicKey(): Promise<{ epoch: number; keyId: string; publicKey: Uint8Array }>` — current epoch owner key checked against the roster hash.
  - `memberPublicKeys` is not needed; chat keys are verified by Slice 2.
- Local state (v3 of `auth/state.ts`): pairing `{ownerUserId, ownerKeyId, ownerFingerprint, ownerSigningPublicKey}`, roster high-water, and a small local JSON store for per-chat high-water marks (Slice 2 binding versions, Slice 3 grant `issuedAt`) exposed as `trust.highWater(name): number` / `trust.advanceHighWater(name, value): Promise<void>` (persisted, monotonic). Private seeds live in the credential store next to the machine key, covered by `forget`.

### Web [Slice 1]
- `apps/web/src/lib/crypto/workers.ts`:
  - `trustedWorker(workspaceId, workerId): Promise<{ keyId; encryptionPublicKey: Uint8Array; signingPublicKey: Uint8Array }>` — Worker listed in the verified roster (`verifyWorkspaceState`), key row matches keyId and fingerprint, self-signature valid. Throws `WorkerNotPairedError` otherwise.
  - `signAsUser(message: Uint8Array): Promise<{ signature: Uint8Array; signerKeyId: string }>` — signs with the unlocked identity (`keyManager.useAmk`). Throws `KeysLockedError` when locked.
  - Pairing/setup-code creation and owner certification (internal to Slice 1).
- `workspace-keys.ts` exports `getOwnerKey(workspaceId, epoch?)` (owner-only, current epoch default) → `{epoch, keyId, publicKey, seed}`.

### ACP [Slice 2] and built-in tasks [Slice 3]
Consume the interfaces above. Each slice owns its wire shapes and documents them in TSDoc. `cli/start.ts` is owned by Slice 1: it constructs `WorkerTrust | null` and passes it as a new last argument to `new AcpHost(...)` and `consumeEditTasks(...)`; Slices 2/3 add that parameter to their constructors/functions.

## File ownership

- Slice 1: `packages/crypto` (only if a bug is found), `packages/worker/src/{auth,cli,e2ee,protocol.ts,control.ts}`, `packages/worker-component/**` (if needed), `packages/backend/src/{e2ee,worker/{identity,management,auth}.ts,http/worker.ts}`, `convex/{e2ee,workers}.ts`, web `lib/crypto/{workers,workspace-keys,workspace-proofs,trust-store,trust-requests}.ts`, `components/{workspaces,trust}/**`.
- Slice 2: `packages/backend/src/acp/**`, `src/e2ee/chat-scope.ts` (allow shared ACP), `src/notifications/session.ts`, `src/chatroom/*` only for ACP title helpers, `convex/{acp,chatroom}.ts`, ACP parts of `convex/aisdk.ts` (`DeleteChat` close/delete, chat rows), `packages/worker/src/acp/**`, web `components/session/acp/**`, `components/home/**` agent-session parts, the ACP-creation block in `components/session/session-screen.tsx`.
- Slice 3: `packages/backend/src/worker/{tasks,chat-tools,chat-config,chat-selection,task-contract,edit-contract,bash-contract}.ts`, `src/http/aisdk.chat.ts`, `convex/{worker_tasks,code_mode}.ts`, Worker selection parts of `convex/aisdk.ts`, `packages/worker/src/{tasks.ts,edit,bash}`, web approval UI (`components/session/approval-gate.tsx`, approval handling in `session-screen.tsx`), Worker selection UI.
- Shared: `convex/schema.ts` — each slice edits only its own tables' blocks and re-reads the file right before every edit (others edit it concurrently). Same for `session-screen.tsx` and `convex/aisdk.ts`.

## Process

- Do not run builds/tests/formatters while other slices are editing; at the end of your slice run once: `bun run --cwd packages/worker typecheck`, `bun run build:components && bun run --cwd packages/backend test <your filters>`, `bun run --cwd packages/worker test:unit <filters>`, and the web test/typecheck you touched (`cd apps/web && bunx tsc --noEmit -p .` if available). Errors in files another slice owns are not yours; report them.
- Never hand-edit `_generated`. For new Convex functions refresh `api.d.ts` only with the offline command in `docs/deployment.md#offline-api-binding-codegen` (network guard on).
- Add focused tests only for security boundaries (unsigned/forged/replayed/wrong-signer/rollback refusals, sealed-at-rest), not wiring.
- Final report: files changed, wire shapes, what is verified (exact commands), what is not, and open risks.
