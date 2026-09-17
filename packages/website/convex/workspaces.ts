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
import { authComponent, createAuth } from "./auth";
import schema from "./schema";
import { canAccessResolvedChat, canAccessWorkspace } from "../src/utils/workspaces/policy";
import { isWorkspaceIconName } from "../src/utils/workspaces/icons";

const MAX_WORKSPACES = 100;
const MAX_MEMBERS = 200;
const MAX_NAME_LENGTH = 80;

const workspaceRoleValidator = v.union(v.literal("owner"), v.literal("member"));

const workspaceSummaryValidator = v.object({
  _id: v.id("workspaces"),
  _creationTime: v.number(),
  name: v.string(),
  icon: v.optional(v.string()),
  ownerType: v.literal("user"),
  role: workspaceRoleValidator,
});

const workspaceMemberSummaryValidator = v.object({
  userId: v.string(),
  email: v.string(),
  name: v.string(),
  role: workspaceRoleValidator,
});

const authorizedChatValidator = v.union(
  v.object({
    chat: schema.doc("aisdk_chats"),
    workspace: schema.doc("workspaces"),
  }),
  v.null(),
);

export type WorkspaceRecord = Doc<"workspaces">;

type WorkspaceRole = "owner" | "member";
type WorkspaceAccess = {
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
};

type WorkspaceMemberSummary = {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
};

type BetterAuthUser = {
  id?: string;
  _id?: string;
  email: string;
  name: string;
};

function normalizeWorkspaceName(name: string): string {
  const normalized = name
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error("Workspace name is required.");
  return normalized.slice(0, MAX_NAME_LENGTH);
}

function normalizeMemberEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Member email is required.");
  return normalized;
}

function isWorkspaceOwnedBy(workspace: WorkspaceRecord, userId: string): boolean {
  return workspace.ownerType === "user" && workspace.ownerId === userId;
}

function workspaceSummary(workspace: WorkspaceRecord, role: WorkspaceRole) {
  return {
    _id: workspace._id,
    _creationTime: workspace._creationTime,
    name: workspace.name,
    icon: workspace.icon,
    ownerType: workspace.ownerType,
    role,
  };
}

async function workspaceMemberForUser(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
) {
  return await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_userId", (q) =>
      q.eq("workspace", workspaceId).eq("userId", userId),
    )
    .first();
}

function legacyWorkspaceMatchesBalance(
  workspace: WorkspaceRecord,
  balance: Doc<"balances">,
): boolean {
  return (
    workspace.ownerType === "user" &&
    workspace.ownerId === balance.userId &&
    workspace.legacyBalance === balance._id
  );
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

/** Require an active workspace owned by or explicitly shared with a user. */
export async function requireWorkspaceAccessForUser(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<WorkspaceRecord> {
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace || !canAccessWorkspace(workspace, userId)) {
    const member = workspace ? await workspaceMemberForUser(ctx, workspaceId, userId) : null;
    if (!workspace || !member || !canAccessWorkspace(workspace, userId, [member])) {
      throw new Error("Workspace not found.");
    }
  }
  return workspace!;
}

/** Require the authenticated user to own or be explicitly assigned to a workspace. */
export async function requireWorkspaceAccess(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceRecord> {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");
  return await requireWorkspaceAccessForUser(ctx, workspaceId, identity._id);
}

async function authorizeChatRecord(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
  userId: string,
): Promise<{ chat: Doc<"aisdk_chats">; workspace: WorkspaceRecord } | null> {
  const chat = await ctx.db.get("aisdk_chats", chatId);
  if (!chat) return null;

  const workspace = await resolveWorkspaceForChat(ctx, chat);
  if (!workspace) return null;

  const member =
    workspace.ownerId === userId ? null : await workspaceMemberForUser(ctx, workspace._id, userId);
  const accessible = canAccessResolvedChat(
    {
      userId: chat.userId,
      workspaceId: chat.workspace,
      scope: chat.scope,
      balanceId: chat.balance,
    },
    workspace,
    workspace._id,
    userId,
    member ? [member] : [],
  );
  return accessible ? { chat, workspace } : null;
}

/** Require an authenticated user to have access to a personal or workspace chat. */
export async function requireAccessibleChat(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"aisdk_chats">,
) {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const authorized = await authorizeChatRecord(ctx, chatId, identity._id);
  if (!authorized) throw new Error("Chat not found.");
  return { ...authorized, userId: identity._id };
}

/** Authorize a chat for an HTTP caller after that caller's session was validated. */
export const authorizeChatForUser = internalQuery({
  args: { chatId: v.id("aisdk_chats"), userId: v.string() },
  returns: authorizedChatValidator,
  handler: async (ctx, args) => await authorizeChatRecord(ctx, args.chatId, args.userId),
});

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

async function resolveLegacyWorkspaceForChat(
  ctx: QueryCtx | MutationCtx,
  balanceId: Id<"balances">,
  chatUserId: string | undefined,
): Promise<WorkspaceRecord | null> {
  const balance = await ctx.db.get("balances", balanceId);
  if (!balance) return null;

  const workspace = await findWorkspaceForLegacyBalance(ctx, balanceId);
  if (
    !workspace ||
    !legacyWorkspaceMatchesBalance(workspace, balance) ||
    (chatUserId !== undefined && chatUserId !== workspace.ownerId)
  ) {
    return null;
  }
  return workspace;
}

/** Resolve new or legacy routing ownership while rejecting forged pointer combinations. */
export async function resolveWorkspaceForChat(
  ctx: QueryCtx | MutationCtx,
  chat: {
    workspace?: Id<"workspaces">;
    balance?: Id<"balances">;
    userId?: string;
  },
): Promise<WorkspaceRecord | null> {
  if (chat.workspace) {
    const workspace = await ctx.db.get("workspaces", chat.workspace);
    if (!workspace || workspace.ownerType !== "user") return null;
    if (!chat.balance) return workspace;

    const legacyWorkspace = await resolveLegacyWorkspaceForChat(ctx, chat.balance, chat.userId);
    return legacyWorkspace?._id === workspace._id ? workspace : null;
  }

  return chat.balance ? await resolveLegacyWorkspaceForChat(ctx, chat.balance, chat.userId) : null;
}

/** Return the first active owner workspace for deterministic legacy fallbacks. */
export async function getDefaultWorkspaceForUser(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<WorkspaceRecord | null> {
  const workspaces = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .take(MAX_WORKSPACES);
  return workspaces.find((workspace) => canAccessWorkspace(workspace, userId)) ?? null;
}

async function accessibleWorkspacesForUser(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<WorkspaceAccess[]> {
  const accessible = new Map<Id<"workspaces">, WorkspaceAccess>();
  const owned = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .take(MAX_WORKSPACES);
  for (const workspace of owned) {
    if (canAccessWorkspace(workspace, userId)) {
      accessible.set(workspace._id, { workspace, role: "owner" });
    }
  }

  const memberships = await ctx.db
    .query("workspace_members")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(MAX_WORKSPACES);
  for (const membership of memberships) {
    if (accessible.has(membership.workspace)) continue;
    const workspace = await ctx.db.get("workspaces", membership.workspace);
    if (workspace && canAccessWorkspace(workspace, userId, [membership])) {
      accessible.set(workspace._id, { workspace, role: "member" });
    }
  }

  return [...accessible.values()]
    .sort((a, b) => a.workspace._creationTime - b.workspace._creationTime)
    .slice(0, MAX_WORKSPACES);
}

/** List active owned and explicitly shared workspaces for the authenticated user. */
export const list = query({
  args: {},
  returns: v.union(v.literal("Not logged in!"), v.array(workspaceSummaryValidator)),
  handler: async (ctx) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) return "Not logged in!" as const;

    const workspaces = await accessibleWorkspacesForUser(ctx, identity._id);
    return workspaces.map(({ workspace, role }) => workspaceSummary(workspace, role));
  },
});

/** Internal equivalent used by HTTP actions after they validate a Better Auth session. */
export const listForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.array(schema.doc("workspaces")),
  handler: async (ctx, args) => {
    const workspaces = await accessibleWorkspacesForUser(ctx, args.userId);
    return workspaces.map(({ workspace }) => workspace);
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
        if (mapped) {
          if (!legacyWorkspaceMatchesBalance(mapped, balance)) {
            throw new Error("Legacy workspace owner mismatch.");
          }
          if (mapped.archivedAt !== undefined) throw new Error("Workspace is archived.");
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
      if (!legacyWorkspaceMatchesBalance(existing, balance)) {
        throw new Error("Legacy workspace owner mismatch.");
      }
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

export const setIcon = mutation({
  args: { workspace: v.id("workspaces"), icon: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    if (!isWorkspaceIconName(args.icon)) throw new Error("Unsupported workspace icon.");
    await ctx.db.patch("workspaces", workspace._id, { icon: args.icon });
    return null;
  },
});

/** List the owner and explicit members of an active workspace. */
export const listMembers = query({
  args: { workspace: v.id("workspaces") },
  returns: v.array(workspaceMemberSummaryValidator),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

    const members: WorkspaceMemberSummary[] = [
      {
        userId: workspace.ownerId,
        email: identity.email,
        name: identity.name,
        role: "owner" as const,
      },
    ];
    const memberships = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(MAX_MEMBERS);
    for (const membership of memberships) {
      if (membership.userId === workspace.ownerId) continue;
      const user = await authComponent.getAnyUserById(ctx, membership.userId);
      if (!user) continue;
      members.push({
        userId: membership.userId,
        email: user.email,
        name: user.name,
        role: "member" as const,
      });
    }
    return members;
  },
});

async function findBetterAuthUserByEmail(
  ctx: QueryCtx | MutationCtx,
  email: string,
): Promise<BetterAuthUser | null> {
  // Better Auth stores sign-up emails in lowercase; the Convex adapter does
  // not support case-insensitive where clauses, so query the normalized value.
  const adapter = authComponent.adapter(ctx)(createAuth(ctx).options);
  return await adapter.findOne<BetterAuthUser>({
    model: "user",
    where: [{ field: "email", value: normalizeMemberEmail(email) }],
  });
}

function betterAuthUserId(user: BetterAuthUser): string | undefined {
  return user.id ?? user._id;
}

/** Add an existing Better Auth user to an active workspace. */
export const addMember = mutation({
  args: { workspace: v.id("workspaces"), email: v.string() },
  returns: v.id("workspace_members"),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const user = await findBetterAuthUserByEmail(ctx, args.email);
    if (!user) throw new Error("User not found.");

    const userId = betterAuthUserId(user);
    if (!userId) throw new Error("User not found.");
    if (userId === workspace.ownerId) throw new Error("The workspace owner is implicit.");

    const existing = await workspaceMemberForUser(ctx, workspace._id, userId);
    if (existing) return existing._id;
    return await ctx.db.insert("workspace_members", {
      workspace: workspace._id,
      userId,
      role: "member",
    });
  },
});

/** Remove an explicit member by their existing Better Auth email. */
export const removeMember = mutation({
  args: { workspace: v.id("workspaces"), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const user = await findBetterAuthUserByEmail(ctx, args.email);
    if (!user) throw new Error("User not found.");

    const userId = betterAuthUserId(user);
    if (!userId) throw new Error("User not found.");
    if (userId === workspace.ownerId) throw new Error("The workspace owner is implicit.");

    const existing = await workspaceMemberForUser(ctx, workspace._id, userId);
    if (existing) await ctx.db.delete("workspace_members", existing._id);
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

/** Restore an archived workspace; membership remains attached to the workspace. */
export const restore = mutation({
  args: { workspace: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || !isWorkspaceOwnedBy(workspace, identity._id)) {
      throw new Error("Workspace not found.");
    }
    if (workspace.archivedAt === undefined) return null;

    await ctx.db.patch("workspaces", workspace._id, { archivedAt: undefined });
    return null;
  },
});

/** List archived workspaces owned by the authenticated user. */
export const listArchived = query({
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
      .filter(
        (workspace) =>
          isWorkspaceOwnedBy(workspace, identity._id) && workspace.archivedAt !== undefined,
      )
      .map((workspace) => workspaceSummary(workspace, "owner"));
  },
});
