import { v, type Infer } from "convex/values";

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
/** Largest serialized command result (one `session/list` page). */
export const ACP_COMMAND_RESULT_BYTES = 64 * 1024;
/** Most items one history page may return. */
export const ACP_HISTORY_PAGE_ITEMS = 50;

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
 * `aisdk_chats.agent`: which ACP agent on which Worker owns the conversation. Set once at
 * creation; only `sessionId` is written later, once, by the bound Worker. `profile` is `native`
 * until Gateway-mode launch profiles exist.
 */
export const acpChatAgentValidator = v.object({
  kind: v.literal("acp"),
  worker: v.string(),
  agentId: v.string(),
  profile: v.literal("native"),
  agentVersion: v.string(),
  cwd: v.string(),
  sessionId: v.optional(v.string()),
});
export type AcpChatAgent = Infer<typeof acpChatAgentValidator>;

/** `acp_sessions.status`; mapped to the UI `RunState` once at the data boundary. */
export const acpSessionStatusValidator = v.union(
  v.literal("starting"),
  v.literal("idle"),
  v.literal("running"),
  v.literal("awaiting"),
  v.literal("failed"),
  v.literal("ended"),
);
export type AcpSessionStatus = Infer<typeof acpSessionStatusValidator>;

/** Statuses during which a prompt is admitted or in flight; a second prompt is rejected. */
export const ACP_BUSY_STATUSES: readonly AcpSessionStatus[] = ["starting", "running", "awaiting"];

/** ACP v1 `StopReason`. */
export const acpStopReasonValidator = v.union(
  v.literal("end_turn"),
  v.literal("max_tokens"),
  v.literal("max_turn_requests"),
  v.literal("refusal"),
  v.literal("cancelled"),
);
export type AcpStopReason = Infer<typeof acpStopReasonValidator>;

/** How much history the agent gave back when the Worker set the session up. */
export const acpHistoryValidator = v.union(
  v.literal("full"),
  v.literal("resumed"),
  v.literal("none"),
);

// ---------------------------------------------------------------------------------------------
// Agent-advertised surface (config, modes, commands, usage) in Radium's normalized shape
// ---------------------------------------------------------------------------------------------

/** One choice of a select config option; `group` names the ACP option group, when grouped. */
export const acpConfigChoiceValidator = v.object({
  value: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  group: v.optional(v.string()),
});

/** An agent config option (`model`, `thought_level`, `mode`, or agent-specific categories). */
export const acpConfigOptionValidator = v.union(
  v.object({
    type: v.literal("select"),
    id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    category: v.optional(v.string()),
    currentValue: v.string(),
    choices: v.array(acpConfigChoiceValidator),
  }),
  v.object({
    type: v.literal("boolean"),
    id: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    category: v.optional(v.string()),
    currentValue: v.boolean(),
  }),
);
export type AcpConfigOption = Infer<typeof acpConfigOptionValidator>;

/** Session modes (`modes` in `session/new`, `current_mode_update`). */
export const acpModesValidator = v.object({
  currentModeId: v.string(),
  available: v.array(
    v.object({ id: v.string(), name: v.string(), description: v.optional(v.string()) }),
  ),
});

/** Complete config state; a config response or update replaces it whole. */
export const acpConfigValidator = v.object({
  options: v.array(acpConfigOptionValidator),
  modes: v.optional(acpModesValidator),
});
export type AcpConfig = Infer<typeof acpConfigValidator>;

/** One `available_commands_update` entry; `hint` is the unstructured input hint. */
export const acpCommandInfoValidator = v.object({
  name: v.string(),
  description: v.string(),
  hint: v.optional(v.string()),
});
export type AcpCommandInfo = Infer<typeof acpCommandInfoValidator>;

/** Latest `usage_update`: context tokens used/size and optional cumulative cost. */
export const acpUsageValidator = v.object({
  used: v.number(),
  size: v.number(),
  cost: v.optional(v.object({ amount: v.number(), currency: v.string() })),
});
export type AcpUsage = Infer<typeof acpUsageValidator>;

/** Choices made before the ACP session exists, applied by the Worker right after `session/new`. */
export const acpDraftConfigValidator = v.object({
  config: v.array(v.object({ configId: v.string(), value: v.union(v.string(), v.boolean()) })),
  modeId: v.optional(v.string()),
});
export type AcpDraftConfig = Infer<typeof acpDraftConfigValidator>;

// ---------------------------------------------------------------------------------------------
// Agent catalog (`worker_agents`)
// ---------------------------------------------------------------------------------------------

/** Capability summary from `initialize`; absent ACP capabilities are `false`. */
export const acpAgentCapabilitiesValidator = v.object({
  loadSession: v.boolean(),
  list: v.boolean(),
  resume: v.boolean(),
  close: v.boolean(),
  delete: v.boolean(),
  fork: v.boolean(),
  logout: v.boolean(),
  image: v.boolean(),
  audio: v.boolean(),
  embeddedContext: v.boolean(),
  mcpHttp: v.boolean(),
  mcpSse: v.boolean(),
});
export type AcpAgentCapabilities = Infer<typeof acpAgentCapabilitiesValidator>;

/** Advertised `authMethods`; terminal methods run only through the Worker CLI. */
export const acpAuthMethodValidator = v.object({
  id: v.string(),
  name: v.string(),
  type: v.union(v.literal("agent"), v.literal("terminal")),
  description: v.optional(v.string()),
});
export type AcpAuthMethod = Infer<typeof acpAuthMethodValidator>;

/** Agent availability on one Worker. */
export const acpAgentStatusValidator = v.union(
  v.literal("ready"),
  v.literal("needs_auth"),
  v.literal("unavailable"),
  v.literal("failed"),
);
export type AcpAgentStatus = Infer<typeof acpAgentStatusValidator>;

/** One agent as the Worker reports it; the Worker owns every field. */
export const acpAgentReportValidator = v.object({
  agentId: v.string(),
  name: v.string(),
  version: v.string(),
  icon: v.optional(v.string()),
  source: v.union(v.literal("registry"), v.literal("custom")),
  status: acpAgentStatusValidator,
  /** Short reason for `unavailable`/`failed`; never stderr or credentials. */
  error: v.optional(v.string()),
  capabilities: acpAgentCapabilitiesValidator,
  authMethods: v.array(acpAuthMethodValidator),
  /** Last config/commands seen from `session/new` on this Worker, for drafts. */
  defaults: v.optional(
    v.object({
      config: v.optional(acpConfigValidator),
      commands: v.optional(v.array(acpCommandInfoValidator)),
    }),
  ),
});
export type AcpAgentReport = Infer<typeof acpAgentReportValidator>;

// ---------------------------------------------------------------------------------------------
// Commands (`acp_commands`): browser → Worker
// ---------------------------------------------------------------------------------------------

/** Prompt content Radium sends; attachments (images, embedded files) are a later slice. */
export const acpPromptBlockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("resource_link"),
    uri: v.string(),
    name: v.string(),
    mimeType: v.optional(v.string()),
  }),
);
export type AcpPromptBlock = Infer<typeof acpPromptBlockValidator>;

/**
 * Command payloads by kind. `chat` on the row names the Session for session-level kinds;
 * agent-level kinds (`list`, `authenticate`, `logout`) and post-deletion kinds (`close`,
 * `delete`) carry their own target because no chat row exists or applies.
 */
export const acpCommandPayloadValidator = v.union(
  v.object({ kind: v.literal("prompt"), prompt: v.array(acpPromptBlockValidator) }),
  v.object({ kind: v.literal("cancel") }),
  v.object({
    kind: v.literal("set_config"),
    configId: v.string(),
    value: v.union(v.string(), v.boolean()),
  }),
  v.object({ kind: v.literal("set_mode"), modeId: v.string() }),
  v.object({
    kind: v.literal("history"),
    epoch: v.number(),
    before: v.number(),
    limit: v.number(),
  }),
  v.object({
    kind: v.literal("list"),
    agentId: v.string(),
    cwd: v.string(),
    cursor: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("authenticate"), agentId: v.string(), methodId: v.string() }),
  v.object({ kind: v.literal("logout"), agentId: v.string() }),
  v.object({ kind: v.literal("fork"), targetChat: v.string() }),
  v.object({
    kind: v.literal("close"),
    agentId: v.string(),
    sessionId: v.string(),
    cwd: v.string(),
  }),
  v.object({
    kind: v.literal("delete"),
    agentId: v.string(),
    sessionId: v.string(),
    cwd: v.string(),
  }),
);
export type AcpCommandPayload = Infer<typeof acpCommandPayloadValidator>;
export type AcpCommandKind = AcpCommandPayload["kind"];

/** Command kinds as stored on the row, which outlives its cleared payload. */
export const acpCommandKindValidator = v.union(
  v.literal("prompt"),
  v.literal("cancel"),
  v.literal("set_config"),
  v.literal("set_mode"),
  v.literal("history"),
  v.literal("list"),
  v.literal("authenticate"),
  v.literal("logout"),
  v.literal("fork"),
  v.literal("close"),
  v.literal("delete"),
);

// Compile-time check that the stored kinds and the payload union stay in sync.
const commandKindsMatch: [AcpCommandKind] extends [Infer<typeof acpCommandKindValidator>]
  ? [Infer<typeof acpCommandKindValidator>] extends [AcpCommandKind]
    ? true
    : false
  : false = true;
void commandKindsMatch;

/** Command lifecycle: payload is cleared on claim; finished rows are pruned. */
export const acpCommandStatusValidator = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("done"),
  v.literal("failed"),
);

/** One `session/list` page, returned as a `list` command's transient result. */
export type AcpSessionListPage = {
  sessions: { sessionId: string; cwd: string; title?: string; updatedAt?: string }[];
  /** Opaque ACP cursor; kept only in this transient result and browser memory. */
  nextCursor?: string;
};

// ---------------------------------------------------------------------------------------------
// Interactions (`acp_interactions`): agent requests answered in Chatroom
// ---------------------------------------------------------------------------------------------

/** ACP `PermissionOptionKind`. */
export const acpPermissionOptionKindValidator = v.union(
  v.literal("allow_once"),
  v.literal("allow_always"),
  v.literal("reject_once"),
  v.literal("reject_always"),
);

/** A choice of an elicitation enum field (`enum`, or titled `oneOf`/`anyOf` `const` values). */
const acpElicitationChoiceValidator = v.object({
  value: v.string(),
  title: v.optional(v.string()),
});

/**
 * One elicitation form field, normalized by the Worker from the agent's restricted JSON Schema.
 * Fields are a list because agent property names may not be valid Convex field names.
 */
export const acpElicitationFieldValidator = v.union(
  v.object({
    name: v.string(),
    type: v.literal("string"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    format: v.optional(v.string()),
    choices: v.optional(v.array(acpElicitationChoiceValidator)),
    minLength: v.optional(v.number()),
    maxLength: v.optional(v.number()),
    default: v.optional(v.string()),
  }),
  v.object({
    name: v.string(),
    type: v.union(v.literal("number"), v.literal("integer")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    minimum: v.optional(v.number()),
    maximum: v.optional(v.number()),
    default: v.optional(v.number()),
  }),
  v.object({
    name: v.string(),
    type: v.literal("boolean"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    default: v.optional(v.boolean()),
  }),
  v.object({
    name: v.string(),
    type: v.literal("array"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    choices: v.array(acpElicitationChoiceValidator),
    minItems: v.optional(v.number()),
    maxItems: v.optional(v.number()),
    default: v.optional(v.array(v.string())),
  }),
);
export type AcpElicitationField = Infer<typeof acpElicitationFieldValidator>;

/**
 * A blocking agent request as shown to users. `content` is the JSON of the tool's bounded
 * normalized content (`AcpToolContent[]`), which Convex only stores and relays.
 */
export const acpInteractionRequestValidator = v.union(
  v.object({
    kind: v.literal("permission"),
    toolCallId: v.string(),
    title: v.optional(v.string()),
    toolKind: v.optional(v.string()),
    locations: v.optional(v.array(v.object({ path: v.string(), line: v.optional(v.number()) }))),
    content: v.optional(v.string()),
    options: v.array(
      v.object({ optionId: v.string(), name: v.string(), kind: acpPermissionOptionKindValidator }),
    ),
  }),
  v.object({
    kind: v.literal("elicitation"),
    mode: v.literal("form"),
    message: v.string(),
    toolCallId: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    fields: v.array(acpElicitationFieldValidator),
    required: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("elicitation"),
    mode: v.literal("url"),
    message: v.string(),
    toolCallId: v.optional(v.string()),
    elicitationId: v.string(),
    url: v.string(),
  }),
);
export type AcpInteractionRequest = Infer<typeof acpInteractionRequestValidator>;

/** An accepted form value: ACP allows strings, numbers, booleans and lists of strings. */
export const acpElicitationValueValidator = v.object({
  name: v.string(),
  value: v.union(v.string(), v.number(), v.boolean(), v.array(v.string())),
});
export type AcpElicitationValue = Infer<typeof acpElicitationValueValidator>;

/** A user's decision on an interaction. */
export const acpInteractionAnswerValidator = v.union(
  v.object({ kind: v.literal("permission"), optionId: v.string() }),
  v.object({
    kind: v.literal("elicitation"),
    action: v.literal("accept"),
    content: v.array(acpElicitationValueValidator),
  }),
  v.object({ kind: v.literal("elicitation"), action: v.literal("decline") }),
  v.object({ kind: v.literal("elicitation"), action: v.literal("cancel") }),
);
export type AcpInteractionAnswer = Infer<typeof acpInteractionAnswerValidator>;

/** `pending` → `answered` (durable decision) → `resolved` once the Worker relayed it. */
export const acpInteractionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("answered"),
  v.literal("resolved"),
  v.literal("cancelled"),
);

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
export const acpFrameKindValidator = v.union(
  v.literal("snapshot"),
  v.literal("live"),
  v.literal("history"),
);
export type AcpFrameKind = Infer<typeof acpFrameKindValidator>;

/** One frame as the Worker appends it; `payload` is the JSON of `AcpOp[]`. */
export const acpFrameInputValidator = v.object({
  seqFrom: v.number(),
  seqTo: v.number(),
  kind: acpFrameKindValidator,
  payload: v.string(),
});
export type AcpFrameInput = Infer<typeof acpFrameInputValidator>;

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
