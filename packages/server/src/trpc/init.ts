import { initTRPC, TRPCError } from "@trpc/server";
import * as z from "zod";
import { AppError } from "../errors";
import type { Runtime } from "../runtime";
import { resolveWorker } from "../worker/auth";
import { mutationSubject, publishMutationEvent } from "../streams/events";
import { workspaceAccess } from "../workspaces/access";

/**
 * Per-request tRPC context: the runtime, the request's headers (cookies, bearer token) and, over
 * HTTP, the client address rate limits key on (`../auth/ingress.ts`), resolved only when asked.
 */
export type Context = {
  runtime: Runtime;
  headers: Headers;
  clientAddress?: () => Promise<string | null>;
};

const t = initTRPC.context<Context>().create({
  // tRPC adds stack traces whenever NODE_ENV is not "production"; a self-hosted build must not
  // depend on that being set, so stacks are never sent.
  isDev: false,
  // Only domain refusals (`AppError`) carry their message to the client. An internal error's
  // message may hold SQL, parameters or driver details, so the client gets a generic one.
  errorFormatter: ({ shape, error }) =>
    error.code === "INTERNAL_SERVER_ERROR" ? { ...shape, message: "Internal server error" } : shape,
});

export const router = t.router;

/** No caller identity. Every procedure builds on it, so domain errors map in one place. */
export const publicProcedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof AppError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: cause.code, message: cause.message, cause });
  }
  return result;
});

/**
 * A signed-in user. The Better Auth session is resolved once per request: from the Valkey cache,
 * or from Postgres when the cache misses.
 *
 * A mutation that succeeds publishes an invalidation event to whoever else displays what it
 * changed (`../streams/events.ts`), after the response and best effort.
 */
export const sessionProcedure = publicProcedure.use(async ({ ctx, next, path, type, getRawInput }) => {
  const session = await ctx.runtime.auth.api.getSession({ headers: ctx.headers });
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const subject =
    type === "mutation"
      ? await mutationSubject(ctx.runtime.drivers.db, session.user.id, path, await getRawInput())
      : null;
  const result = await next({ ctx: { user: session.user, session: session.session } });
  if (result.ok && subject) {
    publishMutationEvent(ctx.runtime, subject, { path, userId: session.user.id, result: result.data });
  }
  return result;
});

/**
 * The input names a workspace the signed-in user owns or is a direct member of; archived
 * workspaces are refused. Every refusal is the same `NOT_FOUND`, so callers cannot probe which
 * workspaces exist. `ctx.access.role` tells owners from members.
 */
export const workspaceProcedure = sessionProcedure
  .input(z.object({ workspace: z.string().min(1) }))
  .use(async ({ ctx, input, next }) => {
    const access = await workspaceAccess(ctx.runtime.drivers.db, ctx.user.id, input.workspace);
    if (!access) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
    }
    return next({ ctx: { access } });
  });

/** {@link workspaceProcedure} for the workspace's owner only; members get the same `NOT_FOUND`. */
export const ownedWorkspaceProcedure = workspaceProcedure.use(async ({ ctx, next }) => {
  if (ctx.access.role !== "owner") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
  }
  return next();
});

/**
 * A Worker machine, authenticated by its access token (`Authorization: Bearer`). The token is
 * re-checked against current state on every call (`../worker/auth.ts`), so revocation applies
 * immediately. This grants identity only; handlers still check capabilities and assignments.
 */
export const workerProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const authorization = ctx.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const worker = token
    ? await resolveWorker(ctx.runtime.drivers.db, ctx.runtime.workerTokens, token)
    : null;
  if (!worker) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "WORKER_AUTH_DENIED" });
  }
  return next({ ctx: { worker } });
});
