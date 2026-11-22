import { z } from "zod";
import { bytes } from "../wire";

/**
 * Runtime-neutral ACP relay contract shared by Convex, the Worker and (later) Chatroom.
 *
 * The Worker is the ACP client: raw JSON-RPC never leaves it. It normalizes agent output into
 * timeline ops (below) and relays them through Convex in `chat_frames`; durable intent travels as
 * `acp_commands` (browser → Worker) and `acp_interactions` (agent requests answered in Chatroom).
 * Nothing here contains agent credentials. Conversation content exists in Convex only while a
 * Session is warm (see `docs/ACP/Transport.md`).
 *
 * Imports are limited to `convex/values` so the Worker can depend on this module directly.
 */

// ---------------------------------------------------------------------------------------------
// Bounds and timing
// ---------------------------------------------------------------------------------------------

/** Largest serialized ops payload of one frame (UTF-8 bytes). */
export const ACP_FRAME_BYTES = 32 * 1024;
/** Frames one `appendFrames` call may carry, keeping a mutation well under Convex write limits. */
export const ACP_FRAMES_PER_APPEND = 8;
/** Budget of the snapshot that opens a warm epoch: the current turn plus the latest items. */
export const ACP_SNAPSHOT_BYTES = 64 * 1024;
/** Past this many frame bytes in one epoch, the Worker starts a new epoch at the next turn end. */
export const ACP_EPOCH_ROLLOVER_BYTES = 1024 * 1024;
/** Per-item cap for tool content and raw input/output; the rest stays in the agent. */
export const ACP_ITEM_CONTENT_BYTES = 256 * 1024;
/** Largest accepted prompt payload (UTF-8 bytes of its JSON). */
export const ACP_PROMPT_BYTES = 64 * 1024;
/** Largest serialized interaction request (permission content, elicitation schema). */
export const ACP_INTERACTION_REQUEST_BYTES = 32 * 1024;
/** Largest serialized transient command result (UTF-8 bytes). */
export const ACP_COMMAND_RESULT_BYTES = 64 * 1024;
/** Most items one history page may return. */
export const ACP_HISTORY_PAGE_ITEMS = 200;
/** Most items one history request streams, as consecutive pages (the Worker caches 8 MiB). */
export const ACP_HISTORY_REQUEST_ITEMS = 10_000;
/**
 * Item bytes one history page may carry (one larger item still goes alone). Must stay well under
 * the relay's 1 MiB outage buffer, which would otherwise drop the page and restart the epoch.
 */
export const ACP_HISTORY_PAGE_BYTES = 256 * 1024;
/** Maximum agent sessions indexed by one sync; writes are sent in bounded chunks. */
export const ACP_AGENT_SESSIONS_MAX = 2000;
export const ACP_AGENT_SESSIONS_SYNC_CHUNK = 200;
/** Most warm (streaming) Sessions per Worker; Watch and Prompt refuse to warm one more. */
export const ACP_WARM_SESSIONS_MAX = 64;

/** A Tab showing a Session renews its viewer row this often. */
export const ACP_VIEWER_HEARTBEAT_MS = 60_000;
/** A warm Session goes cold this long after its last heartbeat (or warming without one). */
export const ACP_COLD_AFTER_MS = 5 * 60_000;
/** Frames of a superseded epoch are deleted this long after the switch. */
export const ACP_SUPERSEDED_EPOCH_MS = 60_000;
/** Finished command rows are pruned this long after they finish. */
export const ACP_COMMAND_RETENTION_MS = 5 * 60_000;
/** Commands a Worker never claimed expire after this long (`close`/`delete` outlive their chat). */
export const ACP_COMMAND_EXPIRY_MS = 7 * 24 * 60 * 60_000;
/** Resolved interaction rows are pruned this long after resolution. */
export const ACP_INTERACTION_RETENTION_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Agent IDs: registry ids or owner-chosen custom ids. */
export const ACP_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Whether `id` is a well-formed agent id. */
export function validAcpAgentId(id: string): boolean {
  return ACP_AGENT_ID_PATTERN.test(id);
}

/** Bounded opaque identifier (ACP session ids, option ids, client ids, request keys). */
export function validAcpToken(value: string, maxLength = 256): boolean {
  return value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

/** UTF-8 byte length of a string, used for every bound above. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------------------------------------
// Session binding and status
// ---------------------------------------------------------------------------------------------

/**
 * `aisdk_chats.agent`: which ACP agent and launch profile on which Worker owns the conversation.
 * Set once at creation; only `sessionId` is written later, once, by the bound Worker.
 */
export const acpProfileValidator = z.union([z.literal("native"), z.literal("gateway")]);
export type AcpProfile = z.infer<typeof acpProfileValidator>;

export const acpChatAgentValidator = z.object({
  kind: z.literal("acp"),
  worker: z.string(),
  agentId: z.string(),
  profile: acpProfileValidator,
  agentVersion: z.string(),
  cwd: z.string(),
  sessionId: z.optional(z.string()),
});
export type AcpChatAgent = z.infer<typeof acpChatAgentValidator>;

/** `acp_sessions.status`; mapped to the UI `RunState` once at the data boundary. */
export const acpSessionStatusValidator = z.union([
  z.literal("starting"),
  z.literal("idle"),
  z.literal("running"),
  z.literal("awaiting"),
  z.literal("failed"),
  z.literal("ended"),
]);
export type AcpSessionStatus = z.infer<typeof acpSessionStatusValidator>;

/** Statuses during which a prompt is admitted or in flight; a second prompt is rejected. */
export const ACP_BUSY_STATUSES: readonly AcpSessionStatus[] = ["starting", "running", "awaiting"];

/** ACP v1 `StopReason`. */
export const acpStopReasonValidator = z.union([
  z.literal("end_turn"),
  z.literal("max_tokens"),
  z.literal("max_turn_requests"),
  z.literal("refusal"),
  z.literal("cancelled"),
]);
export type AcpStopReason = z.infer<typeof acpStopReasonValidator>;

/** How much history the agent gave back when the Worker set the session up. */
export const acpHistoryValidator = z.union([
  z.literal("full"),
  z.literal("resumed"),
  z.literal("none"),
]);

// ---------------------------------------------------------------------------------------------
// Agent-advertised surface (config, modes, commands, usage) in Radium's normalized shape
// ---------------------------------------------------------------------------------------------

/** One choice of a select config option; `group` names the ACP option group, when grouped. */
export const acpConfigChoiceValidator = z.object({
  value: z.string(),
  name: z.string(),
  description: z.optional(z.string()),
  group: z.optional(z.string()),
});

/** An agent config option (`model`, `thought_level`, `mode`, or agent-specific categories). */
export const acpConfigOptionValidator = z.union([
  z.object({
    type: z.literal("select"),
    id: z.string(),
    name: z.string(),
    description: z.optional(z.string()),
    category: z.optional(z.string()),
    currentValue: z.string(),
    choices: z.array(acpConfigChoiceValidator),
  }),
  z.object({
    type: z.literal("boolean"),
    id: z.string(),
    name: z.string(),
    description: z.optional(z.string()),
    category: z.optional(z.string()),
    currentValue: z.boolean(),
  }),
]);
export type AcpConfigOption = z.infer<typeof acpConfigOptionValidator>;

/** Session modes (`modes` in `session/new`, `current_mode_update`). */
export const acpModesValidator = z.object({
  currentModeId: z.string(),
  available: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.optional(z.string()) }),
  ),
});

/** Complete config state; a config response or update replaces it whole. */
export const acpConfigValidator = z.object({
  options: z.array(acpConfigOptionValidator),
  modes: z.optional(acpModesValidator),
});
export type AcpConfig = z.infer<typeof acpConfigValidator>;

/** One `available_commands_update` entry; `hint` is the unstructured input hint. */
export const acpCommandInfoValidator = z.object({
  name: z.string(),
  description: z.string(),
  hint: z.optional(z.string()),
});
export type AcpCommandInfo = z.infer<typeof acpCommandInfoValidator>;

/** Latest `usage_update`: context tokens used/size and optional cumulative cost. */
export const acpUsageValidator = z.object({
  used: z.number(),
  size: z.number(),
  cost: z.optional(z.object({ amount: z.number(), currency: z.string() })),
});
export type AcpUsage = z.infer<typeof acpUsageValidator>;

/**
 * Token breakdown of the latest `session/prompt` response (unstable ACP `PromptResponse.usage`).
 * Agents disagree on whether it covers the turn or the whole session (agent-client-protocol#1860).
 * Usage records read it as the turn's usage, which is what `PromptResponse` documents and the Claude
 * and Codex bridges send; the session row keeps only the latest value for the context meter.
 */
export const acpTurnUsageValidator = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  thoughtTokens: z.optional(z.number()),
  cachedReadTokens: z.optional(z.number()),
  cachedWriteTokens: z.optional(z.number()),
});
export type AcpTurnUsage = z.infer<typeof acpTurnUsageValidator>;

/** The agent's model choice for one turn, as advertised (`selectedAcpModel`). */
export const acpTurnModelValidator = z.object({
  id: z.string(),
  name: z.string(),
  description: z.optional(z.string()),
});

/**
 * Usage facts of one finished prompt turn, sent once with the turn-end patch. The Worker owns
 * every field: `command` is the claimed prompt (idempotency key across retried patches), `model`
 * the choice at turn start, and `cost` the turn's share of the agent's cumulative `usage_update`
 * cost, present only when both ends of the turn are known in one currency. Convex only prices it.
 */
export const acpTurnReportValidator = z.object({
  command: z.string(),
  startedAt: z.number(),
  model: z.optional(acpTurnModelValidator),
  cost: z.optional(z.object({ amount: z.number(), currency: z.string() })),
});
export type AcpTurnReport = z.infer<typeof acpTurnReportValidator>;

/** Choices made before the ACP session exists, applied by the Worker right after `session/new`. */
export const acpDraftConfigValidator = z.object({
  config: z.array(z.object({ configId: z.string(), value: z.union([z.string(), z.boolean()]) })),
  modeId: z.optional(z.string()),
});
export type AcpDraftConfig = z.infer<typeof acpDraftConfigValidator>;

// ---------------------------------------------------------------------------------------------
// Agent catalog (`worker_agents`)
// ---------------------------------------------------------------------------------------------

/** Capability summary from `initialize`; absent ACP capabilities are `false`. */
export const acpAgentCapabilitiesValidator = z.object({
  loadSession: z.boolean(),
  list: z.boolean(),
  resume: z.boolean(),
  close: z.boolean(),
  delete: z.boolean(),
  fork: z.boolean(),
  logout: z.boolean(),
  image: z.boolean(),
  audio: z.boolean(),
  embeddedContext: z.boolean(),
  mcpHttp: z.boolean(),
  mcpSse: z.boolean(),
});
export type AcpAgentCapabilities = z.infer<typeof acpAgentCapabilitiesValidator>;

/** Advertised `authMethods`; terminal methods run only through the Worker CLI. */
export const acpAuthMethodValidator = z.object({
  id: z.string(),
  name: z.string(),
  type: z.union([z.literal("agent"), z.literal("terminal")]),
  description: z.optional(z.string()),
});
export type AcpAuthMethod = z.infer<typeof acpAuthMethodValidator>;

/** Agent availability on one Worker. */
export const acpAgentStatusValidator = z.union([
  z.literal("ready"),
  z.literal("needs_auth"),
  z.literal("unavailable"),
  z.literal("failed"),
]);
export type AcpAgentStatus = z.infer<typeof acpAgentStatusValidator>;

/** One agent as the Worker reports it; the Worker owns every field. */
export const acpAgentReportValidator = z.object({
  agentId: z.string(),
  name: z.string(),
  version: z.string(),
  icon: z.optional(z.string()),
  source: z.union([z.literal("registry"), z.literal("custom")]),
  status: acpAgentStatusValidator,
  /** Short reason for `unavailable`/`failed`; never stderr or credentials. */
  error: z.optional(z.string()),
  capabilities: acpAgentCapabilitiesValidator,
  authMethods: z.array(acpAuthMethodValidator),
  /** Last config/commands seen from `session/new` on this Worker, for drafts. */
  defaults: z.optional(
    z.object({
      config: z.optional(acpConfigValidator),
      commands: z.optional(z.array(acpCommandInfoValidator)),
    }),
  ),
});
export type AcpAgentReport = z.infer<typeof acpAgentReportValidator>;

// ---------------------------------------------------------------------------------------------
// Agent definitions (`acp_agents`): owner-managed in Chatroom → Agents, probed by every Worker
// ---------------------------------------------------------------------------------------------

/** Bounds of one definition; the Worker re-checks them before it spawns anything. */
export const ACP_AGENT_DEFINITIONS_MAX = 64;
const ACP_AGENT_NAME_MAX = 80;
const ACP_AGENT_COMMAND_MAX = 1024;
const ACP_AGENT_ARGS_MAX = 64;
const ACP_AGENT_ARG_MAX = 4096;
const ACP_AGENT_ENV_MAX = 32;
const ACP_AGENT_ENV_VALUE_MAX = 4096;

/**
 * How a Worker launches one agent. `command` is resolved on the Worker's `PATH` unless it is a
 * path; a Worker that cannot find it reports the agent `unavailable`. `env` holds non-secret
 * launch settings (agents keep their own credentials); `version` pins a registry release.
 */
export const acpAgentDefinitionValidator = z.object({
  agentId: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.array(z.object({ name: z.string(), value: z.string() })),
  gateway: z.optional(
    z.object({
      enabled: z.boolean(),
      env: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
  enabled: z.boolean(),
  source: z.union([z.literal("registry"), z.literal("custom")]),
  icon: z.optional(z.string()),
  version: z.optional(z.string()),
  /** Owner's executable authorization; paired Workers refuse definitions without it. */
  authorization: z.optional(
    z.object({
      issuedAt: z.number(),
      signerKeyId: z.string(),
      signature: bytes(),
    }),
  ),
});
export type AcpAgentDefinition = z.infer<typeof acpAgentDefinitionValidator>;

/**
 * Launch environment keys an agent definition may not set: they redirect executable lookup,
 * loaders, proxies or TLS trust, or reach Radium's own credentials.
 */
export function forbiddenAgentEnv(key: string): boolean {
  return (
    /^(PATH|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|.*_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|BUN_.*)$/i.test(
      key,
    ) || /^(RADIUM_|CONVEX_)/i.test(key)
  );
}

/** Validate a definition for Convex and the Worker alike. Returns an error message, or `null`. */
export function acpAgentDefinitionError(definition: AcpAgentDefinition): string | null {
  const noNul = (value: string) => !value.includes("\0");
  if (!validAcpAgentId(definition.agentId))
    return "Agent IDs use lowercase letters, digits, '.', '_' and '-' (at most 64).";
  const name = definition.name.trim();
  if (!name || name.length > ACP_AGENT_NAME_MAX || !noNul(name))
    return `Names need 1 to ${ACP_AGENT_NAME_MAX} characters.`;
  const command = definition.command.trim();
  if (!command || command.length > ACP_AGENT_COMMAND_MAX || !noNul(command))
    return "The command is required.";
  if (
    definition.args.length > ACP_AGENT_ARGS_MAX ||
    definition.args.some((arg) => arg.length > ACP_AGENT_ARG_MAX || !noNul(arg))
  )
    return `At most ${ACP_AGENT_ARGS_MAX} arguments, each under ${ACP_AGENT_ARG_MAX} characters.`;
  for (const [env, gateway] of [
    [definition.env, false],
    [definition.gateway?.env ?? [], true],
  ] as const) {
    if (env.length > ACP_AGENT_ENV_MAX)
      return `At most ${ACP_AGENT_ENV_MAX} environment variables.`;
    const seen = new Set<string>();
    for (const { name: key, value } of env) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(key) || seen.has(key))
        return `Invalid or repeated environment variable: ${key || "(empty)"}.`;
      if (forbiddenAgentEnv(key)) return `${key} cannot be set for an agent.`;
      if (value.length > ACP_AGENT_ENV_VALUE_MAX || !noNul(value))
        return `The value of ${key} is too long.`;
      if (gateway) {
        for (const match of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
          if (
            !["gateway.url", "gateway.key", "gateway.models", "gateway.model"].includes(match[1]!)
          )
            return `Unknown placeholder ${match[0]} in ${key}.`;
        }
      }
      seen.add(key);
    }
  }
  if (definition.gateway?.enabled && !definition.gateway.env.length)
    return "Add at least one Gateway environment variable.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Commands (`acp_commands`): browser → Worker
// ---------------------------------------------------------------------------------------------

/** Prompt content Radium sends; attachments (images, embedded files) are a later slice. */
export const acpPromptBlockValidator = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    mimeType: z.optional(z.string()),
  }),
]);
export type AcpPromptBlock = z.infer<typeof acpPromptBlockValidator>;

/**
 * Command payloads by kind. `chat` on the row names the Session for session-level kinds;
 * agent-level kinds (`sync_sessions`, `authenticate`, `logout`) and post-deletion kinds (`close`,
 * `delete`) carry their own target because no chat row exists or applies.
 */
export const acpCommandPayloadValidator = z.union([
  z.object({ kind: z.literal("prompt"), prompt: z.array(acpPromptBlockValidator) }),
  z.object({ kind: z.literal("cancel") }),
  z.object({
    kind: z.literal("set_config"),
    configId: z.string(),
    value: z.union([z.string(), z.boolean()]),
  }),
  z.object({ kind: z.literal("set_mode"), modeId: z.string() }),
  z.object({
    kind: z.literal("history"),
    epoch: z.number(),
    before: z.number(),
    limit: z.number(),
  }),
  z.object({
    kind: z.literal("sync_sessions"),
    agentId: z.string(),
  }),
  z.object({ kind: z.literal("authenticate"), agentId: z.string(), methodId: z.string() }),
  z.object({ kind: z.literal("logout"), agentId: z.string() }),
  z.object({ kind: z.literal("fork"), targetChat: z.string() }),
  z.object({
    kind: z.literal("close"),
    agentId: z.string(),
    profile: acpProfileValidator,
    sessionId: z.string(),
    cwd: z.string(),
  }),
  z.object({
    kind: z.literal("delete"),
    agentId: z.string(),
    profile: acpProfileValidator,
    sessionId: z.string(),
    cwd: z.string(),
  }),
]);
export type AcpCommandPayload = z.infer<typeof acpCommandPayloadValidator>;
export type AcpCommandKind = AcpCommandPayload["kind"];

/** Command kinds as stored on the row, which outlives its cleared payload. */
export const acpCommandKindValidator = z.union([
  z.literal("prompt"),
  z.literal("cancel"),
  z.literal("set_config"),
  z.literal("set_mode"),
  z.literal("history"),
  z.literal("sync_sessions"),
  z.literal("authenticate"),
  z.literal("logout"),
  z.literal("fork"),
  z.literal("close"),
  z.literal("delete"),
]);

// Compile-time check that the stored kinds and the payload union stay in sync.
const commandKindsMatch: [AcpCommandKind] extends [z.infer<typeof acpCommandKindValidator>]
  ? [z.infer<typeof acpCommandKindValidator>] extends [AcpCommandKind]
    ? true
    : false
  : false = true;
void commandKindsMatch;

/** Command lifecycle: payload is cleared on claim; finished rows are pruned. */
export const acpCommandStatusValidator = z.union([
  z.literal("pending"),
  z.literal("claimed"),
  z.literal("done"),
  z.literal("failed"),
]);

/**
 * Small agent-owned metadata index, never conversation content. Bounds are checked on ingestion.
 * A paired Worker never sends `title`: it seals it to the workspace owner key (`sealedTitle`,
 * AAD `acp_agent_sessions`/workerId/`${agentId}:${sessionId}`/`title`) and diffs on `titleTag`, a
 * keyed tag only that Worker can compute.
 */
export const acpAgentSessionEntryValidator = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.optional(z.string()),
  sealedTitle: z.optional(z.object({ epoch: z.number(), box: bytes() })),
  titleTag: z.optional(z.string()),
  updatedAt: z.number(),
});
export type AcpAgentSessionEntry = z.infer<typeof acpAgentSessionEntryValidator>;

// ---------------------------------------------------------------------------------------------
// Interactions (`acp_interactions`): agent requests answered in Chatroom
// ---------------------------------------------------------------------------------------------

/** ACP `PermissionOptionKind`. */
export const acpPermissionOptionKindValidator = z.union([
  z.literal("allow_once"),
  z.literal("allow_always"),
  z.literal("reject_once"),
  z.literal("reject_always"),
]);

/** A choice of an elicitation enum field (`enum`, or titled `oneOf`/`anyOf` `const` values). */
const acpElicitationChoiceValidator = z.object({
  value: z.string(),
  title: z.optional(z.string()),
});

/**
 * One elicitation form field, normalized by the Worker from the agent's restricted JSON Schema.
 * Fields are a list because agent property names may not be valid Convex field names.
 */
export const acpElicitationFieldValidator = z.union([
  z.object({
    name: z.string(),
    type: z.literal("string"),
    title: z.optional(z.string()),
    description: z.optional(z.string()),
    format: z.optional(z.string()),
    choices: z.optional(z.array(acpElicitationChoiceValidator)),
    minLength: z.optional(z.number()),
    maxLength: z.optional(z.number()),
    default: z.optional(z.string()),
  }),
  z.object({
    name: z.string(),
    type: z.union([z.literal("number"), z.literal("integer")]),
    title: z.optional(z.string()),
    description: z.optional(z.string()),
    minimum: z.optional(z.number()),
    maximum: z.optional(z.number()),
    default: z.optional(z.number()),
  }),
  z.object({
    name: z.string(),
    type: z.literal("boolean"),
    title: z.optional(z.string()),
    description: z.optional(z.string()),
    default: z.optional(z.boolean()),
  }),
  z.object({
    name: z.string(),
    type: z.literal("array"),
    title: z.optional(z.string()),
    description: z.optional(z.string()),
    choices: z.array(acpElicitationChoiceValidator),
    minItems: z.optional(z.number()),
    maxItems: z.optional(z.number()),
    default: z.optional(z.array(z.string())),
  }),
]);
export type AcpElicitationField = z.infer<typeof acpElicitationFieldValidator>;

/**
 * A blocking agent request as shown to users. `content` is the JSON of the tool's bounded
 * normalized content (`AcpToolContent[]`), which Convex only stores and relays.
 */
export const acpInteractionRequestValidator = z.union([
  z.object({
    kind: z.literal("permission"),
    toolCallId: z.string(),
    title: z.optional(z.string()),
    toolKind: z.optional(z.string()),
    locations: z.optional(z.array(z.object({ path: z.string(), line: z.optional(z.number()) }))),
    content: z.optional(z.string()),
    options: z.array(
      z.object({ optionId: z.string(), name: z.string(), kind: acpPermissionOptionKindValidator }),
    ),
  }),
  z.object({
    kind: z.literal("elicitation"),
    mode: z.literal("form"),
    message: z.string(),
    toolCallId: z.optional(z.string()),
    title: z.optional(z.string()),
    description: z.optional(z.string()),
    fields: z.array(acpElicitationFieldValidator),
    required: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("elicitation"),
    mode: z.literal("url"),
    message: z.string(),
    toolCallId: z.optional(z.string()),
    elicitationId: z.string(),
    url: z.string(),
  }),
]);
export type AcpInteractionRequest = z.infer<typeof acpInteractionRequestValidator>;

/** An accepted form value: ACP allows strings, numbers, booleans and lists of strings. */
export const acpElicitationValueValidator = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});
export type AcpElicitationValue = z.infer<typeof acpElicitationValueValidator>;

/** A user's decision on an interaction. */
export const acpInteractionAnswerValidator = z.union([
  z.object({ kind: z.literal("permission"), optionId: z.string() }),
  z.object({
    kind: z.literal("elicitation"),
    action: z.literal("accept"),
    content: z.array(acpElicitationValueValidator),
  }),
  z.object({ kind: z.literal("elicitation"), action: z.literal("decline") }),
  z.object({ kind: z.literal("elicitation"), action: z.literal("cancel") }),
]);
export type AcpInteractionAnswer = z.infer<typeof acpInteractionAnswerValidator>;

/** `pending` → `answered` (durable decision) → `resolved` once the Worker relayed it. */
export const acpInteractionStatusValidator = z.union([
  z.literal("pending"),
  z.literal("answered"),
  z.literal("resolved"),
  z.literal("cancelled"),
]);

/**
 * Check an answer against its stored request: a permission option the agent offered, or form
 * values for declared fields only, each once, every required field present, and each of its
 * field's type, choices and bounds. Returns an error message, or `null` when valid.
 */
export function acpAnswerError(
  request: AcpInteractionRequest,
  answer: AcpInteractionAnswer,
): string | null {
  if (request.kind === "permission") {
    if (answer.kind !== "permission") return "This request needs a permission choice.";
    const offered = request.options.some((option) => option.optionId === answer.optionId);
    return offered ? null : "That option was not offered.";
  }

  if (answer.kind !== "elicitation") return "This request needs an answer.";
  if (answer.action !== "accept") return null;
  if (request.mode === "url") {
    return answer.content.length === 0 ? null : "A URL request takes no values.";
  }

  const seen = new Set<string>();
  for (const entry of answer.content) {
    if (seen.has(entry.name)) return `${entry.name} is answered twice.`;
    seen.add(entry.name);

    const field = request.fields.find((candidate) => candidate.name === entry.name);
    if (!field) return `Unknown field ${entry.name}.`;
    const error = elicitationValueError(field, entry.value);
    if (error) return `${entry.name}: ${error}`;
  }
  for (const name of request.required) {
    if (!seen.has(name)) return `Missing answer for ${name}.`;
  }
  return null;
}

function elicitationValueError(
  field: AcpElicitationField,
  value: AcpElicitationValue["value"],
): string | null {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return "expected text.";
      if (field.choices && !field.choices.some((choice) => choice.value === value)) {
        return "not one of the choices.";
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) return "too long.";
      if (field.minLength !== undefined && value.length < field.minLength) return "too short.";
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number.";
      if (field.type === "integer" && !Number.isInteger(value)) return "expected an integer.";
      if (field.minimum !== undefined && value < field.minimum) return "too small.";
      if (field.maximum !== undefined && value > field.maximum) return "too large.";
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "expected true or false.";
    case "array": {
      if (!Array.isArray(value)) return "expected a list of choices.";
      if (value.some((entry) => !field.choices.some((choice) => choice.value === entry))) {
        return "not one of the choices.";
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return "too few choices.";
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return "too many choices.";
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Frames and the normalized timeline
// ---------------------------------------------------------------------------------------------

/** Frame kinds: the snapshot opening an epoch, live ops, or an older page shared by viewers. */
export const acpFrameKindValidator = z.union([
  z.literal("snapshot"),
  z.literal("live"),
  z.literal("history"),
]);
export type AcpFrameKind = z.infer<typeof acpFrameKindValidator>;

/**
 * One frame as the Worker appends it: `payload` is the JSON of `AcpOp[]`, or in a keyed workspace
 * the bytes of that JSON sealed under the epoch's capsule (`sealWithCapsule`, AAD
 * `chat_frames`/e2eeId/`${epoch}:${seqFrom}`/`payload`).
 */
export const acpFrameInputValidator = z.object({
  seqFrom: z.number(),
  seqTo: z.number(),
  kind: acpFrameKindValidator,
  payload: z.union([z.string(), bytes()]),
});
export type AcpFrameInput = z.infer<typeof acpFrameInputValidator>;

/** `chat_frames.stream` of an ACP epoch. */
export function acpStream(epoch: number): string {
  return `acp:${epoch}`;
}

/** Normalized tool content; diffs and text are cut at `ACP_ITEM_CONTENT_BYTES` per item. */
export type AcpToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "resource"; uri: string; name?: string; mimeType?: string }
  | { type: "image"; mimeType: string }
  | { type: "terminal"; terminalId: string };

/** Non-text parts of a message item; binary data never leaves the Worker. */
export type AcpMessagePart =
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string }
  | { type: "image"; mimeType: string; uri?: string }
  | { type: "audio"; mimeType: string };

/** Fields shared by every timeline item; `order` sorts items and addresses history pages. */
type AcpItemBase = { id: string; order: number; turnId?: string };

/**
 * One timeline item. Item kinds follow `docs/ACP/Transport.md#normalized-timeline`:
 * `tool` ids are `tool:<toolCallId>`, the latest `plan` replaces earlier ones, and `notice`
 * carries ACP notices, compaction progress and turn errors.
 */
export type AcpItem =
  | (AcpItemBase & {
      kind: "user" | "agent" | "thought";
      text: string;
      parts?: AcpMessagePart[];
      messageId?: string;
      /** Whole seconds a live `thought` took; replayed history has none. */
      duration?: number;
    })
  | (AcpItemBase & {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status?: "pending" | "in_progress" | "completed" | "failed";
      locations?: { path: string; line?: number }[];
      content?: AcpToolContent[];
      rawInput?: string;
      rawOutput?: string;
      /** Set when content or raw input/output was cut at the per-item cap. */
      truncated?: boolean;
    })
  | (AcpItemBase & {
      kind: "plan";
      entries: {
        content: string;
        status: "pending" | "in_progress" | "completed";
        priority: "high" | "medium" | "low";
      }[];
    })
  | (AcpItemBase & {
      kind: "notice";
      severity: string;
      title: string;
      description?: string;
      compaction?: { id: string; status: string; summary?: string };
    });

/**
 * Item fields an upsert may carry: present = replace, `null` = clear, absent = unchanged.
 * The first upsert of an item carries `kind` and `order`.
 */
export type AcpItemPatch = { id: string } & {
  [Key in Exclude<FieldOf<AcpItem>, "id">]?: FieldValue<AcpItem, Key> | null;
};
type FieldOf<Union> = Union extends unknown ? keyof Union : never;
type FieldValue<Union, Key extends PropertyKey> = Union extends unknown
  ? Key extends keyof Union
    ? Union[Key]
    : never
  : never;

/**
 * Timeline ops, applied in frame sequence order. Text chunks append; everything else is an
 * ID-addressed upsert following the ACP v2 draft semantics.
 */
export type AcpOp =
  | { op: "item.upsert"; item: AcpItemPatch }
  | { op: "text.append"; id: string; text: string }
  | { op: "turn.start"; turnId: string }
  | { op: "turn.end"; turnId: string; stopReason?: AcpStopReason; error?: string }
  | {
      op: "session.patch";
      config?: AcpConfig;
      commands?: AcpCommandInfo[];
      usage?: AcpUsage;
      info?: { title?: string | null; updatedAt?: string | null };
    }
  /**
   * Window marker. In a snapshot: items with `order >= start` follow, `hasMore` tells whether
   * older items exist. In a history frame: the page covers `start <= order < before`.
   */
  | { op: "window"; start: number; before?: number; hasMore: boolean }
  /**
   * One piece of a single op whose JSON exceeds a frame (a tool item with large content). Pieces
   * share `id`, arrive in `index` order across consecutive frames, and concatenating `data` for
   * `0..total-1` yields the op's JSON; clients apply it only once every piece arrived.
   */
  | { op: "fragment"; id: string; index: number; total: number; data: string };

// ---------------------------------------------------------------------------------------------
// End-to-end encryption (keyed workspaces; `docs/E2EE/Data.md#acp`)
// ---------------------------------------------------------------------------------------------

/** Largest sealed frame: an `ACP_FRAME_BYTES` payload after `content` padding and the envelope. */
export const ACP_SEALED_FRAME_BYTES = ACP_FRAME_BYTES + 8 * 1024;
/** Largest sealed command box (a prompt is the biggest payload). */
export const ACP_SEALED_COMMAND_BYTES = ACP_PROMPT_BYTES + 8 * 1024;
/** Largest sealed interaction request or answer box. */
export const ACP_SEALED_INTERACTION_BYTES = ACP_INTERACTION_REQUEST_BYTES + 8 * 1024;
/** Largest sealed title or error box (`short` padding of at most 500 characters). */
export const ACP_SEALED_SHORT_BYTES = 4 * 1024;

/** Audience of an ACP chat as the creator signed it. */
export const acpChatScopeValidator = z.union([
  z.literal("personal"),
  z.literal("shared"),
  z.literal("workspace"),
]);

/**
 * `acp_sessions.binding`: the creator's signature over `acpBindingStatement` (radium-crypto) for
 * this chat. The other statement inputs are the session row (`workspace`, `worker`, `agentId`,
 * `profile`, `cwd`) and the chat (`_id`, `e2eeId`, `userId` as creator). `version` starts at 1 and
 * grows with every scope or member change; Workers refuse lower versions than they have seen.
 */
export const acpSignedBindingValidator = z.object({
  version: z.number(),
  scope: acpChatScopeValidator,
  members: z.array(z.string()),
  signerKeyId: z.string(),
  signature: bytes(),
});
export type AcpSignedBinding = z.infer<typeof acpSignedBindingValidator>;

/**
 * Who bound `acp_sessions.sessionId` to the chat: the Worker that created the agent session
 * (`workerObjectStatement` over table `acp_sessions`, parent chatId, record sessionId, field
 * `sessionId`, object UTF-8 agentId), or the workspace owner who imported an indexed session
 * (`acpCommandStatement` with kind `import`, clientId sessionId, payload UTF-8 agentId).
 */
export const acpSessionProofValidator = z.union([
  z.object({ kind: z.literal("worker"), signature: bytes() }),
  z.object({ kind: z.literal("import"), signerKeyId: z.string(), signature: bytes() }),
]);
export type AcpSessionProof = z.infer<typeof acpSessionProofValidator>;

/**
 * A browser command in a keyed workspace. `payload` is a box sealed to the Worker's encryption key
 * (AAD `acp_commands`/chatId or ""/clientId/`payload`, `content` padding) holding the UTF-8 JSON
 * `{ v: 1, issuedAt, command: AcpCommandPayload }`; `signature` is the issuer's identity signature
 * over `acpCommandStatement`. Convex stores it and checks only the signer; the Worker decides.
 */
export const acpSignedCommandValidator = z.object({
  clientId: z.string(),
  payload: bytes(),
  signature: bytes(),
  signerKeyId: z.string(),
});
export type AcpSignedCommand = z.infer<typeof acpSignedCommandValidator>;

/**
 * Binding snapshot stored with a `close`/`delete` command, which outlives its chat: the Worker
 * authorizes the issuer against it and the session proof exactly as for a live chat.
 */
export const acpDeletedTargetValidator = z.object({
  chat: z.string(),
  e2eeId: z.string(),
  creatorUserId: z.string(),
  agentId: z.string(),
  profile: acpProfileValidator,
  cwd: z.string(),
  sessionId: z.string(),
  binding: acpSignedBindingValidator,
  sessionProof: acpSessionProofValidator,
});
export type AcpDeletedTarget = z.infer<typeof acpDeletedTargetValidator>;

/** A box sealed to a numbered chat key (or owner key) epoch. */
export const acpSealedBoxValidator = z.object({ epoch: z.number(), box: bytes() });

/**
 * An interaction request sealed by the Worker to chat key `epoch` (AAD `acp_interactions`/e2eeId/
 * requestKey/`request`) with its signature over `workerObjectStatement` of the same location.
 */
export const acpSealedRequestValidator = z.object({
  epoch: z.number(),
  box: bytes(),
  signature: bytes(),
});

/**
 * An answer sealed to the Worker (AAD `acp_interactions`/chatId/requestKey/`answer`) and signed by
 * the answering user over `acpAnswerStatement`. Only the Worker can validate it.
 */
export const acpSealedAnswerValidator = z.object({
  answer: bytes(),
  signature: bytes(),
  signerKeyId: z.string(),
});

/**
 * An epoch's frame capsule: `encodeCapsule` of a capsule to chat key `chatEpoch` (AAD
 * `acp_streams`/e2eeId/String(epoch)/`capsule`) and the Worker's `workerObjectStatement` signature.
 */
export const acpStreamCapsuleValidator = z.object({
  chatEpoch: z.number(),
  capsule: bytes(),
  signature: bytes(),
});

/**
 * Fixed codes a paired Worker may report in `error` fields instead of free text, so verification never
 * counts them as plaintext. A Worker can never report the backend-only codes below.
 */
export const ACP_WORKER_ERROR_CODES = [
  "ACP_UNSIGNED",
  "ACP_FORBIDDEN",
  "ACP_FAILED",
  "ACP_EXPIRED",
  "ACP_SESSION_DELETED",
] as const;

/**
 * Fixed codes only the backend writes: `ACP_CANCELLED` (a user cancelled a queued prompt) and
 * `ACP_ABANDONED` (an operator closed a stale legacy row of a revoked or deleted Worker; its host-side
 * outcome is unknown and is never replayed).
 */
export const ACP_BACKEND_ERROR_CODES = ["ACP_CANCELLED", "ACP_ABANDONED"] as const;

/**
 * Whether a persisted `error` value is a fixed code from either set, hence metadata that the legacy
 * migration neither seals nor counts as plaintext. This is a classifier of stored rows only; it does
 * not make a code Worker-reportable (see `ACP_WORKER_ERROR_CODES`).
 */
export function isPersistedAcpErrorCode(value: unknown): boolean {
  return (
    (ACP_WORKER_ERROR_CODES as readonly unknown[]).includes(value) ||
    (ACP_BACKEND_ERROR_CODES as readonly unknown[]).includes(value)
  );
}

/** Plaintext stand-in for a sealed session error, safe for notifications and Home. */
export const ACP_SEALED_ERROR_TEXT = "The agent reported an error";
