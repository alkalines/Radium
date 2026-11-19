import type { ChatCompletions_RequestBody_Type } from "@/types/openai/types";
import { workspaceHash } from "../telemetry/hash";

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
export async function extractRoutingSession(
  request: ChatCompletions_RequestBody_Type,
  headers?: Headers,
  chatId?: string,
  workspace?: string,
): Promise<RoutingSession | undefined> {
  const explicit = explicitSessionId(request, headers, chatId);

  if (explicit) {
    const parent = headers ? firstValidHeader(headers, PARENT_HEADERS) : undefined;
    if (parent) {
      const prefix = explicit.key.slice(0, explicit.key.indexOf(":"));
      return { primary: explicit.key, fallback: `${prefix}:${parent}`, isSubagent: true };
    }
    return { primary: explicit.key, isSubagent: false };
  }

  if (!workspace) return undefined;
  try {
    return await messageHashSession(request, workspace);
  } catch {
    // Missing deployment hash key disables affinity rather than persisting guessable hashes.
    return undefined;
  }
}

/**
 * The client's own session id, unprefixed, when it sent one: the routing session's header,
 * body `session_id` or `prompt_cache_key` (never `user`, a chat or a message hash). Coding
 * agents send theirs (OpenCode: `x-session-id: ses_…`), which Activity uses to join their
 * Gateway calls to the agent session so its local usage is not counted twice.
 */
export function clientSessionId(request: ChatCompletions_RequestBody_Type, headers?: Headers) {
  return explicitSessionId(request, headers, undefined)?.client;
}

function explicitSessionId(
  request: ChatCompletions_RequestBody_Type,
  headers: Headers | undefined,
  chatId: string | undefined,
): { key: string; client?: string } | undefined {
  if (chatId) return { key: `chat:${chatId}` };

  if (headers) {
    for (const [header, prefix] of SESSION_HEADERS) {
      const value = normalizeId(headers.get(header));
      if (value) return { key: `${prefix}:${value}`, client: value };
    }
  }

  // `user` names an end user, not a session.
  const bodyIds: Array<[value: string | undefined, prefix: string, session: boolean]> = [
    [request.session_id, "session", true],
    [request.prompt_cache_key, "pck", true],
    [request.user, "user", false],
  ];
  for (const [rawValue, prefix, session] of bodyIds) {
    const value = normalizeId(rawValue);
    if (value) return { key: `${prefix}:${value}`, ...(session ? { client: value } : {}) };
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
 * Hash bounded first messages with a workspace-specific secret. Later turns retain the first
 * turn's key as fallback so the initial binding can be reused.
 */
async function messageHashSession(request: ChatCompletions_RequestBody_Type, workspace: string): Promise<RoutingSession | undefined> {
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
  const first = JSON.stringify([truncateBytes(system ?? "", HASH_PART_BYTES), truncateBytes(user, HASH_PART_BYTES)]);
  const firstTurn = `msg:${await workspaceHash(workspace, "routing-session", first)}`;
  if (!assistant) return { primary: firstTurn, isSubagent: false };
  const withReply = `msg:${await workspaceHash(workspace, "routing-session", JSON.stringify([first, truncateBytes(assistant, HASH_PART_BYTES)]))}`;
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
