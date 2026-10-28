import type { ChatCompletions_RequestBody_Type } from "@/types/openai/types";

/**
 * Session identity used by session-affinity routing. `primary` is bound to a provider;
 * `fallback` is the previous-turn hash or the parent session, consulted when `primary`
 * has no binding. `isSubagent` children inherit without moving the parent's binding.
 */
export type RoutingSession = {
  primary: string;
  fallback?: string;
  isSubagent: boolean;
};

const MAX_ID_BYTES = 256;
const HASH_PART_BYTES = 100;

/** Explicit session headers, in CLIProxyAPI precedence order, with their key prefixes. */
const SESSION_HEADERS: Array<[header: string, prefix: string]> = [
  ["x-claude-code-session-id", "claude"],
  ["session-id", "codex"],
  ["session_id", "codex"],
  ["x-session-id", "header"],
  ["x-session-affinity", "affinity"],
  ["x-conversation-id", "conv"],
  ["x-thread-id", "thread"],
];

const PARENT_HEADERS = ["x-parent-session-id", "x-claude-code-parent-agent-id"];

/**
 * Derive the routing session from server-trusted chat context, request headers, and body.
 * Precedence: Chatroom chat ID, client session headers, body `session_id`,
 * `prompt_cache_key`, deprecated `user`, then a first-messages hash. Returns undefined when
 * the request has no user message to hash.
 */
export function extractRoutingSession(
  request: ChatCompletions_RequestBody_Type,
  headers?: Headers,
  chatId?: string,
): RoutingSession | undefined {
  const explicit = explicitSessionId(request, headers, chatId);

  if (explicit) {
    const parent = headers ? firstValidHeader(headers, PARENT_HEADERS) : undefined;
    if (parent) {
      const prefix = explicit.slice(0, explicit.indexOf(":"));
      return { primary: explicit, fallback: `${prefix}:${parent}`, isSubagent: true };
    }
    return { primary: explicit, isSubagent: false };
  }

  return messageHashSession(request);
}

function explicitSessionId(
  request: ChatCompletions_RequestBody_Type,
  headers: Headers | undefined,
  chatId: string | undefined,
) {
  if (chatId) return `chat:${chatId}`;

  if (headers) {
    for (const [header, prefix] of SESSION_HEADERS) {
      const value = normalizeId(headers.get(header));
      if (value) return `${prefix}:${value}`;
    }
  }

  const bodyIds: Array<[value: string | undefined, prefix: string]> = [
    [request.session_id, "session"],
    [request.prompt_cache_key, "pck"],
    [request.user, "user"],
  ];
  for (const [rawValue, prefix] of bodyIds) {
    const value = normalizeId(rawValue);
    if (value) return `${prefix}:${value}`;
  }
  return undefined;
}

function firstValidHeader(headers: Headers, names: string[]) {
  for (const name of names) {
    const value = normalizeId(headers.get(name));
    if (value) return value;
  }
  return undefined;
}

/**
 * CLIProxyAPI's fallback: FNV-1a 64 over the first 100 bytes of the system prompt, first
 * user message, and first assistant message. Later turns also carry the first turn's key
 * as `fallback`, so the binding made on turn one carries over once an assistant reply exists.
 */
function messageHashSession(request: ChatCompletions_RequestBody_Type): RoutingSession | undefined {
  let system: string | undefined;
  let user: string | undefined;
  let assistant: string | undefined;

  for (const message of request.messages) {
    const text = messageText(message.content);
    if (!text) continue;
    if ((message.role === "system" || message.role === "developer") && system === undefined) {
      system = text;
    } else if (message.role === "user" && user === undefined) {
      user = text;
    } else if (message.role === "assistant" && assistant === undefined) {
      assistant = text;
    }
  }

  if (!user) return undefined;
  const firstTurn = `msg:${fnv1a64([
    ["sys", system],
    ["usr", user],
  ])}`;
  if (!assistant) return { primary: firstTurn, isSubagent: false };

  const withReply = `msg:${fnv1a64([
    ["sys", system],
    ["usr", user],
    ["ast", assistant],
  ])}`;
  return { primary: withReply, fallback: firstTurn, isSubagent: false };
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const texts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join(" ") : undefined;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function fnv1a64(parts: Array<[label: string, text: string | undefined]>) {
  const encoder = new TextEncoder();
  let hash = FNV_OFFSET;

  for (const [label, text] of parts) {
    if (!text) continue;
    const bytes = encoder.encode(`${label}:${truncateBytes(text, HASH_PART_BYTES)}\n`);
    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME) & UINT64_MASK;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/** Truncate to a byte budget without splitting a UTF-8 code point. */
function truncateBytes(text: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/, "");
}

/** Trimmed, control-character-free IDs up to 256 bytes; longer IDs are rejected. */
function normalizeId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (new TextEncoder().encode(trimmed).length > MAX_ID_BYTES) return undefined;
  return trimmed;
}
