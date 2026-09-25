import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { betterAuth } from "better-auth";
import authConfig from "./auth.config";
import { v } from "convex/values";
import { customCtx, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import type { Id } from "./_generated/dataModel";
import { canAccessWorkspace } from "../src/workspaces/policy";

const siteUrl = process.env.SITE_URL!;

// The component client has methods needed for integrating Convex with Better Auth,
// as well as helper methods for general use.
export const authComponent = createClient<DataModel>(components.betterAuth);

const session = customCtx(
  async (
    ctx: QueryCtx | MutationCtx,
    { allowUnauthenticated }: { allowUnauthenticated?: boolean },
  ) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user && !allowUnauthenticated) throw new Error("Not logged in.");
    return { user };
  },
);

export const sessionQuery = customQuery(query, session);
export const sessionMutation = customMutation(mutation, session);

// Organization-derived access is planned. Today only the owner or an explicit
// workspace_members row grants access; no Better Auth organization is consulted.
const workspace = {
  args: { workspace: v.id("workspaces") },
  input: async (
    ctx: QueryCtx | MutationCtx,
    args: { workspace: Id<"workspaces"> },
    { role, allowUnauthenticated }: { role: "owner" | "member"; allowUnauthenticated?: boolean },
  ) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user && !allowUnauthenticated) throw new Error("Not logged in.");
    if (user) {
      const record = await ctx.db.get("workspaces", args.workspace);
      if (!record) throw new Error("Workspace not found.");
      const membership =
        role === "member" && record.ownerId !== user._id
          ? await ctx.db
              .query("workspace_members")
              .withIndex("by_workspace_and_userId", (q) =>
                q.eq("workspace", args.workspace).eq("userId", user._id),
              )
              .first()
          : null;
      if (!canAccessWorkspace(record, user._id, membership ? [membership] : [])) {
        throw new Error("Workspace not found.");
      }
      if (role === "owner" && record.ownerId !== user._id) {
        throw new Error("Workspace not found.");
      }
    }
    return { ctx: { user }, args: { workspace: args.workspace } };
  },
};

export const workspaceQuery = customQuery(query, workspace);
export const workspaceMutation = customMutation(mutation, workspace);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    // Configure simple, non-verified email/password to get started
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [
      // The Convex plugin is required for Convex compatibility
      convex({ authConfig, jwksRotateOnTokenGenerationError: true }),
    ],
  });
};

export type UserInfoType = {
  email: string;
  name: string;
  profilePicture?: string | null;
};

// userInfo intentionally returns null for signed-out callers (rather than throwing).
export const userInfo = sessionQuery({
  allowUnauthenticated: true,
  args: {},
  handler: async (ctx): Promise<UserInfoType | "Not logged in!"> => {
    const userAuth = ctx.user;
    if (!userAuth) return "Not logged in!";

    return {
      email: userAuth.email,
      name: userAuth.name,
      profilePicture: userAuth?.image,
    };
  },
});

export const internalUserInfo = internalQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<UserInfoType> => {
    const userInfo = await authComponent.getAnyUserById(ctx, args.userId);

    if (!userInfo) throw new Error("User not found.");

    return {
      email: userInfo.email,
      name: userInfo.name,
      profilePicture: userInfo.image,
    };
  },
});
