/** Runtime-neutral Chatroom tool configuration rules shared by Convex and the chat action. */
/** Credential provider identity, independent of the built-in tool-set id. */
export const EXA_TOOL_CREDENTIAL_PROVIDER = "exa" as const;

export function normalizeMcpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("MCP server URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP server URL must use http or https.");
  }
  return parsed.toString();
}

export function requireMcpName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Server name is required.");
  return trimmed;
}

export function requireExaApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("An Exa API key is required.");
  return trimmed;
}

/** Sanitise an MCP server name into a safe tool-name prefix (`[a-z0-9_]`). */
export function toolNamePrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "mcp";
}

/** Append a counter when a tool name already exists, including built-in tools. */
export function uniqueToolName(tools: Record<string, unknown>, name: string): string {
  if (!(name in tools)) return name;
  let counter = 2;
  while (`${name}_${counter}` in tools) counter++;
  return `${name}_${counter}`;
}
