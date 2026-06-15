/**
 * Chatroom tools: the shared, type-safe contract for the built-in tool sets and
 * the MCP (Model Context Protocol) server connections a user can attach to a
 * chat.
 *
 * This module is imported by both the frontend (settings page, chat composer)
 * and Convex (schema validators, the chat HTTP handler), so it must stay pure
 * data + types — no React, no Node, no Convex bindings. Icons and any runtime
 * tool builders live next to the code that consumes them.
 */

/**
 * Transports an MCP server connection can use. Only Streamable HTTP is wired up
 * today; the union is kept open so SSE can be added without reshaping callers.
 *
 * @todo Support the `"sse"` transport.
 */
export type McpTransportType = "http";

/**
 * Authentication strategies for an MCP server connection.
 *
 * - `none` — public server, no credentials sent.
 * - `bearer` — a static token sent as `Authorization: Bearer <token>`. The token
 *   is stored in the backend Secret Store.
 *
 * @todo `oauth` (OAuth 2.0) and `oauth2.1` (OAuth 2.1 + PKCE) — these need an
 *   `OAuthClientProvider` wired into the MCP transport's `authProvider` plus a
 *   redirect/token-exchange flow. Modeled here so storage and UI are ready.
 */
export type McpAuthType = "none" | "bearer";

/** UI metadata for each selectable MCP auth strategy. */
export const MCP_AUTH_TYPES = [
  {
    value: "none",
    label: "None",
    description: "Public server. No credentials are sent.",
    /** Whether this auth type needs a user-supplied secret. */
    requiresSecret: false,
  },
  {
    value: "bearer",
    label: "Bearer token",
    description: "A static token sent as an Authorization header. Stored in Secret Store.",
    requiresSecret: true,
  },
  // @todo { value: "oauth", label: "OAuth 2.0", ... }
  // @todo { value: "oauth2.1", label: "OAuth 2.1", ... }
] as const satisfies readonly {
  value: McpAuthType;
  label: string;
  description: string;
  requiresSecret: boolean;
}[];

/** The preview key for an MCP bearer token. */
export const MCP_BEARER_SECRET_KEY = "token";

/**
 * A built-in tool set bundled with the app (as opposed to a user-attached MCP
 * server). Entries are pure configuration: they describe what the tool set is
 * and whether it can execute yet. Selecting an unavailable set is harmless — it
 * is persisted but contributes no runtime tools until a builder is implemented.
 */
export type BuiltinToolSet = {
  /**
   * Stable identifier persisted inside tool selections. Treat as an API
   * contract: never rename or reuse an id once it has shipped.
   */
  id: string;
  /** Human-facing name shown in settings and the chat tools menu. */
  name: string;
  /** One-line summary of what the tool set offers. */
  description: string;
  /**
   * Whether the tool set actually contributes executable tools at runtime.
   * Config-only entries (`false`) are selectable but produce no tools yet.
   *
   * @todo Implement executable builders for these and flip to `true`.
   */
  available: boolean;
};

/**
 * The configurable registry of built-in tool sets.
 *
 * These are intentionally config-only for now — they make the selection UI and
 * persistence real end-to-end, but none execute yet. To ship a working tool
 * set, add its executable builder where `streamText` is configured (see
 * `convex/http/aisdk.chat.ts`) and set `available: true` here.
 */
export const BUILTIN_TOOL_SETS = [
  {
    id: "web_search",
    name: "Web Search",
    description: "Let the model search the web for up-to-date information (powered by Exa).",
    available: true,
  },
  {
    id: "code_interpreter",
    name: "Code Interpreter",
    description: "Run code in a sandbox to compute answers and analyse data.",
    available: false,
  },
  {
    id: "image_generation",
    name: "Image Generation",
    description: "Generate images from natural-language prompts.",
    available: false,
  },
] as const satisfies readonly BuiltinToolSet[];

/** Union of every shipped built-in tool set id. */
export type BuiltinToolSetId = (typeof BUILTIN_TOOL_SETS)[number]["id"];

/**
 * Id of the Web Search built-in tool set. Shared so the chat handler and Exa
 * credential UI can refer to it without a magic string.
 */
export const WEB_SEARCH_TOOL_ID = "web_search" satisfies BuiltinToolSetId;

/** Look up a built-in tool set definition by id. */
export function getBuiltinToolSet(id: string): BuiltinToolSet | undefined {
  return BUILTIN_TOOL_SETS.find((toolSet) => toolSet.id === id);
}

/**
 * A user's tool selection — which built-in sets and which MCP servers are
 * active. Used both as the per-user default and as a per-chat override. MCP
 * server ids are kept as plain strings here so the type is reusable on the
 * client; Convex narrows them to `Id<"mcp_servers">` at its boundaries.
 */
export type ToolSelection = {
  builtinToolSets: string[];
  mcpServers: string[];
};

/** An empty selection (no tools enabled). */
export const EMPTY_TOOL_SELECTION: ToolSelection = {
  builtinToolSets: [],
  mcpServers: [],
};
