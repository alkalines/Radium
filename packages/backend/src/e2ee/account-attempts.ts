import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "../../convex/_generated/api";
import { internalMutation } from "../../convex/_generated/server";

/**
 * Per-account budget of password attempts, behind the OPAQUE plugin's `accountRateLimit` hook
 * (sign-in, password proof, change-password and attach challenges). Better Auth's own limits are
 * per client address, so an attacker spreading guesses over many addresses is only slowed by
 * this one.
 *
 * The plugin computes `key` as an HMAC of the lowercased email, identically for unknown emails,
 * so the decision cannot reveal whether an account exists. The cost of the limit is that anyone
 * who knows a user's email can spend that user's budget and delay their sign-in for up to an
 * hour; the budget is sized well above normal use to keep that a nuisance, not a lockout.
 */
const limiter = new RateLimiter(components.rateLimiter, {
  passwordAttempt: { kind: "token bucket", rate: 30, period: 60 * 60_000, capacity: 30 },
});

/** Takes one attempt from the account's budget; `false` refuses the attempt (`TOO_MANY_ATTEMPTS`). */
export const takeAccountAttempt = internalMutation({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const status = await limiter.limit(ctx, "passwordAttempt", { key: args.key });
    return status.ok;
  },
});
