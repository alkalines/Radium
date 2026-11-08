import { opaque } from "@alkalines/better-auth-opaque";
import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction, internalQuery, query } from "./_generated/server";
import { APIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";
import { v } from "convex/values";
import { CLIENT_IP_HEADER, prepareAuthRequest } from "../src/e2ee/auth-ingress";
import { createOpaqueHooks } from "../src/e2ee/hooks";

// The component client has methods needed for integrating Convex with Better Auth,
// as well as helper methods for general use. Better Auth is installed locally
// (`convex/betterAuth/`), so the client is typed by the generated component schema.
export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
});

/** Password reset links stay valid for one hour. */
const PASSWORD_RESET_TTL_SECONDS = 3600;

/**
 * Better Auth options of the app runtime. The OPAQUE plugin throws without `serverSetup`, so a
 * deployment missing `OPAQUE_SERVER_SETUP` fails instead of running without password sign-in.
 * Code that only reads the schema uses {@link createSchemaAuthOptions}.
 *
 * - Passwords go through OPAQUE (`opaque`); every registration carries an account key bundle
 *   (`src/e2ee/hooks.ts`). Classic email/password stays enabled only so accounts created before
 *   encryption can sign in; it no longer creates accounts.
 * - Rate limiting is explicit and stored in the database, so every HTTP action instance shares
 *   the same counters. Buckets are per client address taken from {@link CLIENT_IP_HEADER},
 *   which only `createAuth`'s request preparation sets (`src/e2ee/auth-ingress.ts`).
 * - Reset links put the token in the URL fragment so it never reaches server logs or `Referer`.
 */
export const createAuthOptions = (
  ctx: GenericCtx<DataModel>,
  serverSetup: string | undefined = process.env.OPAQUE_SERVER_SETUP,
) => {
  return {
    baseURL: process.env.SITE_URL,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: true,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
    },
    plugins: [
      // The Convex plugin is required for Convex compatibility and stays first.
      convex({ authConfig, jwksRotateOnTokenGenerationError: true }),
      opaque({
        // Missing setup is rejected by the plugin at construction.
        serverSetup: serverSetup ?? "",
        keyStretching: "rfc-recommended",
        hooks: createOpaqueHooks(ctx),
        passwordReset: {
          url: (token) => `${process.env.SITE_URL}/auth/reset-password#token=${token}`,
          expiresIn: PASSWORD_RESET_TTL_SECONDS,
        },
      }),
    ],
  } satisfies BetterAuthOptions;
};

/**
 * Placeholder for the two code paths that only read Better Auth's schema: the component adapter
 * (component modules cannot read the deployment's environment variables) and the schema
 * generation CLI (it runs without them). It is not a valid serenity setup, so a server that
 * somehow used it would fail closed with `INVALID_SERVER_SETUP`.
 */
const SCHEMA_ONLY_SERVER_SETUP = "schema-only: not a server setup";

/** Options for schema consumers; see {@link SCHEMA_ONLY_SERVER_SETUP}. */
export const createSchemaAuthOptions = (ctx: GenericCtx<DataModel>) =>
  createAuthOptions(ctx, SCHEMA_ONLY_SERVER_SETUP);

/**
 * Better Auth instance for one Convex function. Its HTTP handler first applies the ingress
 * policy of `src/e2ee/auth-ingress.ts` (trusted client address for rate limiting, body size
 * bound); server-side `auth.api` calls are unaffected.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const auth = betterAuth(createAuthOptions(ctx));
  const handler = async (request: Request) => {
    const prepared = await prepareAuthRequest(ctx, request);
    if (prepared instanceof Response) {
      return prepared;
    }
    return await auth.handler(prepared);
  };
  return { ...auth, handler, fetch: handler };
};

/**
 * Operator tool (`bunx convex run auth:issuePasswordResetLink '{"email": "…"}'`): mints a
 * one-hour, single-use OPAQUE reset link and returns it to the operator, who hands it to the user.
 * Internal only: a public wrapper would let anyone take over accounts (audit I3). The link is
 * never logged; it is as sensitive as a password until it expires or is used.
 *
 * @returns the link and its expiry, or `not-found` when no OPAQUE account has this email
 * (classic accounts cannot be reset this way).
 */
export const issuePasswordResetLink = internalAction({
  args: { email: v.string() },
  returns: v.union(
    v.object({ status: v.literal("issued"), url: v.string(), expiresAt: v.number() }),
    v.object({ status: v.literal("not-found") }),
  ),
  handler: async (ctx, args) => {
    try {
      const { url, expiresAt } = await createAuth(ctx).api.createPasswordResetToken({
        body: { email: args.email },
      });
      return { status: "issued" as const, url, expiresAt: new Date(expiresAt).getTime() };
    } catch (error) {
      if (error instanceof APIError && error.status === "NOT_FOUND") {
        return { status: "not-found" as const };
      }
      throw error;
    }
  },
});

export type UserInfoType = {
  email: string;
  name: string;
  profilePicture?: string | null;
};

export const userInfo = query({
  args: {},
  handler: async (ctx): Promise<UserInfoType | "Not logged in!"> => {
    const userAuth = await authComponent.getAuthUser(ctx);
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
