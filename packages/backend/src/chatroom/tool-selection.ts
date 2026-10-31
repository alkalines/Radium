import { v } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { getDefaultWorkspaceForUser } from "../../convex/workspaces";
import { BUILTIN_TOOL_SETS, enabledBuiltinToolSets, storedBuiltinToolSets } from "./tools";

/**
 * Workspace tool selections: which built-in tool sets and MCP servers are active for workspace
 * defaults and per-chat overrides. Registered Convex handlers in `convex/chatroom.ts` and
 * `convex/aisdk.ts` authorize the workspace and call these helpers.
 */

const VALID_BUILTIN_IDS = new Set<string>(BUILTIN_TOOL_SETS.map((toolSet) => toolSet.id));

/**
 * Built-in tool set IDs plus workspace MCP server IDs, as clients send them: the complete list
 * of enabled sets, including default-on ones. Storage converts it with {@link storedSelection}.
 */
export const toolSelectionValidator = v.object({
  builtinToolSets: v.array(v.string()),
  mcpServers: v.array(v.id("mcp_servers")),
});

/** A complete selection of enabled built-in set ids and workspace MCP server ids. */
export type WorkspaceToolSelection = {
  builtinToolSets: string[];
  mcpServers: Id<"mcp_servers">[];
};

/** A selection as stored on workspace defaults and chat overrides (`./tools.ts`). */
type StoredToolSelection = WorkspaceToolSelection & { disabledBuiltinToolSets?: string[] };

/**
 * Sanitise a selection against the workspace: unknown built-in IDs and MCP servers from other
 * workspaces are dropped silently. Legacy user-owned servers are accepted only by the
 * deterministic migration workspace. Callers authorize the workspace first.
 */
async function sanitizeSelection(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  selection: WorkspaceToolSelection,
): Promise<WorkspaceToolSelection> {
  const builtinToolSets = selection.builtinToolSets.filter((id) => VALID_BUILTIN_IDS.has(id));

  const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
  const acceptsLegacyServers = defaultWorkspace?._id === workspace._id;
  const mcpServers: Id<"mcp_servers">[] = [];
  for (const serverId of selection.mcpServers) {
    const server = await ctx.db.get("mcp_servers", serverId);
    if (!server) continue;

    const workspaceServer = server.workspace === workspace._id;
    const legacyServer =
      acceptsLegacyServers && server.workspace === undefined && server.userId === workspace.ownerId;
    if (workspaceServer || legacyServer) mcpServers.push(serverId);
  }

  return { builtinToolSets, mcpServers };
}

/** The effective, sanitized selection of a stored one: default-on sets count unless switched off. */
export function readStoredSelection(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  stored: StoredToolSelection,
): Promise<WorkspaceToolSelection> {
  return sanitizeSelection(ctx, workspace, {
    builtinToolSets: enabledBuiltinToolSets(stored),
    mcpServers: stored.mcpServers,
  });
}

/**
 * Sanitise a client selection and convert it to its stored form, recording switched-off
 * default-on sets as opt-outs. Use for every write of defaults or a chat override.
 */
export async function storedSelection(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  selection: WorkspaceToolSelection,
): Promise<StoredToolSelection> {
  const sanitized = await sanitizeSelection(ctx, workspace, selection);
  return { ...storedBuiltinToolSets(sanitized.builtinToolSets), mcpServers: sanitized.mcpServers };
}
