# Local Model Transport

Status: **planned.** Part of [Local models](../Local_Models.md). Precedents it follows: the [ACP relay](../ACP/Transport.md) (ordered, idempotent batched appends) and the Worker task outcome poll in `src/worker/chat-tools.ts` (`waitForOutcome`).

## Constraints

- **The Worker has no inbound listener** (`packages/worker/README.md`); it holds one outbound, authenticated `ConvexClient` (`packages/worker/src/control.ts`). Everything reaches it through subscriptions.
- **A Convex action cannot subscribe.** `ActionCtx` offers `runQuery`/`runMutation`, not reactive updates, and the default runtime does not list `WebSocket` among its APIs ([runtimes](https://docs.convex.dev/functions/runtimes)); HTTP actions cannot use `"use node"`. The Gateway action therefore **polls** an indexed query for new chunks.
- **Sizes:** 1 MiB per document, 16 MiB per function argument, 64 MiB action memory ([limits](https://docs.convex.dev/production/state/limits)).
- **HTTP action lifetime is unverified** for long streams on Radium's deployment; [Live sessions](../Radium_Chatroom/Live_Sessions.md) already flags the inconsistent documentation. A long local generation is a long HTTP action. Measured in [task 12 phase 0](../tasks/12_Local_Models.md#phase-0-spikes).

## Worker Fetch Tunnel

The Gateway already routes through AI SDK providers that accept a custom `fetch` (`src/providers.ts`); ChatGPT subscriptions use this with an internal base URL (`https://radium.internal…`). Local instances reuse the existing `@ai-sdk/openai-compatible` adapter with:

- `baseURL`: `https://radium.worker/<instanceId>/engines/v1`, a name that only identifies the instance and is never resolved.
- `fetch`: `workerFetch(instance)`, which turns the HTTP request into a sealed request row and returns a `Response` whose body is a `ReadableStream` fed from the Worker's chunk rows.

Everything above the fetch is unchanged: request translation (`src/translators/openai.ts`), first-payload commit and pre-output failover (`src/routing/execute.ts`), SSE output (`createStreamingCompletion`), usage recording and telemetry capture. The routing changes are in [Management § Routing](Management.md#routing).

The Worker side is a narrow proxy, not a general one. It accepts only:

| Method | Path (relative to the DMR URL) | Notes                                                                                               |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `POST` | `/engines/v1/chat/completions` | `model` must be a model this instance publishes; adds `stream_options.include_usage` when streaming |

Any other method, path or model is rejected before contacting DMR. Headers are rebuilt by the Worker (`Content-Type`, `Accept`); nothing from the request reaches DMR except the JSON body. More paths (embeddings) are added with their Gateway routes.

## Records

| Table            | Written by             | Contents                                                                                                                                                                                                                               |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local_requests` | Gateway action, Worker | workspace, instance, Worker, request ID, status (`queued`, `claimed`, `streaming`, `done`, `failed`, `cancelled`), claim token, sealed request, deadline, `heartbeatAt`, HTTP status, error code, `cancelRequested`, usage, timestamps |
| `local_chunks`   | Worker                 | request ID, sequence, encrypted batch (≤ 64 KiB), `final` flag                                                                                                                                                                         |

Indexes: requests by `(worker, status)` for the Worker subscription and by `(status, deadline)` for cleanup; chunks by `(request, seq)`.

Functions, following `src/worker/machine.ts` for the machine side (`workerQuery`/`workerMutation` derive and re-check `ctx.worker`) and internal functions for the action side:

| Function                       | Caller                | Effect                                                                                                                             |
| ------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `internal.localModels.enqueue` | Gateway action        | Insert `queued` request after checking the instance is enabled, its Worker active and under capacity                               |
| `localModels.assigned`         | Worker (subscription) | Up to 8 `queued` requests for this Worker plus `cancelRequested` flags of its claimed ones                                         |
| `localModels.claim`            | Worker                | `queued` → `claimed` with a claim token; fails if already claimed or past deadline                                                 |
| `localModels.appendChunks`     | Worker                | Append a contiguous range of chunks; an identical retry is a no-op, a gap or conflicting range is rejected (as ACP `appendFrames`) |
| `localModels.heartbeat`        | Worker                | Every 5 s while claimed, refresh `heartbeatAt`; prompt processing on local hardware can take long before the first token           |
| `localModels.finish`           | Worker                | Terminal status, HTTP status, usage, error code; fenced by the claim token                                                         |
| `internal.localModels.chunks`  | Gateway action (poll) | Request status plus chunks after a sequence                                                                                        |
| `internal.localModels.cancel`  | Gateway action        | Set `cancelRequested`, or `cancelled` directly if still `queued`                                                                   |

Request bodies up to 768 KiB are stored inline in the sealed envelope. Larger bodies (long contexts, inline images) are uploaded encrypted to Convex File Storage and referenced from the row; the Worker downloads them with a short-lived URL from `claim`. Chunks are bounded at 64 KiB per batch and 8 batches per append, matching ACP's bounds.

## Flow

1. **Enqueue.** `workerFetch` seals the request and calls `enqueue`. If the instance is at capacity (owner setting, default 2 concurrent requests) or its Worker is offline, it throws before any output so routing can fail over to another instance or provider.
2. **Claim.** The Worker sees the request through `assigned`, claims it, opens it and validates method, path, model and size.
3. **Call DMR.** The Worker sends the body to its local DMR URL with an `AbortController` tied to cancellation and the deadline.
4. **Stream back.** The Worker forwards DMR's response bytes as they come: the first batch (headers and first bytes) immediately, so time to first token is not delayed by batching, then coalesced every 50 ms or 16 KiB, whichever comes first. Each batch is encrypted and appended in order. A failed append is retried with the exact same bytes, with backoff, as the ACP relay does.
5. **Read.** The action polls `chunks` every 50 ms while a request is streaming, backing off to 250 ms after 2 s without new chunks, and pushes decrypted bytes into the `Response` body. The AI SDK parses the SSE as from any OpenAI-compatible server.
6. **Finish.** The Worker writes the final batch and `finish`. The action reads the remaining chunks, closes the stream, records usage and deletes the request and its chunks.

Intervals are starting values; [phase 0](../tasks/12_Local_Models.md#phase-0-spikes) measures added latency and function-call cost and sets them.

### Non-streaming requests

Same path. The Worker sends DMR's JSON body as chunks with `final` on the last; the action returns it as one body.

### Cancellation and deadlines

- Client disconnect or AI SDK abort (`req.signal`, already propagated by `createCompletion`) calls `cancel`. The Worker sees `cancelRequested` in its subscription and aborts the DMR call; DMR stops generating when the connection closes.
- Every request has a deadline (default 10 minutes, below the action limit). The Worker aborts at the deadline; the action stops polling at the deadline plus a grace period and reports a timeout.
- Unlike `waitForOutcome`, abandoning the wait always also cancels the work: inference has no side effects worth keeping.

## Failure Semantics

| Failure                                                 | Detected by                                      | Result                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Worker offline or not claiming within 10 s              | Action (claim timeout)                           | Pre-output error; routing may fail over. Row cancelled.                                  |
| DMR unreachable, model missing, DMR 4xx/5xx before body | Worker                                           | `finish` with the status; pre-output error; routing may fail over.                       |
| Error after output started                              | Worker (`failed`) or action (gap, timeout)       | Stream ends with an SSE error; no retry (`AGENTS.md`: never retry after emitted output). |
| Worker crashes or disconnects mid-request               | Action: no `heartbeatAt` refresh for 20 s        | Pre-output error (failover allowed) if nothing was emitted, otherwise as above.          |
| Gateway action dies                                     | Cleanup job: `claimed`/`streaming` past deadline | Request cancelled; Worker aborts on the flag; rows deleted.                              |
| Duplicate append after a lost acknowledgement           | `appendChunks`                                   | Identical retry accepted as no-op.                                                       |
| Late writes after cancel or reclaim                     | Claim token fence                                | Rejected.                                                                                |

A cleanup cron (every minute) deletes terminal requests older than two minutes and their chunks, and cancels requests past their deadline. Nothing about local requests is retained beyond that except usage and, if enabled, telemetry.

## Encryption

Local requests use [request keys](../E2EE/Keys.md#request-keys) from the start, even before the rest of E2EE ships, because they only need the Worker's encryption key (MLKEM768-X25519, [suite 1](../E2EE/Keys.md#crypto-suite)):

1. The Worker generates its encryption key at first start with `--local-models` and registers the public key through its authenticated machine channel (before E2EE pairing exists) or its certificate (after).
2. `workerFetch` creates an HPKE sender context to that key, seals `{method, path, body}` into the request row and stores the encapsulated key with it. The context stays in the action's memory.
3. Both sides derive a 32-byte response key with the HPKE exporter (`radium/v1/local-response`). The Worker encrypts each chunk batch with AES-256-GCM under that key; the nonce is the batch sequence number, the AAD binds request ID, sequence and `final`.

Rows in Convex are ciphertext only, and the keys never touch the database. This protects stored rows, backups and anyone reading the tables; it does not hide content from the Gateway action, which is the party that needs the plaintext. Before E2EE pairing, the backend vouches for the Worker's key; since the backend already sees the plaintext in this flow, that adds no exposure.

## Alternatives Considered

| Alternative                                         | Why not                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound HTTP on the Worker (tunnel, hole punching)  | Needs reachability through NAT and firewalls; the product keeps one transport through Convex                                                                           |
| Reuse `chat_frames`                                 | Frames are chat-bound and viewer-gated; Gateway API requests have no chat and need every chunk regardless of viewers                                                   |
| Subscription from the action via a WebSocket client | Not available in the default runtime; HTTP actions cannot run in Node. **[INFERENCE]** a Node action could, but the HTTP handler would still need to receive the bytes |
| A new AI SDK `LanguageModel` implementation         | Duplicates the OpenAI-compatible adapter; the fetch tunnel keeps one adapter and DMR's own wire format                                                                 |
