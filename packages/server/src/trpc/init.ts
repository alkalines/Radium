import { initTRPC, TRPCError } from "@trpc/server";
import * as z from "zod";
import type { Runtime } from "../runtime";
import { resolveWorker } from "../worker/auth";
import { workspaceAccess } from "../workspaces/access";

/** Per-request tRPC context: the runtime and the request's headers (cookies, bearer token). */
export type Context = { runtime: Runtime; headers: Headers };

const t = initTRPC.context<Context>().create();

export const router = t.router;

/** No caller identity. */
export const publicProcedure = t.procedure;

/**
 * A signed-in user. The Better Auth session is resolved once per request: from the Valkey cache,
 * or from Postgres when the cache misses.
 */
export const sessionProcedure = t.procedure.use(async ({ ctx, next }) => {
  const session = await ctx.runtime.auth.api.getSession({ headers: ctx.headers });
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { user: session.user, session: session.session } });
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
export const workerProcedure = t.procedure.use(async ({ ctx, next }) => {
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
