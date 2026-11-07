# Local Model Management

Status: **planned.** Part of [Local models](../Local_Models.md). DMR endpoints referenced here are documented in the [DMR research](../research/Docker_Model_Runner.md#model-management-api).

## Runtime Discovery

A Worker started with `--local-models` probes its DMR URL at start and on every presence report (20 s, `packages/worker/README.md`) and keeps a runtime snapshot:

| Snapshot field          | DMR source                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reachable, version      | `GET /`, `GET /version`                                                                                       |
| Engines and their state | `GET /engines/status`                                                                                         |
| Disk usage              | `GET /engines/df`                                                                                             |
| Models                  | `GET /models` (id, tags, created, config: format, quantization, parameters, architecture, size, context size) |
| Loaded models           | `GET /engines/ps`                                                                                             |
| Runtime configs         | `GET /engines/_configure`                                                                                     |

The Worker writes only what changed to `local_runtimes` (one row per Worker) and `local_runtime_models` (one row per model), the same "index, don't copy" rule as the [ACP session index](../ACP.md#principles). Model names and sizes are class P under [E2EE](../E2EE/Data.md#classification): the router needs them, and they are catalog data, not user content.

The runtime row also records the DMR version. Radium documents a minimum tested DMR version; older runtimes are reported with a warning, not refused, because the API is not formally versioned ([research](../research/Docker_Model_Runner.md#version-history-and-stability)).

## Commands

Owners act on a runtime through `local_model_commands`, modeled on `acp_commands`: the browser inserts a command for a Worker, the Worker subscribes, claims, executes and reports. Each kind maps to one DMR call:

| Command           | DMR call                                                          | Arguments the Worker accepts                                                                    |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pull`            | `POST /models/create` `{"from": ref}`, `Accept: application/json` | Model reference (`ai/…`, `hf.co/…`, other OCI registry); no registry token in the first release |
| `delete`          | `DELETE /models/{ref}` (optional `force`)                         | Reference of a model in the store                                                               |
| `configure`       | `POST /engines/_configure`                                        | Reference, context size, keep-alive, mode, reasoning budget                                     |
| `unload`          | `POST /engines/unload`                                            | References or all                                                                               |
| `install-backend` | `POST /engines/install-backend`                                   | Engine name from the runtime's reported list                                                    |
| `refresh`         | Re-run discovery                                                  | None                                                                                            |

- **Pull progress** is NDJSON, not SSE ([research](../research/Docker_Model_Runner.md#pull-progress-is-ndjson-not-sse)). The Worker parses lines and writes progress (bytes done, total, current layer) to the command row at most once per second; the UI shows a progress bar. `error` lines end the command as failed even with HTTP 200.
- **Configure** returns 202 and preloads in the background; success means "accepted", and the Worker reports readiness from the next `/engines/ps`. 409 (runner busy) is surfaced as "in use, try again".
- **No raw runtime flags.** `runtime-flags` and `raw-runtime-flags` pass arguments straight to llama.cpp or vLLM; the Worker does not accept them. Only the named fields above are forwarded.
- **Signed commands.** Once [E2EE](../E2EE/Keys.md#workers) ships, the Worker executes a command only with a valid owner signature; until then it relies on owner-only authorization in Convex, as ACP commands do today.
- Commands are pruned five minutes after they finish, like ACP commands.

## Publishing To Gateway

A model in a runtime is not usable until an owner **publishes** it:

| Field          | Default                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Slug           | `local/<model name without registry and tag>`, editable, unique in the workspace                                        |
| Instances      | The runtime it was published from; more Workers holding the same reference can be added                                 |
| Capabilities   | From DMR's model config where it reports them (context size); tools, vision and reasoning are owner-set, off by default |
| Context length | The configured context size, else the model's maximum                                                                   |
| Rates          | Zero, marked local                                                                                                      |

The slug maps to a global `models` record (created if missing, as custom provider models are) and to the local instances that serve it. Gateway model listing (`convex/models.ts`) and the Chatroom model selector include it with each instance's availability. Unpublishing removes the mapping; it does not delete the model from DMR.

## Routing

[Task 04](../tasks/04_Upstream_Instances.md) separates endpoint instances from credentials; local instances are the first credential-free kind. Concretely, the current credential-shaped routing gains a discriminated target:

- `resolveRoutableProviders` (`convex/providers.ts`) returns local instances whose Worker is active and online, whose runtime is reachable, and whose store holds the published model, alongside credential targets.
- `RoutableTarget`, cooldown keys, exclusion and session affinity (`src/routing/`) key on the instance instead of a credential.
- `createRoutedProvider` (`src/routing/connector.ts`) builds the `@ai-sdk/openai-compatible` connector with the [Worker fetch tunnel](Transport.md#worker-fetch-tunnel) instead of reading a credential.
- Session affinity matters more than for remote providers: a Worker keeps the model's KV cache warm, so consecutive turns of a session should stay on the same instance.

## UI

**Gateway → Local models**, owner-only, a new section in `apps/web/src/components/gateway/gateway-settings.tsx` next to Providers and Credentials, following [Interface design](../Interface_Design.md):

- One group per Worker serving models: runtime status (`RunState` signal), DMR version, engines, disk used; a link to the Worker in Chatroom → Workers. Workers without `--local-models` are listed with the command to enable it.
- Models as Rows: reference (mono), size, quantization, context size, loaded state, published slug as a Tag. Row actions: Publish/Unpublish, Configure, Unload, Delete.
- "Pull model" opens a dialog with a reference field; progress shows inline on the new Row.
- A short notice that DMR keeps recent prompts readable on its local API ([privacy](../Local_Models.md#privacy)).

Members see published local models in the model selector only.

## Permissions

| Action                                   | Who                                               |
| ---------------------------------------- | ------------------------------------------------- |
| Turn serving on for a machine            | Whoever runs the Worker (`--local-models`)        |
| Pull, delete, configure, unload, publish | Workspace owner                                   |
| Use a published model                    | Owner and members, through Gateway like any model |
| See runtimes and stores                  | Workspace owner                                   |

The Worker validates every command against its own rules (allowed kinds and fields, references it reports) regardless of what Convex authorized.
