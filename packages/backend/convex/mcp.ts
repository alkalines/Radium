import { v } from "convex/values";
import { credentialPreview } from "@/credential_preview";
import { MCP_BEARER_SECRET_KEY } from "@/chatroom/tools";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  getDefaultWorkspaceForUser,
  requireOwnedWorkspace,
  requireWorkspaceAccess,
} from "./workspaces";
import {
  MCP_SECRET_NAME,
  mcpSecretNamespace,
  secrets,
  workspaceMcpSecretNamespace,
  type SecretNamespace,
} from "./secrets";

/**
 * MCP (Model Context Protocol) server management. Each server belongs to a
 * BetterAuth user and may carry a secret (a bearer token today) stored in the
 * shared Secret Store component, with a masked preview kept for display.
 */

/**
 * Validator for an MCP auth config. Only `none` and `bearer` are supported now;
 * the union is left open for OAuth.
 *
 * @todo Add `oauth` (OAuth 2.0) and `oauth2.1` (OAuth 2.1 + PKCE) variants and
 *   the redirect/token-exchange flow that backs them.
 */
const mcpAuthValidator = v.union(
  v.object({ type: v.literal("none") }),
  v.object({ type: v.literal("bearer") }),
);

type SecretReadResult = Awaited<ReturnType<typeof secrets.get>>;
type SecretLookup = { namespace: SecretNamespace; name: string };

async function readSecret(
  ctx: QueryCtx | MutationCtx,
  lookup: SecretLookup,
  description: string,
): Promise<SecretReadResult> {
  try {
    const result = await secrets.get(ctx, lookup);
    if (!result.ok && result.reason !== "not_found") {
      throw new Error(`Secret Store recovery required for ${description} (${result.reason}).`);
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Secret Store recovery required")) {
      throw error;
    }
    throw new Error(`Secret Store recovery required for ${description}.`, { cause: error });
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("MCP server URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP server URL must use http or https.");
  }
  return parsed.toString();
}

function buildPreview(auth: { type: "none" | "bearer" }, secret: string | undefined) {
  if (auth.type !== "bearer" || !secret?.trim()) return undefined;
  return { [MCP_BEARER_SECRET_KEY]: credentialPreview(secret.trim()) };
}

/** Legacy MCP rows are user-owned until the deterministic workspace mapping runs. */
async function isLegacyServerForWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  server: Doc<"mcp_servers">,
): Promise<boolean> {
  if (server.workspace !== undefined || server.userId !== workspace.ownerId) return false;
  const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
  return defaultWorkspace?._id === workspace._id;
}

/** List a workspace's MCP servers (never returns secrets). */
export const listServers = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireWorkspaceAccess(ctx, args.workspace);

    const workspaceServers = await ctx.db
      .query("mcp_servers")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .take(200);

    const defaultWorkspace = await getDefaultWorkspaceForUser(ctx, workspace.ownerId);
    const legacyServers =
      defaultWorkspace?._id === workspace._id
        ? await ctx.db
            .query("mcp_servers")
            .withIndex("by_userId", (q) => q.eq("userId", workspace.ownerId))
            .take(200)
        : [];
    const visibleServers = [
      ...workspaceServers.map((server) => ({ server, legacy: false })),
      ...legacyServers
        .filter((server) => server.workspace === undefined)
        .map((server) => ({ server, legacy: true })),
    ];

    const result = [];
    for (const { server, legacy } of visibleServers) {
      const workspaceSecret =
        server.auth.type === "bearer"
          ? await readSecret(
              ctx,
              {
                namespace: workspaceMcpSecretNamespace(args.workspace, server._id),
                name: MCP_SECRET_NAME,
              },
              "workspace MCP bearer token",
            )
          : null;
      const legacySecret =
        workspaceSecret && !workspaceSecret.ok && legacy
          ? await readSecret(
              ctx,
              {
                namespace: mcpSecretNamespace(server._id),
                name: MCP_SECRET_NAME,
              },
              "legacy MCP bearer token",
            )
          : null;
      result.push({
        _id: server._id,
        _creationTime: server._creationTime,
        name: server.name,
        url: server.url,
        transport: server.transport,
        auth: { type: server.auth.type },
        preview: server.auth.type === "bearer" ? server.preview : undefined,
        hasSecret: workspaceSecret?.ok === true || legacySecret?.ok === true,
      });
    }

    return result;
  },
});

/** Create an MCP server, storing any supplied bearer token in Secret Store. */
export const createServer = mutation({
  args: {
    workspace: v.id("workspaces"),
    name: v.string(),
    url: v.string(),
    auth: mcpAuthValidator,
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const userId = workspace.ownerId;

    const name = args.name.trim();
    if (!name) throw new Error("Server name is required.");
    const url = normalizeUrl(args.url);
    if (args.auth.type === "bearer" && !args.secret?.trim()) {
      throw new Error("A bearer token is required for bearer authentication.");
    }

    const preview = buildPreview(args.auth, args.secret);

    const serverId = await ctx.db.insert("mcp_servers", {
      userId,
      workspace: args.workspace,
      name,
      url,
      transport: "http",
      auth: args.auth,
      preview,
    });

    if (args.auth.type === "bearer") {
      await secrets.put(ctx, {
        namespace: workspaceMcpSecretNamespace(args.workspace, serverId),
        name: MCP_SECRET_NAME,
        value: args.secret!.trim(),
        metadata: { kind: "mcp", mcpServer: serverId, preview },
      });
    }

    return serverId;
  },
});

/**
 * Update an MCP server. `secret` is only touched when provided: passing a new
 * value replaces the stored token, while omitting it preserves the existing one
 * (unless the auth type changes away from `bearer`, which clears it).
 */
export const updateServer = mutation({
  args: {
    workspace: v.id("workspaces"),
    server: v.id("mcp_servers"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    auth: v.optional(mcpAuthValidator),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const server = await ctx.db.get("mcp_servers", args.server);
    const legacy = server ? await isLegacyServerForWorkspace(ctx, workspace, server) : false;
    if (!server || (server.workspace !== args.workspace && !legacy)) {
      throw new Error("MCP server not found.");
    }

    const auth = args.auth ?? server.auth;
    const patch: Record<string, unknown> = { auth };

    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Server name is required.");
      patch.name = name;
    }
    if (args.url !== undefined) {
      patch.url = normalizeUrl(args.url);
    }

    // Resolve the secret. A non-bearer auth type drops any stored token.
    if (auth.type !== "bearer") {
      patch.preview = undefined;
      await Promise.all([
        secrets.remove(ctx, {
          namespace: workspaceMcpSecretNamespace(args.workspace, args.server),
          name: MCP_SECRET_NAME,
        }),
        secrets.remove(ctx, {
          namespace: mcpSecretNamespace(args.server),
          name: MCP_SECRET_NAME,
        }),
      ]);
    } else if (args.secret?.trim()) {
      const preview = buildPreview(auth, args.secret);
      patch.preview = preview;
      await secrets.put(ctx, {
        namespace: workspaceMcpSecretNamespace(args.workspace, args.server),
        name: MCP_SECRET_NAME,
        value: args.secret.trim(),
        metadata: { kind: "mcp", mcpServer: args.server, preview },
      });
      if (legacy) {
        await secrets.remove(ctx, {
          namespace: mcpSecretNamespace(args.server),
          name: MCP_SECRET_NAME,
        });
      }
    } else {
      const workspaceSecret = await readSecret(
        ctx,
        {
          namespace: workspaceMcpSecretNamespace(args.workspace, args.server),
          name: MCP_SECRET_NAME,
        },
        "workspace MCP bearer token",
      );
      const existingSecret = workspaceSecret.ok
        ? workspaceSecret
        : legacy
          ? await readSecret(
              ctx,
              {
                namespace: mcpSecretNamespace(args.server),
                name: MCP_SECRET_NAME,
              },
              "legacy MCP bearer token",
            )
          : null;
      if (!existingSecret || !existingSecret.ok) {
        throw new Error("A bearer token is required for bearer authentication.");
      }
      if (!workspaceSecret.ok) {
        await secrets.put(ctx, {
          namespace: workspaceMcpSecretNamespace(args.workspace, args.server),
          name: MCP_SECRET_NAME,
          value: existingSecret.value,
          metadata: { kind: "mcp", mcpServer: args.server, preview: server.preview },
        });
      }
    }

    await ctx.db.patch("mcp_servers", args.server, { ...patch, workspace: args.workspace });
  },
});

/**
 * Delete an MCP server. Dangling references in tool defaults or per-chat
 * selections are tolerated — the tool resolver filters to existing servers.
 */
export const deleteServer = mutation({
  args: { workspace: v.id("workspaces"), server: v.id("mcp_servers") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const server = await ctx.db.get("mcp_servers", args.server);
    const legacy = server ? await isLegacyServerForWorkspace(ctx, workspace, server) : false;
    if (!server || (server.workspace !== args.workspace && !legacy)) {
      return true;
    }

    await secrets.remove(ctx, {
      namespace: workspaceMcpSecretNamespace(args.workspace, args.server),
      name: MCP_SECRET_NAME,
    });
    await secrets.remove(ctx, {
      namespace: mcpSecretNamespace(args.server),
      name: MCP_SECRET_NAME,
    });
    await ctx.db.delete("mcp_servers", args.server);
    return true;
  },
});
