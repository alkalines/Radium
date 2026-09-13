import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import schema from "./schema";
import { canAccessResolvedChat, canAccessWorkspace } from "../src/utils/workspaces/policy";

const MAX_WORKSPACES = 100;
const MAX_NAME_LENGTH = 80;

const workspaceSummaryValidator = v.object({
  _id: v.id("workspaces"),
  _creationTime: v.number(),
  name: v.string(),
  ownerType: v.literal("user"),
});

export type WorkspaceRecord = Doc<"workspaces">;

function normalizeWorkspaceName(name: string): string {
  const normalized = name
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error("Workspace name is required.");
  return normalized.slice(0, MAX_NAME_LENGTH);
}

function workspaceSummary(workspace: WorkspaceRecord) {
  return {
    _id: workspace._id,
    _creationTime: workspace._creationTime,
    name: workspace.name,
    ownerType: workspace.ownerType,
  };
}

/** Require a non-archived personal workspace owned by the Better Auth user. */
export async function requireOwnedWorkspace(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceRecord> {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace || !canAccessWorkspace(workspace, identity._id)) {
    throw new Error("Workspace not found.");
  }
  return workspace;
}

/** Check a server-derived user ID for internal HTTP/action authorization. */
export async function requireWorkspaceOwnedByUser(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<WorkspaceRecord> {
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace || !canAccessWorkspace(workspace, userId)) {
    throw new Error("Workspace not found.");
  }
  return workspace;
}

/** Require an authenticated user to have access to a personal or workspace chat. */
export async function requireAccessibleChat(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
) {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const chat = await ctx.db.get("aisdk_chats", chatId);
  if (!chat) throw new Error("Chat not found.");
  const workspace = await resolveWorkspaceForChat(ctx, chat);
  if (
    !workspace ||
    !canAccessResolvedChat(
      {
        userId: chat.userId,
        workspaceId: chat.workspace,
        scope: chat.scope ?? "personal",
        balanceId: chat.balance,
      },
      workspace,
      workspace._id,
      identity._id,
    )
  ) {
    throw new Error("Chat not found.");
  }
  return { chat, workspace, userId: identity._id };
}

/** Resolve the workspace created from a legacy balance during the migration window. */
export async function findWorkspaceForLegacyBalance(
  ctx: QueryCtx | MutationCtx,
  balanceId: Id<"balances">,
): Promise<WorkspaceRecord | null> {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", balanceId))
    .first();
}

/** Resolve new or legacy routing ownership without changing persisted legacy IDs. */
export async function resolveWorkspaceForChat(
  ctx: QueryCtx | MutationCtx,
  chat: { workspace?: Id<"workspaces">; balance?: Id<"balances"> },
): Promise<WorkspaceRecord | null> {
  if (chat.workspace) {
    const workspace = await ctx.db.get("workspaces", chat.workspace);
    if (workspace) return workspace;
  }
  return chat.balance ? findWorkspaceForLegacyBalance(ctx, chat.balance) : null;
}

/** List active personal workspaces for the authenticated user. */
export const list = query({
  args: {},
  returns: v.union(v.literal("Not logged in!"), v.array(workspaceSummaryValidator)),
  handler: async (ctx) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!" as const;

    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", identity._id))
      .take(MAX_WORKSPACES);

    return workspaces
      .filter((workspace) => canAccessWorkspace(workspace, identity._id))
      .map(workspaceSummary);
  },
});

/** Internal equivalent used by HTTP actions after they validate a Better Auth session. */
export const listForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.array(schema.doc("workspaces")),
  handler: async (ctx, args) => {
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.userId))
      .take(MAX_WORKSPACES);

    return workspaces.filter((workspace) => canAccessWorkspace(workspace, args.userId));
  },
});

/** Validate an opaque URL workspace identifier without casting untrusted input. */
export const getOwnedWorkspaceForUser = internalQuery({
  args: { workspace: v.string(), userId: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, args) => {
    const workspaceId = ctx.db.normalizeId("workspaces", args.workspace);
    if (!workspaceId) return null;
    const workspace = await ctx.db.get("workspaces", workspaceId);
    return workspace && canAccessWorkspace(workspace, args.userId) ? workspace._id : null;
  },
});

/**
 * Create the first workspace without requiring dashboard provisioning. If a
 * legacy balance exists, create a mapping immediately so old credentials and
 * API keys remain usable while the resumable migration is pending.
 */
export const ensurePersonalWorkspace = mutation({
  args: { name: v.optional(v.string()) },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", identity._id))
      .take(MAX_WORKSPACES);
    const active = existing.find((workspace) => canAccessWorkspace(workspace, identity._id));
    if (active) return active._id;

    // This index is a transitional read only; new application behavior never
    // creates or provisions credits on a balance.
    const legacyBalances = await ctx.db
      .query("balances")
      .withIndex("by_userId", (q) => q.eq("userId", identity._id))
      .take(MAX_WORKSPACES);

    if (legacyBalances.length > 0) {
      const workspaceIds: Id<"workspaces">[] = [];
      for (const balance of legacyBalances) {
        const mapped = await findWorkspaceForLegacyBalance(ctx, balance._id);
        if (mapped && canAccessWorkspace(mapped, identity._id)) {
          workspaceIds.push(mapped._id);
          continue;
        }

        workspaceIds.push(
          await ctx.db.insert("workspaces", {
            ownerType: "user",
            ownerId: identity._id,
            name: normalizeWorkspaceName(args.name ?? "Personal workspace"),
            legacyBalance: balance._id,
            legacyOrganizationId: balance.organizationId,
            legacyTeamId: balance.teamId,
          }),
        );
      }
      return workspaceIds[0]!;
    }

    return await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: identity._id,
      name: normalizeWorkspaceName(args.name ?? "Personal workspace"),
    });
  },
});

/** Create a legacy balance mapping for an API request arriving before backfill. */
export const ensureForLegacyBalance = internalMutation({
  args: { balance: v.id("balances") },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const balance = await ctx.db.get("balances", args.balance);
    if (!balance) throw new Error("Legacy API-key owner not found.");

    const existing = await findWorkspaceForLegacyBalance(ctx, args.balance);
    if (existing) {
      if (existing.archivedAt !== undefined) throw new Error("Workspace is archived.");
      return existing._id;
    }

    return await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: balance.userId,
      name: "Personal workspace",
      legacyBalance: balance._id,
      legacyOrganizationId: balance.organizationId,
      legacyTeamId: balance.teamId,
    });
  },
});

/** Add another independent personal workspace. */
export const create = mutation({
  args: { name: v.string() },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", identity._id))
      .take(MAX_WORKSPACES + 1);
    if (existing.length >= MAX_WORKSPACES) throw new Error("Workspace limit reached.");

    return await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: identity._id,
      name: normalizeWorkspaceName(args.name),
    });
  },
});

export const rename = mutation({
  args: { workspace: v.id("workspaces"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    await ctx.db.patch("workspaces", workspace._id, { name: normalizeWorkspaceName(args.name) });
    return null;
  },
});

/**
 * Archive an empty workspace without deleting its historical records. Hard
 * deletion is intentionally deferred until a retention and dependency policy
 * exists for completions, traces, credentials, and chats.
 */
export const archive = mutation({
  args: { workspace: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const activeWorkspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", workspace.ownerId))
      .take(MAX_WORKSPACES)
      .then((rows) => rows.filter((row) => canAccessWorkspace(row, workspace.ownerId)));
    if (activeWorkspaces.length <= 1) {
      throw new Error("Keep at least one active workspace.");
    }

    const chats = await ctx.db
      .query("aisdk_chats")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(1);
    if (chats.length > 0) throw new Error("Delete or move this workspace's chats first.");
    if (workspace.legacyBalance) {
      const legacyChats = await ctx.db
        .query("aisdk_chats")
        .withIndex("by_balance", (q) => q.eq("balance", workspace.legacyBalance!))
        .take(1);
      if (legacyChats.length > 0) throw new Error("Delete or move this workspace's chats first.");
    }

    await ctx.db.patch("workspaces", workspace._id, { archivedAt: Date.now() });
    return null;
  },
});
