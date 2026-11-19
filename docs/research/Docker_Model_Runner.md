# Docker Model Runner Research

Snapshot: 2026-11-05 against DMR v1.2.9 (2026-10-22). Research only; Radium's planned integration is in [Local models](../Local_Models.md).

## Scope and Evidence

This document combines Docker's current public documentation with release-tagged implementation inspection at `docker/model-runner` `v1.2.9`. Source inspection is not runtime verification: no Docker installation, runner, model download, inference request, or platform smoke test was performed. Recommendations and unverified compatibility conclusions are marked `[INFERENCE]`.

Current public documentation and release-tagged implementation disagree in several places, notably MLX, macOS Diffusers/vLLM-Metal, vLLM ARM64, and Ollama embeddings. Public documentation is useful for the supported installation path; tagged source is the stronger evidence for exact HTTP routes and JSON field names. The latest release returned by GitHub during research was [`v1.2.9`, published 2026-10-22](https://github.com/docker/model-runner/releases/tag/v1.2.9).

The old [`docker/model-cli` repository](https://github.com/docker/model-cli) redirects to an archived repository whose README says development moved to [`docker/model-runner/cmd/cli`](https://github.com/docker/model-runner/tree/v1.2.9/cmd/cli). New integration research should use the consolidated repository, not assume the archived CLI matches the runner.

## Platforms and Installation

### Installation Matrix

| Environment                   | Installation and enabling                                                                          | Documented hardware                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Docker Desktop, macOS         | DMR is included; Settings → AI → Enable Docker Model Runner                                        | Apple Silicon; llama.cpp uses Metal                                                       |
| Docker Desktop, Windows x64   | DMR is included; enable Model Runner and GPU-backed inference                                      | NVIDIA; driver 576.57+                                                                    |
| Docker Desktop, Windows ARM64 | DMR is included                                                                                    | Qualcomm Adreno 6xx or later, using OpenCL; some llama.cpp features may be limited on 6xx |
| Native Linux, Docker Engine   | Install `docker-model-plugin` from Docker's official package repository                            | CPU, NVIDIA CUDA, AMD ROCm, Vulkan; documented NVIDIA driver minimum 575.57.08+           |
| Linux runner container        | Official `docker/model-runner` image; the CLI manages a `docker-model-runner` controller container | GPU image variant, container runtime, and exposed devices determine acceleration          |
| Standalone native `dmr`       | Self-contained daemon and management CLI; does not require Docker Engine or Desktop                | Platform/backend-dependent; do not infer the Desktop support matrix applies unchanged     |

Sources: [requirements and overview](https://docs.docker.com/ai/model-runner/), [installation guide](https://docs.docker.com/ai/model-runner/get-started/), [controller container implementation](https://github.com/docker/model-runner/blob/v1.2.9/cmd/cli/pkg/standalone/containers.go), and [standalone native binary README](https://github.com/docker/model-runner#standalone-dmr).

The documented Linux package commands are `sudo apt-get install docker-model-plugin` on Ubuntu/Debian and `sudo dnf install docker-model-plugin` on RPM-based distributions, after configuring Docker's official repository. Distro-provided Docker packages may not include this plugin. See [getting started](https://docs.docker.com/ai/model-runner/get-started/) and [installation-source troubleshooting](https://github.com/docker/model-runner#troubleshooting-docker-installation-source).

`docker model install-runner` runs implicitly when a model command needs it on Docker Engine. Its documented defaults include `--gpu auto`, `--host 127.0.0.1`, Engine HTTP port `12434`, and optional TLS port `12444`. Installing the CLI package does not by itself establish that a controller is running. The CLI also exposes backend, proxy certificate, and TLS options. See the [generated install reference](https://docs.docker.com/reference/cli/docker/model/install-runner/).

The standalone native installation examples are `brew install docker/tap/dmr` on macOS ARM64, `winget install Docker.dmr` on Windows amd64, and release archives on Linux. `dmr serve` starts the daemon; `dmr pull`, `run`, `ls`, `rm`, and `ps` provide management. `MODEL_RUNNER_HOST` or `--host` can point its CLI at another daemon. See the [standalone README](https://github.com/docker/model-runner#standalone-dmr) and [separate `dmr-v0.1.0` release](https://github.com/docker/model-runner/releases/tag/dmr-v0.1.0).

### Inference Engines: Documentation Versus Source

| Engine    | Public documentation                                                                                                  | `v1.2.9` implementation evidence                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| llama.cpp | Default; GGUF; macOS, Windows, Linux; CPU and platform-specific GPU acceleration                                      | Default backend; macOS/Windows can download its pinned executable on demand                                                                                         |
| vLLM      | Safetensors; Linux x86_64 CUDA and Windows WSL2 CUDA with Desktop 4.54+; documentation excludes macOS and Linux ARM64 | Linux platform predicate does not restrict architecture; repository README describes amd64 and ARM64 wheels; backend construction selects vLLM-Metal on macOS ARM64 |
| MLX       | Not in the three-engine public support matrix; appears in sample status output                                        | Registered backend; macOS ARM64 only; Python `mlx_lm` package required; Safetensors bundle                                                                          |
| Diffusers | Image generation, DDUF/Safetensors; documentation says Linux amd64/ARM64 NVIDIA CUDA only                             | Platform predicate also permits macOS ARM64/MPS; deferred installation exists                                                                                       |
| SGLang    | Not in the three-engine public support matrix                                                                         | Registered by the standalone daemon; Linux platform predicate                                                                                                       |

Sources: [documented engine matrix](https://docs.docker.com/ai/model-runner/inference-engines/), [platform predicates](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/platform/platform.go), [backend definitions](https://github.com/docker/model-runner/blob/v1.2.9/pkg/routing/backends.go), [daemon backend registration](https://github.com/docker/model-runner/blob/v1.2.9/pkg/server/server.go), [vLLM platform dispatch](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/vllm/vllm.go), [vLLM-Metal implementation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/vllm/vllm_metal.go), and [MLX implementation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/mlx/mlx.go).

llama.cpp acceleration is documented as Metal on Apple Silicon, CUDA on Windows x64, Adreno OpenCL on Windows ARM64, and NVIDIA/AMD/Vulkan on Linux. CPU inference is documented on Linux x64/ARM64. vLLM and Diffusers have stricter documented GPU requirements than llama.cpp. See [engine platform details](https://docs.docker.com/ai/model-runner/inference-engines/).

The repository README describes the default Linux `cpu` image variant as based on upstream Vulkan, with CUDA 13 and ROCm alternatives. The tagged CLI selects official image variants `cuda`, `rocm`, and `vllm-cuda`, or an unsuffixed generic image. The engine guide mentions `--gpu vulkan`, but the generated install reference does not list that value. `[INFERENCE]` Do not hard-code `--gpu vulkan` without testing the targeted CLI version. Sources: [README build variants](https://github.com/docker/model-runner#llamacpp-integration), [tagged image selection](https://github.com/docker/model-runner/blob/v1.2.9/cmd/cli/pkg/standalone/controller_image.go), and [install flags](https://docs.docker.com/reference/cli/docker/model/install-runner/).

The MLX backend invokes Python `-m mlx_lm.server` and requires a Safetensors path; it is not a second way to execute arbitrary GGUF artifacts. Backend installation checks for an existing `mlx_lm` import. See [MLX installation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/mlx/mlx.go) and [MLX argument construction](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backends/mlx/mlx_config.go).

`[INFERENCE]` The initial Radium compatibility baseline should be llama.cpp. Treat MLX, SGLang, vLLM-Metal, macOS Diffusers, and ARM64 vLLM as optional capabilities until exercised on the supported Worker platform matrix; source registration is not a cross-platform support guarantee.

## Host Connectivity

### Connection Matrix

| Installation and caller                   | Base URL or transport                                     | Enabling requirement                                 |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Desktop, host process                     | `http://localhost:12434`                                  | Explicitly enable host-side TCP                      |
| Desktop, container                        | `http://model-runner.docker.internal`                     | Enable Model Runner; documentation omits a port here |
| Engine, host process                      | `http://localhost:12434`                                  | TCP enabled by default once installed/running        |
| Engine, container                         | `http://172.17.0.1:12434`                                 | Bridge availability depends on networking setup      |
| Engine, container with host-gateway alias | `http://model-runner.docker.internal:12434`               | Configure `extra_hosts` mapping                      |
| Native `dmr serve`                        | TCP port `12434` by default                               | `--port`, `--socket`, and `--models-path` options    |
| Raw runner daemon                         | Unix socket by default; TCP if `MODEL_RUNNER_PORT` is set | Default Unix path is `model-runner.sock`             |

Sources: [API base URLs](https://docs.docker.com/ai/model-runner/api-reference/), [Engine TCP default](https://docs.docker.com/ai/model-runner/get-started/), [native standalone README](https://github.com/docker/model-runner#standalone-dmr), and [daemon environment configuration](https://github.com/docker/model-runner/blob/v1.2.9/pkg/envconfig/envconfig.go).

Desktop can be enabled through Settings → AI, or the CLI. For a host daemon that needs no browser access, the relevant documented command is:

```sh
docker desktop enable model-runner --tcp 12434 --cors none
```

The Desktop CLI documents `--tcp` default `12434`, `--no-tcp`, and `--cors all|none|comma-separated-origin-list`; the documented CLI CORS default is `all`. Settings also exposes the port and allowed origins. Sources: [Desktop CLI](https://docs.docker.com/reference/cli/docker/desktop/enable/model-runner/) and [Settings instructions](https://docs.docker.com/ai/model-runner/get-started/).

For a Docker Engine Compose service, Docker documents the following mapping when the default bridge gateway is not otherwise accessible:

```yaml
extra_hosts:
  - "model-runner.docker.internal:host-gateway"
```

Use `http://model-runner.docker.internal:12434` with that mapping. See the [container connectivity note](https://docs.docker.com/ai/model-runner/api-reference/#determine-the-base-url).

OpenAI clients use base URL `http://localhost:12434/engines/v1`; Anthropic and Ollama clients use the runner root, subject to their endpoint paths. A client SDK may require a nonempty dummy API key even though DMR does not authenticate it. See [SDK configuration examples](https://docs.docker.com/ai/model-runner/api-reference/).

### Desktop Docker Socket Proxy

Docker documents the Desktop Docker API socket proxy, with experimental-prefixed route `/exp/vDD4.40/engines/v1/chat/completions`:

```sh
curl --unix-socket "$HOME/.docker/run/docker.sock" \
  http://localhost/exp/vDD4.40/engines/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"ai/smollm2","messages":[{"role":"user","content":"Hello"}]}'
```

The documented socket is `$HOME/.docker/run/docker.sock`, not a universal `/var/run/docker.sock`. `[INFERENCE]` A `/var/run/docker.sock` symlink may exist depending on installation. Equivalent native Windows Unix-socket access and a long-term compatibility guarantee for the `/exp/vDD4.40` proxy were not verified. Source: [exact Docker socket example](https://docs.docker.com/ai/model-runner/api-reference/#request-from-the-host-using-a-unix-socket).

`[INFERENCE]` Loopback HTTP is the simpler cross-platform transport for a Bun Worker. Docker-socket access gives broader privilege and is unnecessary for ordinary inference or REST model management once DMR is installed.

## Inference API Inventory

In the tables below, `E` means either `/engines` or `/engines/{backend}`. Engine examples include `llama.cpp`, `vllm`, `mlx`, and `diffusers`; route existence does not guarantee the selected backend or model implements every operation. Sources of route truth are [scheduler routes](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go), [model routes](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/http_handler.go), and [public API reference](https://docs.docker.com/ai/model-runner/api-reference/).

### OpenAI and Engine-Qualified Endpoints

| Method | Path                         | Request and response shape                                                                               |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET    | `E/v1/models`                | No body → `{object:"list",data:[model,...]}`                                                             |
| GET    | `E/v1/models/{model...}`     | Full model reference in path → `{id,object:"model",created,owned_by:"docker",dmr?}`                      |
| POST   | `E/v1/chat/completions`      | `{model,messages,stream?,tools?,response_format?,...}` → OpenAI completion JSON or SSE completion chunks |
| POST   | `E/v1/completions`           | `{model,prompt,stream?,...}` → OpenAI text completion JSON or stream                                     |
| POST   | `E/v1/embeddings`            | `{model,input,...}` → OpenAI embedding list and usage                                                    |
| POST   | `E/v1/messages`              | Anthropic message request → backend Anthropic response or stream                                         |
| POST   | `E/v1/messages/count_tokens` | Anthropic token-count request → backend token count                                                      |
| POST   | `E/v1/images/generations`    | `{model,prompt,size?}` → `{data:[{b64_json:"..."}]}`; Diffusers is the documented image backend          |
| POST   | `E/rerank`                   | Backend-specific reranking request → backend response; absent from public DMR endpoint table             |
| POST   | `E/score`                    | Backend-specific scoring request → backend response; absent from public DMR endpoint table               |

OpenAI model objects may include DMR metadata `dmr.context_window`, `architecture`, `parameters`, `quantization`, and `size`. This is metadata, not proof of the effective runtime context configuration. See [`OpenAIModel` and `DMRMetadata`](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/api.go).

The router aliases `/v1/*` to `/engines/v1/*`, `/rerank` to `/engines/rerank`, and `/score` to `/engines/score`. This explains why public Anthropic examples use `/v1/messages` while the table names `/anthropic/v1/messages`. See [router aliases](https://github.com/docker/model-runner/blob/v1.2.9/pkg/routing/router.go).

### Anthropic Namespace

| Method | Path                                  | Request and response shape                                                      |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/anthropic/v1/messages`              | `{model,messages,max_tokens,system?,stream?,...}` → Anthropic message or events |
| POST   | `/anthropic/v1/messages/count_tokens` | Anthropic token-count body → token-count response                               |

The namespace handler proxies to the scheduler; its implementation describes llama.cpp's native Anthropic compatibility. `[INFERENCE]` Do not promise backend-independent Anthropic compatibility based on route registration alone. Source: [`pkg/anthropic/handler.go`](https://github.com/docker/model-runner/blob/v1.2.9/pkg/anthropic/handler.go).

### Ollama Compatibility

| Method | Path            | Request and response shape                                                                                |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/version`  | Version JSON                                                                                              |
| GET    | `/api/tags`     | `{models:[...]}`                                                                                          |
| GET    | `/api/ps`       | Loaded-model listing in Ollama shape                                                                      |
| POST   | `/api/show`     | `{model,...}` → model metadata                                                                            |
| POST   | `/api/chat`     | `{model,messages,stream?,options?,...}` → Ollama chat response or incremental JSON chunks                 |
| POST   | `/api/generate` | `{model,prompt,stream?,options?,keep_alive?,...}` → Ollama generation response or incremental JSON chunks |
| POST   | `/api/pull`     | `{model,stream?,...}` → Ollama progress JSON/NDJSON                                                       |
| DELETE | `/api/delete`   | `{model}` → deletion result                                                                               |

These are the routes registered by [`v1.2.9`'s Ollama handler](https://github.com/docker/model-runner/blob/v1.2.9/pkg/ollama/http_handler.go). The [public API page](https://docs.docker.com/ai/model-runner/api-reference/#ollama-compatible-api) lists `POST /api/embeddings`, but the tagged handler does not register it. `[INFERENCE]` Treat Ollama embeddings as unverified and use `/engines/v1/embeddings` instead.

### OpenAI Responses Compatibility

The implementation supports prefixes `R` equal to `/responses`, `/v1/responses`, `/engines/responses`, `/engines/v1/responses`, and `/engines/{backend}/v1/responses`:

| Method | Path                 | Request and response shape                                                                                                |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| POST   | `R`                  | `{model,input,instructions?,tools?,text?,stream?,...}` → Responses JSON/events, translated internally to chat completions |
| GET    | `R/{id}`             | Stored response                                                                                                           |
| GET    | `R/{id}/input_items` | Input-item listing                                                                                                        |
| DELETE | `R/{id}`             | Delete stored response                                                                                                    |

These routes are not in the current public API inventory. The standalone daemon enables the compatibility layer; embedded/Desktop distributions can choose whether to enable it. Sources: [router option and prefixes](https://github.com/docker/model-runner/blob/v1.2.9/pkg/routing/router.go), [Responses route registration](https://github.com/docker/model-runner/blob/v1.2.9/pkg/responses/handler.go), and [standalone daemon option](https://github.com/docker/model-runner/blob/v1.2.9/pkg/server/server.go).

### Streaming, Usage, Tools, Structured Output, and Context

- OpenAI `stream:true` enables SSE completion chunks. The recorder processes `data: ...` frames and `[DONE]`; Ollama compatibility translates these into Ollama incremental JSON rather than exposing the same SSE wire format. Sources: [streaming example](https://docs.docker.com/ai/model-runner/api-reference/#streaming-responses), [recorder](https://github.com/docker/model-runner/blob/v1.2.9/pkg/metrics/openai_recorder.go), and [Ollama translation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/ollama/http_handler.go).
- For chat completions, send `stream_options:{"include_usage":true}`. The scheduler forwards the original request body, and the pinned llama.cpp `b9879` implementation emits an extra usage chunk with `choices:[]`, `usage.prompt_tokens`, `completion_tokens`, and `total_tokens`. `[INFERENCE]` Equivalent behavior across every alternative backend requires testing. Sources: [DMR forwarding](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go) and [pinned engine usage chunk](https://github.com/ggml-org/llama.cpp/blob/b9879/tools/server/server-task.cpp#L526-L537).
- Nonstreamed completion usage uses those same three token counts; tool-call deltas use OpenAI `tool_calls`, `index`, and function argument strings. See [CLI request/response structs](https://github.com/docker/model-runner/blob/v1.2.9/cmd/cli/desktop/api.go).
- Public documentation promises function calling with llama.cpp and compatible models, vision for multimodal models, logprobs, and JSON mode using `response_format:{"type":"json_object"}`. These are not model-independent guarantees. See the [OpenAI limitations table](https://docs.docker.com/ai/model-runner/api-reference/#limitations-and-differences-from-openai).
- Responses structured output arrived in `v1.2.7`; `text.format` supports `json_object` and `json_schema`, translating schema/name/strict into chat `response_format`. Sources: [release](https://github.com/docker/model-runner/releases/tag/v1.2.7) and [translation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/responses/transform.go).
- Responses API `stream_options` is explicitly rejected; this is separate from chat-completions `stream_options.include_usage`. See [Responses validation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/responses/handler.go).
- Context is model- and engine-dependent. Documentation gives llama.cpp baseline 4096 tokens and vLLM's model-trained maximum, while also noting model-specific defaults. `inspect` reports model metadata/maximum, not necessarily the configured runtime limit. See [configuration](https://docs.docker.com/ai/model-runner/configuration/).

## Model Management API

The native pull request is `{"from":"ai/smollm2"}`, not `{"model":"ai/smollm2"}`. Native `GET /models` returns an array, not the OpenAI `{data:[...]}` envelope. Sources: [request/model types](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/api.go), [handlers](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/http_handler.go), and [manager](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/manager.go).

| Method | Path                                               | Request and response shape                                                                      |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/models/create`                                   | `{from:"ai/smollm2","bearer-token":"optional registry token"}` → chunked pull progress          |
| GET    | `/models`                                          | `[{id,tags?,created,config},...]`                                                               |
| GET    | `/models/{ref...}`                                 | `{id,tags?,created,config}`                                                                     |
| GET    | `/models/{ref...}?remote=true`                     | Remote-registry inspection → same native model envelope                                         |
| DELETE | `/models/{ref...}?force=true`                      | Delete/untag → array of `{Untagged:"..."}` / `{Deleted:"..."}`; missing model 404, conflict 409 |
| DELETE | `/models/purge`                                    | Purge local model content → empty success body                                                  |
| POST   | `/models/load`                                     | Packaged model archive body → distribution-loading output; imports content, not VRAM loading    |
| GET    | `/models/{ref...}/export`                          | `application/x-tar` archive                                                                     |
| POST   | `/models/{ref...}/tag?repo=myorg/model&tag=latest` | 201 `{message,target}`                                                                          |
| POST   | `/models/{ref...}/push`                            | Optional `{"bearer-token":"..."}` → progress stream                                             |
| POST   | `/models/{ref...}/repackage`                       | `{target:"...",context_size:8192}` → 201 `{message,source,target}`                              |

Deletion's capitalized keys come from [`DeleteModelAction`](https://github.com/docker/model-runner/blob/v1.2.9/pkg/distribution/distribution/client.go); native `config` is a format-dependent model configuration object, not one fixed backend runtime schema.

### Pull Progress Is NDJSON, Not SSE

Set `Accept: application/json` exactly. The manager then serves raw JSON progress with content type `application/json`; the progress writer emits one JSON object per newline, so the framing is NDJSON rather than one JSON document. Without that exact Accept value, the manager labels the response `text/plain` and HTML-escapes writes. Sources: [Accept negotiation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/manager.go#L211-L267), [response writer](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/models/http_handler.go), and [newline encoder](https://github.com/docker/model-runner/blob/v1.2.9/pkg/distribution/internal/progress/reporter.go#L145-L155).

```json
{"type":"progress","message":"Downloaded: ...","total":123456789,"layer":{"id":"sha256:...","size":123456789,"current":4194304},"mode":"pull"}
{"type":"success","message":"...","total":0,"layer":{"size":0,"current":0},"mode":"pull"}
```

`type` is `progress|success|warning|error`; `mode` is `pull|push`; `total`, `layer.size`, and `layer.current` are byte counts. `message` is deprecated for progress/success but retained for warnings/errors. `[INFERENCE]` Parse incremental lines and terminal error records, not only HTTP status. See the [progress schema](https://github.com/docker/model-runner/blob/v1.2.9/pkg/distribution/oci/progress.go).

## Engine Operations

These operations back `docker model status`, `ps`, `df`, `unload`, `configure`, and `requests`. Sources: [route handlers](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go), [operation types](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/api.go), and [configuration types](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backend.go).

| Method | Path                                   | Request and response shape                                                                                           |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/engines/status`                      | `{backendName:"Running: ..." or "Not Installed: ..." or "Error: ...",...}`; installation states may also be reported |
| GET    | `/engines/ps`                          | `[{backend_name,model_name,mode,last_used?,in_use?,loading?,keep_alive?},...]`                                       |
| GET    | `/engines/df`                          | `{models_disk_usage,default_backend_disk_usage}` in bytes; not complete per-backend accounting                       |
| POST   | `/engines/unload`                      | `{all:false,backend:"llama.cpp",models:["ai/smollm2"]}` → `{unloaded_runners:1}`                                     |
| POST   | `/engines/_configure`                  | Runtime configuration body → 202, then background model preload                                                      |
| POST   | `/engines/{backend}/_configure`        | Same configuration operation with explicit backend                                                                   |
| GET    | `/engines/_configure?model=ai/smollm2` | Optional model filter → entries with capitalized `Backend`, `Model`, `ModelID`, `Mode`, `Config`                     |
| POST   | `/engines/install-backend`             | `{backend:"...",version:"optional"}` → empty 200                                                                     |
| POST   | `/engines/uninstall-backend`           | `{backend:"..."}` → empty 200                                                                                        |
| GET    | `/engines/requests?model=...`          | JSON trace records or SSE, depending on Accept header                                                                |

The unload route is `/engines/unload`, not `/engines/_unload`. The handler states that runners handling active inference cannot currently be unloaded. See [Unload handler](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go).

Example configuration payload:

```json
{
  "model": "ai/qwen2.5-coder",
  "mode": "completion",
  "context-size": 8192,
  "runtime-flags": ["--temp", "0.2"],
  "keep_alive": "5m",
  "llamacpp": { "reasoning-budget": 1024 }
}
```

Other fields include `raw-runtime-flags`, `speculative`, and `vllm` settings `hf-overrides` and `gpu-memory-utilization`. Keep-alive is a string duration such as `"5m"`, `"0"`, or `"-1"`; the default is five minutes, zero means unload immediately when idle, and negative values mean keep loaded forever. Sources: [ConfigureRequest](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/api.go) and [BackendConfiguration/KeepAlive](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/backend.go).

Configure may return 409 if the runner is active. A 202 is not a readiness guarantee: background preload can fail after the response. The configuration guide says CLI configuration persists until model removal and distinguishes configured context from the maximum reported by inspection. Sources: [Configure handler](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go) and [configuration guide](https://docs.docker.com/ai/model-runner/configuration/).

## Status, Metrics, Logs, and Request Inspection

| Method | Path                                                                                 | Response and options                                                                                                        |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                                                                                  | Plain text `Docker Model Runner is running`                                                                                 |
| GET    | `/version`                                                                           | `{version:"..."}`                                                                                                           |
| GET    | `/metrics`                                                                           | Aggregated Prometheus text; labels include `backend`, `model`, `mode`                                                       |
| GET    | `/logs?follow=true&no-engines=true`                                                  | Plain text; optional continuous following and engine-log exclusion                                                          |
| GET    | `/engines/requests?model=...`                                                        | `[{count,model,config,records:[{id,model,method,url,request,response?,error?,timestamp,status_code,user_agent?,origin?}]}]` |
| GET    | `/engines/requests?model=...&include_existing=true` with `Accept: text/event-stream` | Events `connected`, `new_request`, optional `existing_request`, and errors with JSON payloads                               |

Sources: [daemon routes](https://github.com/docker/model-runner/blob/v1.2.9/pkg/server/server.go), [metrics documentation](https://github.com/docker/model-runner/blob/v1.2.9/METRICS.md), [log query semantics](https://github.com/docker/model-runner/blob/v1.2.9/pkg/logs/http_handler.go), and [recorder schemas/SSE](https://github.com/docker/model-runner/blob/v1.2.9/pkg/metrics/openai_recorder.go).

The daemon enables `/metrics` by default unless `DISABLE_METRICS` is truthy. Metrics aggregate active llama.cpp runners; they are not a substitute for per-request usage. Logs depend on the daemon's log-directory setup. Embedded/Desktop availability of standalone operational routes is distribution-dependent. Sources: [daemon setup](https://github.com/docker/model-runner/blob/v1.2.9/pkg/server/server.go) and [metrics scope](https://github.com/docker/model-runner/blob/v1.2.9/METRICS.md).

## Model Sources and Packaging

Docker Hub's curated namespace is `ai/`, with references such as `ai/smollm2:360M-Q4_K_M`; other OCI registries are supported. Direct Hugging Face pulls use references such as `hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF`; Docker describes GGUF content being packaged as OCI artifacts on the fly. Sources: [pull and publish guide](https://docs.docker.com/ai/model-runner/get-started/) and [GA explanation of distribution](https://www.docker.com/blog/announcing-docker-model-runner-ga/).

`docker model package` accepts one of `--gguf`, `--safetensors-dir`, `--dduf`, or `--from`. Options include context size, licenses, multimodal projector, Jinja chat template, and `--format docker|cncf`. Packaging loads locally by default; `--push` publishes to a registry. For sharded GGUF, point at the first indexed shard. See the [package reference](https://docs.docker.com/reference/cli/docker/model/package/).

The engine guide shows stale `--safetensors` spelling; the generated package reference names `--safetensors-dir`. `[INFERENCE]` Use the generated CLI reference and the installed version's help rather than copying the engine-guide example unchanged. Sources: [engine guide](https://docs.docker.com/ai/model-runner/inference-engines/) and [package command](https://docs.docker.com/reference/cli/docker/model/package/).

## Security and Plaintext Boundaries

- The DMR API is unauthenticated. Docker says any reachable client can pull, load, run models, and send inference. The OpenAI compatibility page says the Authorization header is ignored; a dummy API key is not access control. Sources: [network security](https://docs.docker.com/ai/model-runner/#networking) and [OpenAI limitations](https://docs.docker.com/ai/model-runner/api-reference/#limitations-and-differences-from-openai).
- Engine installation defaults to host `127.0.0.1`, but the CLI intentionally also publishes on the Docker bridge gateway in applicable rootful configurations. Therefore loopback defaults do not imply that only host processes can reach it. Sources: [install default](https://docs.docker.com/reference/cli/docker/model/install-runner/) and [bridge port binding](https://github.com/docker/model-runner/blob/v1.2.9/cmd/cli/pkg/standalone/containers.go#L471-L499).
- The raw daemon's TCP listener is `:<port>`, not explicitly loopback. Host exposure of a containerized runner is separately controlled by port publishing; manually started binaries also need appropriate network isolation. See [server listener](https://github.com/docker/model-runner/blob/v1.2.9/pkg/server/server.go).
- CORS is not authentication: requests with no Origin header proceed. The middleware rejects nonempty disallowed origins. Desktop exposes `--cors none`; the daemon reads `DMR_ORIGINS`. Sources: [middleware](https://github.com/docker/model-runner/blob/v1.2.9/pkg/middleware/cors.go), [environment settings](https://github.com/docker/model-runner/blob/v1.2.9/pkg/envconfig/envconfig.go), and [Desktop flags](https://docs.docker.com/reference/cli/docker/desktop/enable/model-runner/).
- TLS is available through `--tls`, certificate/key, and port settings, but server-side HTTPS is not client authentication. See [install TLS options](https://docs.docker.com/reference/cli/docker/model/install-runner/).
- Local prompt tracing is distinct from outbound telemetry. `OpenAIRecorder` stores request/response strings in an in-memory map, retaining ten records per model, and buffers streamed responses. The unauthenticated `/engines/requests` route exposes those records. See [recorder storage and limit](https://github.com/docker/model-runner/blob/v1.2.9/pkg/metrics/openai_recorder.go).

### Can Recording Be Disabled?

No supported recorder-disable flag or environment variable was found in the inspected `v1.2.9` implementation. `NewScheduler` unconditionally constructs `OpenAIRecorder`; the inference handler unconditionally records ordinary inference requests/responses; the route table unconditionally registers `/engines/requests`. The environment configuration exposes `DISABLE_METRICS`, but that controls the Prometheus endpoint, not prompt recording. Sources: [scheduler construction](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/scheduler.go), [recording calls and route registration](https://github.com/docker/model-runner/blob/v1.2.9/pkg/inference/scheduling/http_handler.go), [recorder implementation](https://github.com/docker/model-runner/blob/v1.2.9/pkg/metrics/openai_recorder.go), and [complete daemon environment configuration](https://github.com/docker/model-runner/blob/v1.2.9/pkg/envconfig/envconfig.go).

The install flag `--do-not-track` concerns model-usage tracking, not this local prompt cache. Docker's privacy page says prompts/responses are not collected by its outbound usage telemetry; that statement does not mean the local recorder is absent. Sources: [install flag](https://docs.docker.com/reference/cli/docker/model/install-runner/) and [privacy section](https://docs.docker.com/ai/model-runner/#privacy-and-data-collection).

`[INFERENCE]` For Radium's threat model, treat `/engines/requests` as a local plaintext prompt cache that Radium cannot disable through DMR's supported `v1.2.9` interfaces. A firewall/reverse proxy can restrict endpoint access, but blocking the route does not stop the underlying in-memory recording. Radium's server-side encryption guarantees must not imply that the local inference host contains no plaintext.

## Version History and Stability

| Release or milestone        | Date       | Relevant change                                                                                                |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| Initial beta / Desktop 4.40 | April 2025 | Initial DMR product launch                                                                                     |
| General availability        | 2025-09-18 | Product announced GA                                                                                           |
| `dmr-v0.1.0`                | 2026-07-07 | Separate native standalone daemon/CLI release stream                                                           |
| `v1.2.6`                    | 2026-07-09 | Engine-independent standalone `dmr` rewrite; pinned llama.cpp per release; deferred macOS/Windows installation |
| `v1.2.7`                    | 2026-08-11 | Responses structured output                                                                                    |
| `v1.2.8`                    | 2026-08-12 | Authenticated model pulls behind proxies fixed                                                                 |
| `v1.2.9`                    | 2026-10-22 | Responses streamed tool-call argument joining fix; llama.cpp reasoning allowlist and pull/proxy fixes          |

Sources: [GA retrospective](https://www.docker.com/blog/announcing-docker-model-runner-ga/), [`dmr-v0.1.0`](https://github.com/docker/model-runner/releases/tag/dmr-v0.1.0), [`v1.2.6`](https://github.com/docker/model-runner/releases/tag/v1.2.6), [`v1.2.7`](https://github.com/docker/model-runner/releases/tag/v1.2.7), [`v1.2.8`](https://github.com/docker/model-runner/releases/tag/v1.2.8), and [`v1.2.9`](https://github.com/docker/model-runner/releases/tag/v1.2.9).

The tagged `.versions` file declares llama.cpp `b9879`, vLLM `0.19.1`, upstream vLLM `0.19.0`, SGLang `0.5.6`, vLLM-Metal bundle `v0.2.0-20260420-142150`, and Diffusers bundle `v0.1.0-20260617-000000`. Release notes mention later llama.cpp bumps while that file retains `b9879`; `[INFERENCE]` query installed backend status rather than infer it from release prose. Source: [tagged `.versions`](https://github.com/docker/model-runner/blob/v1.2.9/.versions).

DMR has a public REST reference and is not CLI-only. However, no comprehensive native REST backward-compatibility or schema-versioning guarantee was found in the inspected material. Product GA should not be interpreted as a promise that every source-only route is frozen. The Desktop socket proxy retains an `/exp/vDD4.40` prefix; its long-term compatibility is unverified. Sources: [REST reference](https://docs.docker.com/ai/model-runner/api-reference/), [GA announcement](https://www.docker.com/blog/announcing-docker-model-runner-ga/), and [socket example](https://docs.docker.com/ai/model-runner/api-reference/#request-from-the-host-using-a-unix-socket).

`[INFERENCE]` The strongest initial contract is the documented OpenAI chat-completions interface plus explicitly tested native management operations. Capability-detect optional engines and source-only operations; record runner/backend versions and establish a tested minimum rather than assume all Desktop installations expose identical APIs.

## Implications for Radium

- `[INFERENCE]` The Worker should be Radium's only DMR client. The browser and Convex server should communicate through Radium's authenticated machine/job transport, not connect directly to an unauthenticated local runner.
- `[INFERENCE]` Configure the loopback base URL locally on the Worker, never from a server-supplied arbitrary URL. This keeps local network/daemon authority on the user's machine and avoids making the Worker a server-directed HTTP proxy.
- `[INFERENCE]` Record the installed DMR version, backend status, and minimum tested DMR version in Worker capabilities. This research snapshot is not evidence that a particular minimum has passed Radium integration tests.
- `[INFERENCE]` Capability-detect engines through `/engines/status`, use llama.cpp as the initial baseline, and do not expose every source-registered backend as supported without platform tests.
- `[INFERENCE]` Use OpenAI chat completions with base `/engines/v1`, `stream:true`, and `stream_options:{"include_usage":true}`. Preserve incremental bytes, tool-call deltas, the empty-choices usage chunk, terminal status, and cancellation across the Worker transport.
- `[INFERENCE]` Recommend Desktop `--cors none` because the Worker is a native HTTP client; do not open browser origins merely to support Radium's web UI. Keep the runner private and account for Docker bridge exposure separately from CORS.
- `[INFERENCE]` Surface model management as Worker-executed operations, parsing `/models/create` as newline-delimited JSON and distinguishing configuration acceptance from model readiness.
- `[INFERENCE]` Treat `/engines/requests` as a local plaintext prompt cache that Radium cannot disable through the inspected supported interfaces. Avoid copying those traces to Convex by default, and state explicitly that encryption of Radium's stored data does not eliminate DMR's local plaintext processing/cache.
