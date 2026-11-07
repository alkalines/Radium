# 12 Local Models

Status: **not started.** Design: [Local models](../Local_Models.md), [transport](../Local_Models/Transport.md), [management](../Local_Models/Management.md). Research: [Docker Model Runner](../research/Docker_Model_Runner.md).

Depends on the instance part of [task 04](04_Upstream_Instances.md), which this task implements for the credential-free local kind. Shares the Worker encryption key and `packages/crypto` with [task 11](11_E2EE.md); whichever lands first owns them.

## Phase 0: Spikes

Findings recorded in this file.

1. **DMR on the supported setups.** Docker Engine plugin on Linux and Docker Desktop with host TCP: reach `http://127.0.0.1:12434` from a Bun process, pull a small `ai/` model, stream a chat completion with `stream_options.include_usage`, confirm the final usage chunk, tool call deltas and abort behavior.
2. **Relay latency and cost.** On the local Convex deployment, a Convex HTTP action polls a chunk table written by a Bun client: measure added time to first token and inter-token delay for 50/100/250 ms poll intervals and 0/50/300 ms Worker batching, and count function calls per minute of streaming.
3. **HTTP action lifetime.** A streaming HTTP action kept open for 5, 10 and 20 minutes; record where it ends and how the client sees it. Sets the default request deadline.
4. **Fetch tunnel.** `@ai-sdk/openai-compatible` with a custom `fetch` returning a `ReadableStream` built from polled rows, driven through `createCompletion`'s streaming path.

Acceptance: measured numbers replace the starting values in [transport](../Local_Models/Transport.md#flow), or the design changes.

## Phase 1: Runtime Discovery

`--local-models` and `--dmr-url` Worker options; probe and snapshot; `local_runtimes` and `local_runtime_models` with diff writes; read-only Gateway → Local models section.

## Phase 2: Management Commands

`local_model_commands` (pull with progress, delete, configure, unload, install-backend, refresh), Worker execution with argument validation, UI actions.

Verification: pull, configure, unload and delete a model from the UI against a real DMR; a command with `raw-runtime-flags` inserted directly is rejected by the Worker.

## Phase 3: Publishing And Routing

Local instance records, publishing with slug and capabilities, model listing in both listing paths, discriminated routing target, instance-based cooldowns and session affinity, instance attribution in `chat_completions` and telemetry, zero local rates.

## Phase 4: Transport

`local_requests`/`local_chunks`, Worker claim, proxy allowlist, DMR call, batched encrypted appends, heartbeat, cancellation, deadline, cleanup cron; `workerFetch` in the action.

Verification against a local deployment and real DMR: streaming and non-streaming completions through a Gateway API key; a Chatroom turn with tool calls on a local model; client disconnect stops DMR generation; killing the Worker mid-stream ends the response with an error; with the Worker offline, routing fails over to a remote provider serving the same slug; Convex tables hold only ciphertext and are empty two minutes after completion.

## Phase 5: Surfaces

Chatroom model selector `Local` tag and availability; ACP Gateway mode with OpenCode against a local model; [API reference](../api.md), [Gateway overview](../Radium_Gateway.md), [Worker README](../../packages/worker/README.md) and [deployment](../deployment.md) updated.
