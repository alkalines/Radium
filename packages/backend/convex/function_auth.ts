import { customCtx, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { requireWorkspaceAccessForUser, requireWorkspaceOwnedByUser } from "./workspaces";

/** Browser-session builders: always validate Better Auth, not the Convex JWT identity. */
const authenticated = customCtx(async (ctx: QueryCtx | MutationCtx) => {
  const user = await authComponent.getAuthUser(ctx);
  if (!user) throw new Error("Not logged in.");
  return { user };
});

export const authenticatedQuery = customQuery(query, authenticated);
export const authenticatedMutation = customMutation(mutation, authenticated);

/** Preserve legacy signed-out return values while making session lookup explicit. */
export const optionalSessionQuery = customQuery(
  query,
  customCtx(async (ctx: QueryCtx) => ({ user: await authComponent.getAuthUser(ctx) })),
);

const workspaceArgs = { workspace: v.id("workspaces") };

// Organization-derived workspace access is planned; only direct owner/member
// membership is authorized here until an explicit organization policy exists.
const owner = {
  args: workspaceArgs,
  input: async (ctx: QueryCtx | MutationCtx, args: { workspace: Id<"workspaces"> }) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not logged in.");
    const authorizedWorkspace = await requireWorkspaceOwnedByUser(ctx, args.workspace, user._id);
    return { ctx: { user, authorizedWorkspace }, args: { workspace: args.workspace } };
  },
};

const member = {
  args: workspaceArgs,
  input: async (ctx: QueryCtx | MutationCtx, args: { workspace: Id<"workspaces"> }) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) throw new Error("Not logged in.");
    const authorizedWorkspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    return { ctx: { user, authorizedWorkspace }, args: { workspace: args.workspace } };
  },
};

export const ownerQuery = customQuery(query, owner);
export const ownerMutation = customMutation(mutation, owner);
export const memberQuery = customQuery(query, member);
export const memberMutation = customMutation(mutation, member);

const optionalMember = {
  args: workspaceArgs,
  input: async (ctx: QueryCtx | MutationCtx, args: { workspace: Id<"workspaces"> }) => {
    const user = await authComponent.getAuthUser(ctx);
    const authorizedWorkspace = user
      ? await requireWorkspaceAccessForUser(ctx, args.workspace, user._id)
      : null;
    return { ctx: { user, authorizedWorkspace }, args: { workspace: args.workspace } };
  },
};

export const optionalMemberQuery = customQuery(query, optionalMember);
export const optionalMemberMutation = customMutation(mutation, optionalMember);

/** For internal functions called with a user ID derived by a trusted HTTP/action caller.
 * This checks the resource; it does not authenticate the caller or accept a browser userId.
 */
export const internalOwnerMutation = customMutation(internalMutation, {
  args: { workspace: v.id("workspaces"), userId: v.string() },
  input: async (ctx, args) => {
    const authorizedWorkspace = await requireWorkspaceOwnedByUser(ctx, args.workspace, args.userId);
    return { ctx: { authorizedWorkspace }, args };
  },
});

export const internalMemberMutation = customMutation(internalMutation, {
  args: { workspace: v.id("workspaces"), userId: v.string() },
  input: async (ctx, args) => {
    const authorizedWorkspace = await requireWorkspaceAccessForUser(ctx, args.workspace, args.userId);
    return { ctx: { authorizedWorkspace }, args };
  },
});

/** Only checks an active workspace record. The internal HTTP/action caller must
 * authenticate the request and authorize access before passing its workspace ID.
 */
export const internalActiveWorkspaceQuery = customQuery(internalQuery, {
  args: workspaceArgs,
  input: async (ctx, args) => {
    const activeWorkspace = await ctx.db.get("workspaces", args.workspace);
    if (!activeWorkspace || activeWorkspace.archivedAt !== undefined) {
      throw new Error("Workspace not found.");
    }
    return { ctx: { activeWorkspace }, args: { workspace: args.workspace } };
  },
});
