import type {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import type { TelemetryBlobMeta } from "./validators";

/** A JSON object as parsed from a request or response body. */
type JsonObject = Record<string, unknown>;

/** Header names stored with a request; everything else, especially credentials, is dropped. */
const ALLOWED_HEADERS = new Set([
  "user-agent",
  "x-title",
  "http-referer",
  "referer",
  "x-claude-code-session-id",
  "session-id",
  "session_id",
  "x-session-id",
  "x-session-affinity",
  "x-conversation-id",
  "x-thread-id",
  "x-parent-session-id",
  "x-claude-code-parent-agent-id",
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
]);
const ALLOWED_HEADER_PREFIX = "x-stainless-";

/** A raw request body split into the parts that are stored and deduplicated separately. */
export type DecomposedRequest = {
  /** Leading `system`/`developer` messages; later ones stay in `chain`. */
  system: unknown[];
  /** Remaining messages in conversation order. */
  chain: unknown[];
  tools: unknown[];
  /** The body minus `messages` and `tools`; unknown fields survive. */
  params: JsonObject;
  /** Lowercased allowlisted headers; empty when none were sent. */
  headers: Record<string, string>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemMessage(message: unknown) {
  return isObject(message) && (message.role === "system" || message.role === "developer");
}

/**
 * Split an OpenAI-compatible chat-completion body parsed from raw JSON (not the zod output,
 * which drops unknown fields). Non-object bodies and non-array `messages`/`tools` decompose
 * to empty parts rather than throwing; capture must never reject a request routing accepted.
 */
export function decomposeRequest(rawBody: unknown, headers?: Headers): DecomposedRequest {
  const body = isObject(rawBody) ? rawBody : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  let leading = 0;
  while (leading < messages.length && isSystemMessage(messages[leading])) leading++;

  const params: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "messages" && key !== "tools") params[key] = value;
  }

  return {
    system: messages.slice(0, leading),
    chain: messages.slice(leading),
    tools,
    params,
    headers: allowlistedHeaders(headers),
  };
}

/** Lowercased headers that are safe to keep; never credentials or cookies. */
export function allowlistedHeaders(headers: Headers | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  if (!headers) return kept;
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (ALLOWED_HEADERS.has(lower) || lower.startsWith(ALLOWED_HEADER_PREFIX)) {
      kept[lower] = value;
    }
  });
  return kept;
}

/** Tool names an assistant message calls, in call order. */
function toolCallNames(message: JsonObject) {
  const names: string[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isObject(call)) continue;
      const named = isObject(call.function)
        ? call.function
        : isObject(call.custom)
          ? call.custom
          : undefined;
      if (typeof named?.name === "string") names.push(named.name);
    }
  }
  if (isObject(message.function_call) && typeof message.function_call.name === "string") {
    names.push(message.function_call.name);
  }
  return names;
}

/**
 * Non-content facts about a message, kept when content recording is off: role, the tool names
 * an assistant message calls, and the tool call a tool message answers.
 */
export function messageMeta(message: unknown): TelemetryBlobMeta | undefined {
  if (!isObject(message)) return undefined;
  const meta: TelemetryBlobMeta = {};
  if (typeof message.role === "string") meta.role = message.role;
  const names = toolCallNames(message);
  if (names.length > 0) meta.names = names;
  if (typeof message.tool_call_id === "string") meta.toolCallId = message.tool_call_id;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** The tool's name (OpenAI `function.name` or flat `name`), kept when content recording is off. */
export function toolMeta(tool: unknown): TelemetryBlobMeta | undefined {
  if (!isObject(tool)) return undefined;
  const named = isObject(tool.function) ? tool.function : tool;
  return typeof named.name === "string" ? { names: [named.name] } : undefined;
}

type ToolCall =
  | { id?: string; type: "function"; function: { name: string; arguments: string } }
  | { id?: string; type: "custom"; custom: { name: string; input: string } };

type ReasoningDetail = {
  type: string;
  id?: string | null;
  format?: string | null;
  index?: number | null;
  text?: string | null;
  summary?: string | null;
  data?: string | null;
  signature?: string | null;
  provider_metadata?: Record<string, unknown>;
};

/** The assistant output as delivered to the client, including opaque continuation content. */
export type OutputMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
  refusal?: string;
};

/**
 * Accumulates wire deltas by their stable tool/reasoning index. Opaque reasoning is content,
 * governed by the same recording policy as visible output; it is never interpreted as text.
 */
export class StreamOutputAssembler {
  private content = "";
  private reasoning = "";
  private refusal = "";
  private readonly toolCalls = new Map<number, ToolCall>();
  private readonly reasoningDetails = new Map<string, ReasoningDetail>();
  private sawOutput = false;
  providerId?: string;
  finishReason?: string;

  push(chunk: ChatCompletions_Streaming_Chunk_Type) {
    this.providerId ??= chunk.id;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta as {
      content?: string | null;
      reasoning?: string | null;
      refusal?: string | null;
      reasoning_details?: ReasoningDetail[] | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
        custom?: { name?: string; input?: string };
      }>;
    };
    if (!delta) return;
    if (delta.content) {
      this.content += delta.content;
      this.sawOutput = true;
    }
    if (delta.reasoning) {
      this.reasoning += delta.reasoning;
      this.sawOutput = true;
    }
    if (delta.refusal) {
      this.refusal += delta.refusal;
      this.sawOutput = true;
    }
    for (const detail of delta.reasoning_details ?? []) {
      const key = `${detail.index ?? detail.id ?? 0}:${detail.type}`;
      const previous = this.reasoningDetails.get(key);
      this.reasoningDetails.set(key, {
        ...previous,
        ...detail,
        ...(detail.text !== undefined ? { text: (previous?.text ?? "") + detail.text } : {}),
        ...(detail.summary !== undefined
          ? { summary: (previous?.summary ?? "") + detail.summary }
          : {}),
      });
      this.sawOutput = true;
    }
    for (const fragment of delta.tool_calls ?? []) {
      let call = this.toolCalls.get(fragment.index);
      if (!call) {
        call =
          fragment.type === "custom" || fragment.custom
            ? { type: "custom", custom: { name: "", input: "" } }
            : { type: "function", function: { name: "", arguments: "" } };
        this.toolCalls.set(fragment.index, call);
      }
      if (fragment.id) call.id = fragment.id;
      if (call.type === "custom") {
        call.custom.name += fragment.custom?.name ?? "";
        call.custom.input += fragment.custom?.input ?? "";
      } else {
        call.function.name += fragment.function?.name ?? "";
        call.function.arguments += fragment.function?.arguments ?? "";
      }
      this.sawOutput = true;
    }
  }

  /** Returns undefined only when no visible or opaque output was received. */
  message(): OutputMessage | undefined {
    if (!this.sawOutput) return undefined;
    const message: OutputMessage = {
      role: "assistant",
      content: this.content === "" && this.toolCalls.size > 0 ? null : this.content,
    };
    if (this.toolCalls.size > 0) {
      message.tool_calls = [...this.toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call);
    }
    if (this.reasoning) message.reasoning = this.reasoning;
    if (this.reasoningDetails.size > 0) {
      message.reasoning_details = [...this.reasoningDetails.values()].sort(
        (left, right) => (left.index ?? 0) - (right.index ?? 0),
      );
    }
    if (this.refusal) message.refusal = this.refusal;
    return message;
  }
}

/** Keep the discriminated message shape; flattening custom calls would corrupt replay. */
export function assembleOutputMessage(
  response: ChatCompletions_NotStreaming_ResponseBody_Type,
): OutputMessage | undefined {
  const source = response.choices?.[0]?.message;
  if (!source) return undefined;
  const details = source.reasoning_details;
  const toolCalls: ToolCall[] = (source.tool_calls ?? []).map((call) =>
    "function" in call
      ? { id: call.id, type: "function", function: { ...call.function } }
      : { id: call.id, type: "custom", custom: { ...call.custom } },
  );
  if (
    !source.content &&
    !source.reasoning &&
    !source.refusal &&
    toolCalls.length === 0 &&
    !details?.length
  )
    return undefined;
  return {
    role: "assistant",
    content: source.content ?? null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(source.reasoning ? { reasoning: source.reasoning } : {}),
    ...(details?.length ? { reasoning_details: details } : {}),
    ...(source.refusal ? { refusal: source.refusal } : {}),
  };
}
