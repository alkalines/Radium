import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { requireWorkspaceAccessForUser } from "./workspaces";

const workspaceAccess = {
  args: { workspace: v.id("workspaces") },
  input: async (ctx: QueryCtx, args: { workspace: Id<"workspaces"> }) => {
    const identity = await authComponent.getAuthUser(ctx);
    
    if (!identity) throw new Error("Not logged in.");
    
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, identity._id);
    
    return { ctx: { identity, workspace }, args };
  },
};

/** Better Auth session + active workspace owner/member access; injects identity and workspace. */
export const workspaceQuery = customQuery(query, workspaceAccess);
export const workspaceMutation = customMutation(mutation, workspaceAccess);

/** Internal visibility still requires a propagated Better Auth session. Not for background jobs. */
export const internalWorkspaceQuery = customQuery(internalQuery, workspaceAccess);
export const internalWorkspaceMutation = customMutation(internalMutation, workspaceAccess);
