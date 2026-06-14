import { v } from "convex/values";
import { credentialPreview, encryptCredentialRecord } from "@/utils/credential_crypto";
import { MCP_BEARER_SECRET_KEY } from "@/utils/chatroom/tools";
import { mutation, query } from "./_generated/server";
import { requireOwnedBalance } from "./keys";

/**
 * MCP (Model Context Protocol) server management. Each server belongs to a
 * balance and may carry an encrypted secret (a bearer token today). The
 * encryption scheme mirrors BYOK provider credentials: AES-GCM via
 * `PROVIDER_CREDENTIALS_SECRET`, with a masked preview kept for display.
 *
 * The chat HTTP handler reads servers through `internal.chatroom.resolveChatTools`
 * and decrypts secrets at request time — secrets are never returned to clients.
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

/**
 * Build the encrypted/preview pair for a server's secret. Returns `undefined`
 * for both when the auth type carries no secret or no value was supplied.
 */
async function buildSecret(auth: { type: "none" | "bearer" }, secret: string | undefined) {
  if (auth.type !== "bearer" || !secret?.trim()) {
    return { encrypted: undefined, preview: undefined };
  }

  const record = { [MCP_BEARER_SECRET_KEY]: secret.trim() };
  const encrypted = await encryptCredentialRecord(
    process.env.PROVIDER_CREDENTIALS_SECRET ?? "",
    record,
  );
  return {
    encrypted,
    preview: { [MCP_BEARER_SECRET_KEY]: credentialPreview(secret.trim()) },
  };
}

/** List the signed-in user's MCP servers for a balance (never returns secrets). */
export const listServers = query({
  args: { balance: v.id("balances") },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const servers = await ctx.db
      .query("mcp_servers")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .take(200);

    return servers.map((server) => ({
      _id: server._id,
      _creationTime: server._creationTime,
      name: server.name,
      url: server.url,
      transport: server.transport,
      auth: { type: server.auth.type },
      preview: server.preview,
      hasSecret: Boolean(server.encrypted),
    }));
  },
});

/** Create an MCP server, encrypting any supplied bearer token. */
export const createServer = mutation({
  args: {
    balance: v.id("balances"),
    name: v.string(),
    url: v.string(),
    auth: mcpAuthValidator,
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const name = args.name.trim();
    if (!name) throw new Error("Server name is required.");
    const url = normalizeUrl(args.url);
    if (args.auth.type === "bearer" && !args.secret?.trim()) {
      throw new Error("A bearer token is required for bearer authentication.");
    }

    const { encrypted, preview } = await buildSecret(args.auth, args.secret);

    return await ctx.db.insert("mcp_servers", {
      balance: args.balance,
      name,
      url,
      transport: "http",
      auth: args.auth,
      encrypted,
      preview,
    });
  },
});

/**
 * Update an MCP server. `secret` is only touched when provided: passing a new
 * value replaces the stored token, while omitting it preserves the existing one
 * (unless the auth type changes away from `bearer`, which clears it).
 */
export const updateServer = mutation({
  args: {
    server: v.id("mcp_servers"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    auth: v.optional(mcpAuthValidator),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const server = await ctx.db.get("mcp_servers", args.server);
    if (!server) throw new Error("MCP server not found.");
    await requireOwnedBalance(ctx, server.balance);

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
      patch.encrypted = undefined;
      patch.preview = undefined;
    } else if (args.secret?.trim()) {
      const { encrypted, preview } = await buildSecret(auth, args.secret);
      patch.encrypted = encrypted;
      patch.preview = preview;
    } else if (!server.encrypted) {
      throw new Error("A bearer token is required for bearer authentication.");
    }

    await ctx.db.patch("mcp_servers", args.server, patch);
  },
});

/**
 * Delete an MCP server. Dangling references in tool defaults or per-chat
 * selections are tolerated — the tool resolver filters to existing servers.
 */
export const deleteServer = mutation({
  args: { server: v.id("mcp_servers") },
  handler: async (ctx, args) => {
    const server = await ctx.db.get("mcp_servers", args.server);
    if (!server) return true;
    await requireOwnedBalance(ctx, server.balance);

    await ctx.db.delete("mcp_servers", args.server);
    return true;
  },
});
