import { opaque } from "@alkalines/better-auth-opaque";
// The `relations-v2` entry is the adapter (and schema generator) for Drizzle 1.0.
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { newId } from "../db/ids";
import type { Database, Kv } from "../drivers/types";
import { createOpaqueHooks } from "../e2ee/hooks";
import { CLIENT_IP_HEADER } from "./ingress";
import { takeToken, type RateLimit } from "./ratelimit";
import * as authSchema from "./schema";
import { valkeySecondaryStorage } from "./secondary-storage";

/** Password reset links stay valid for one hour. */
const PASSWORD_RESET_TTL_SECONDS = 3600;

/**
 * Per-account budget of password attempts, behind the OPAQUE plugin's `accountRateLimit` hook
 * (sign-in, password proof, change-password and attach challenges). Better Auth's own limits are
 * per client address, so an attacker spreading guesses over many addresses is only slowed by
 * this one.
 *
 * The plugin computes the key as an HMAC of the lowercased email, identically for unknown emails,
 * so the decision cannot reveal whether an account exists. The cost of the limit is that anyone
 * who knows a user's email can spend that user's budget and delay their sign-in for up to an
 * hour; the budget is sized well above normal use to keep that a nuisance, not a lockout.
 */
const PASSWORD_ATTEMPTS: RateLimit = {
  name: "password-attempt",
  capacity: 30,
  periodMs: 60 * 60_000,
};

/** What the auth instance is built from. */
export type AuthDeps = {
  db: Database;
  kv: Kv;
  siteUrl: string;
  secret: string;
  opaqueServerSetup: string;
};

/**
 * Better Auth options of the backend.
 *
 * - Postgres (Drizzle adapter) is the record for users, accounts and sessions; Valkey caches
 *   sessions and holds the per-address rate-limit counters. `storeSessionInDatabase` keeps
 *   sessions in Postgres, so a Valkey restart signs nobody out and imported sessions keep working.
 * - Passwords go through OPAQUE (`opaque`); every registration carries an account key bundle
 *   (`../e2ee/hooks.ts`). Classic email/password stays enabled only so accounts created before
 *   encryption can sign in and migrate (attach); it no longer creates accounts.
 *   `emailAndPassword.disableSignUp` would also close OPAQUE sign-up, so the plugin overrides it.
 * - Rate-limit buckets are per client address taken from {@link CLIENT_IP_HEADER}, which only the
 *   ingress policy sets (`./ingress.ts`).
 * - Reset links put the token in the URL fragment so it never reaches server logs or `Referer`.
 * - New ids are UUIDv7 text, like every other table; imported users keep their Convex ids.
 */
export function authOptions(deps: AuthDeps) {
  return {
    baseURL: deps.siteUrl,
    basePath: "/api/auth",
    secret: deps.secret,
    database: drizzleAdapter(deps.db, { provider: "pg", schema: authSchema }),
    secondaryStorage: valkeySecondaryStorage(deps.kv),
    session: { storeSessionInDatabase: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: true,
    },
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
    },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => newId() },
    },
    plugins: [
      opaque({
        serverSetup: deps.opaqueServerSetup,
        keyStretching: "rfc-recommended",
        disableSignUp: false,
        hooks: createOpaqueHooks(deps.db),
        accountRateLimit: ({ key }) => takeToken(deps.kv, PASSWORD_ATTEMPTS, key),
        // Migration always proves the classic password; a fresh session alone could be a stolen
        // cookie (plugin assessment N2).
        attach: { requireCurrentPassword: true },
        passwordReset: {
          url: (token) => `${deps.siteUrl}/auth/reset-password#token=${token}`,
          expiresIn: PASSWORD_RESET_TTL_SECONDS,
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

/** Better Auth instance of one runtime. */
export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;
