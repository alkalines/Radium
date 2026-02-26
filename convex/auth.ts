import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { components } from "./_generated/api";
import { DataModel, Doc, Id } from "./_generated/dataModel";
import { internalQuery, query } from "./_generated/server";
import { betterAuth } from "better-auth";
import authConfig from "./auth.config";
import { v } from "convex/values";

const siteUrl = process.env.SITE_URL!;

// The component client has methods needed for integrating Convex with Better Auth,
// as well as helper methods for general use.
export const authComponent = createClient<DataModel>(components.betterAuth);

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
      convex({ authConfig, jwksRotateOnTokenGenerationError: true, }),
    ],
  });
};

export type UserInfoType = {
  email: string
  name: string,
  profilePicture?: string | null,
  balances: Doc<"balances">[]
}

export const userInfo = query({
  handler: async (ctx): Promise<UserInfoType | "Not logged in!"> => {
    const userAuth = await authComponent.getAuthUser(ctx);
    if (!userAuth) return "Not logged in!";

    /**
     * @todo Organization and teams support
     */
    const balances = await ctx.db.query("balances").filter((q) => q.eq(q.field("userId"), userAuth._id)).collect()

    return {
      email: userAuth.email,
      name: userAuth.name,
      profilePicture: userAuth?.image,
      balances: balances,
    };
  },
});

export const internalUserInfo = internalQuery({
  args: {
    userId: v.string()
  },
  handler: async (ctx, args): Promise<UserInfoType> => {
    const userInfo = await authComponent.getAnyUserById(ctx, args.userId)

    /**
     * @todo Organization and teams support
     */
    const balances = await ctx.db.query("balances").filter((q) => q.eq(q.field("userId"), userInfo!._id)).collect()

    return {
      email: userInfo!.email,
      name: userInfo!.name,
      profilePicture: userInfo!.image,
      balances: balances,
    };
  },
});
