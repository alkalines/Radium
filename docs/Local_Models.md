# Local Models

Status: **planned, not implemented.** Design snapshot: 2026-11-05. Implementation plan: [task 12](tasks/12_Local_Models.md).

Local models run open-weight models on a Worker's machine with [Docker Model Runner](https://docs.docker.com/ai/model-runner/) (DMR) and make them available wherever Gateway models are used: the built-in Chatroom agent, Gateway API keys (`/api/openai/v1/chat/completions`) and ACP agents in [Gateway mode](ACP/Agents.md#gateway-mode). The Worker manages DMR; the owner manages models from the Radium UI; every request and its stream travel through Convex, like the rest of the Worker transport.

Focused guides:

| Guide                                                           | Contents                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Transport](Local_Models/Transport.md)                          | Worker fetch tunnel, request and chunk records, encryption, polling, cancellation, failure semantics, limits |
| [Management](Local_Models/Management.md)                        | Runtime discovery, model commands (pull, delete, configure, unload), publishing to Gateway, UI, permissions  |
| [Docker Model Runner research](research/Docker_Model_Runner.md) | DMR platforms, engines, full REST inventory, security, versions                                              |

## Principles

1. **The Worker is DMR's only client.** DMR's API has no authentication and ignores `Authorization` ([research](research/Docker_Model_Runner.md#security-and-plaintext-boundaries)). Nothing else in Radium talks to it, and Convex never receives a URL to call: the DMR address is local Worker configuration.
2. **Gateway stays the one router.** A local model is a Gateway model whose upstream is a Worker-hosted instance. Chatroom, API keys and ACP Gateway mode reach it through the same routing, accounting and telemetry pipeline (`createCompletion`, `src/routing/`), not a second router (`AGENTS.md`).
3. **Serving is not execution.** Serving models is a separate Worker capability from Edit, Bash and ACP. Enabling one does not enable the other, on the machine or in the workspace (`AGENTS.md` product boundaries).
4. **Through Convex, encrypted, short-lived.** Requests and stream chunks cross Convex as ciphertext rows that only the Gateway action and the Worker can open, deleted when the request ends ([transport](Local_Models/Transport.md#encryption)).
5. **Pass DMR through.** The Worker tunnels an allowlist of OpenAI-compatible calls verbatim and maps management actions one-to-one to DMR's REST endpoints. Radium does not translate model formats or reimplement DMR features.
6. **Owners manage, members use.** As with providers: owners pull, configure and publish; members see published local models in the model selector.

## Concepts

| Concept             | Meaning                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**         | A DMR installation reachable from one Worker (Docker Desktop, Docker Engine plugin, or standalone `dmr`), with its version and engines                                                                   |
| **Local instance**  | Workspace-owned binding of one Worker's runtime as a schedulable Gateway upstream. It is the "endpoint instance" of [task 04](tasks/04_Upstream_Instances.md): no credential, its identity is the Worker |
| **Local model**     | A model in a runtime's store, by DMR reference (`ai/qwen3:8B-Q4_K_M`, `hf.co/…`), with its runtime configuration (context size, keep-alive)                                                              |
| **Published model** | A Gateway model slug (default `local/<name>`) mapped to a local model on one or more instances, with capabilities and zero upstream rates                                                                |

## Architecture

```mermaid
sequenceDiagram
    participant Client as Chatroom / API key / ACP agent
    participant GW as Gateway action (Convex)
    participant DB as Convex tables
    participant W as Worker
    participant DMR as Docker Model Runner

    Client->>GW: chat completion, model = local/qwen3
    GW->>GW: route → local instance on Worker W
    GW->>DB: insert sealed request
    DB-->>W: subscription: assigned request
    W->>W: claim, open, check allowlist
    W->>DMR: POST /engines/v1/chat/completions (stream)
    loop while streaming
        DMR-->>W: SSE bytes
        W->>DB: append encrypted chunk batch
        GW->>DB: poll chunks after seq
        GW-->>Client: SSE (same as any upstream)
    end
    W->>DB: final status, usage
    GW->>DB: record usage, telemetry; delete request rows
```

## Supported Setups

| Setup                           | What the user does                                                                             | Worker default URL       |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ |
| Docker Desktop (macOS, Windows) | Enable Model Runner and host TCP: `docker desktop enable model-runner --tcp 12434 --cors none` | `http://127.0.0.1:12434` |
| Docker Engine (Linux)           | Install `docker-model-plugin`; the runner container starts on first use and listens on 12434   | `http://127.0.0.1:12434` |
| Standalone `dmr`                | Install and run `dmr serve`                                                                    | `http://127.0.0.1:12434` |

The Worker reads the address from `--dmr-url` / `RADIUM_WORKER_DMR_URL`; serving is off until the machine owner passes `--local-models` (or sets it in the Worker config), so a Worker enrolled for Bash does not start serving models by surprise. The Desktop Docker-socket route (`/exp/vDD4.40/...`) is not used: it needs Docker socket access, which the Worker does not otherwise need ([research](research/Docker_Model_Runner.md#desktop-docker-socket-proxy)).

The first release targets DMR's default **llama.cpp** engine (GGUF models). Other engines (vLLM, MLX, SGLang, Diffusers) are reported by the runtime and usable if present, but not part of the tested matrix ([research](research/Docker_Model_Runner.md#inference-engines-documentation-versus-source)).

## Using Local Models

- **Chatroom:** published local models appear in the model selector with a `Local` tag and the serving Worker's name; unavailable (Worker offline, runtime down) models are shown disabled, not hidden.
- **Gateway API keys:** `GET /api/openai/v1/models` lists published local models; requests use the published slug.
- **ACP Gateway mode:** agents launched with a Gateway profile see them in the model list read at process start ([ACP agents](ACP/Agents.md#gateway-mode)). An agent and the model may be on the same machine; the request still goes through Convex (see [non-goals](#non-goals)).

## Accounting And Telemetry

- Local instances have explicit **zero** upstream rates, marked as local, so cost estimates report `0` instead of "unknown"; this is upstream inference cost, not hardware or power cost.
- Token usage comes from DMR's final usage chunk (`stream_options.include_usage`, added by the Worker) or the non-streaming `usage` field. Missing usage stays unknown, never zero.
- Usage records attribute the instance (and Worker) instead of a credential; `chat_completions` and telemetry attempt records get an instance field next to the credential field.
- Telemetry capture is identical to remote providers ([Gateway telemetry](Radium_Gateway/Telemetry.md)) and, once [E2EE](E2EE.md) ships, sealed to the owner key like any other request.

## Privacy

Local inference keeps prompts away from third-party providers. It does **not** keep them away from Radium's backend: the Gateway action handles plaintext in memory, as for any upstream. Convex stores only ciphertext rows, removed after the request ([transport](Local_Models/Transport.md#encryption)).

DMR itself keeps the last ten requests and responses per model in memory and serves them on its unauthenticated `/engines/requests` endpoint; v1.2.9 has no switch to disable this ([research](research/Docker_Model_Runner.md#can-recording-be-disabled)). Anyone who can reach the runtime can read them. The Management screen states this, and the Setup table above binds DMR to loopback with CORS disabled.

## Non-Goals

- Other local servers (Ollama, LM Studio, vLLM or llama.cpp servers directly). The instance model from [task 04](tasks/04_Upstream_Instances.md) should allow them later through the same transport.
- DMR on another LAN host. The Worker talks to its own loopback runtime only.
- A loopback shortcut for ACP agents on the serving machine (agent → Worker → DMR without Convex). Faster, but it bypasses Gateway routing, accounting and telemetry; reconsider after measuring the Convex path.
- Embeddings, image generation, reranking. DMR serves them; Gateway has no route for them yet ([task 10](tasks/10_Gateway_Protocols.md)).
- Hole punching or direct browser-to-Worker connections.
