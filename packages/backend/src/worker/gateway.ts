import { ConvexError, v } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { components } from "../../convex/_generated/api";
import { ownedWorkspaceMutation } from "../../convex/helpers";
import { generateApiKey, hashText } from "../../convex/keys";
import { workspaceOpenaiModels } from "../../convex/models";
import { acpGatewayAccessValidator, keyTelemetryValidator } from "../acp/gateway";
import { requireActiveWorkspaceWorker } from "./chat-config";
import { workspaceWorkerMetadata } from "./chat-selection";
import { workerMutation, workerQuery } from "./machine";

export function findWorkerGateway(
  ctx: QueryCtx | MutationCtx,
  workspace: Id<"workspaces">,
  worker: string,
) {
  return ctx.db
    .query("worker_gateway")
    .withIndex("by_workspace_and_worker", (q) => q.eq("workspace", workspace).eq("worker", worker))
    .unique();
}

async function requireWorker(ctx: MutationCtx, workspace: Id<"workspaces">, worker: string) {
  await requireActiveWorkspaceWorker(worker, workspace, workspaceWorkerMetadata(ctx, workspace));
}

export const setGatewayAccess = ownedWorkspaceMutation({
  args: { workerId: v.string(), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorker(ctx, ctx.workspace._id, args.workerId);
    const row = await findWorkerGateway(ctx, ctx.workspace._id, args.workerId);
    if (args.enabled && row && (row.access === "pending" || row.access === "active")) return null;
    if (!args.enabled && row?.key) await ctx.db.patch(row.key, { revokedAt: Date.now() });
    const patch = {
      access: args.enabled ? ("pending" as const) : ("off" as const),
      key: undefined,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert("worker_gateway", {
        workspace: ctx.workspace._id,
        worker: args.workerId,
        telemetry: "workspace",
        ...patch,
      });
    return null;
  },
});

export const issueGatewayKey = ownedWorkspaceMutation({
  args: { workerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorker(ctx, ctx.workspace._id, args.workerId);
    const row = await findWorkerGateway(ctx, ctx.workspace._id, args.workerId);
    if (!row || row.access === "off")
      throw new ConvexError({
        code: "ACP_GATEWAY_UNAVAILABLE",
        message: "Gateway access is off on this Worker.",
      });
    if (row.key) await ctx.db.patch(row.key, { revokedAt: Date.now() });
    await ctx.db.patch(row._id, { access: "pending", key: undefined, updatedAt: Date.now() });
    return null;
  },
});

export const setGatewayTelemetry = ownedWorkspaceMutation({
  args: { workerId: v.string(), telemetry: keyTelemetryValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorker(ctx, ctx.workspace._id, args.workerId);
    const row = await findWorkerGateway(ctx, ctx.workspace._id, args.workerId);
    if (row) {
      await ctx.db.patch(row._id, { telemetry: args.telemetry, updatedAt: Date.now() });
      if (row.key)
        await ctx.db.patch(row.key, { telemetry: args.telemetry === "off" ? "off" : undefined });
    } else
      await ctx.db.insert("worker_gateway", {
        workspace: ctx.workspace._id,
        worker: args.workerId,
        access: "off",
        telemetry: args.telemetry,
        updatedAt: Date.now(),
      });
    return null;
  },
});

export const gatewayState = workerQuery({
  args: {},
  returns: v.object({ access: acpGatewayAccessValidator, keyId: v.optional(v.id("api_keys")) }),
  handler: async (ctx) => {
    const row = await findWorkerGateway(ctx, ctx.worker.workspaceId, ctx.worker.workerId);
    return { access: row?.access ?? "off", ...(row?.key ? { keyId: row.key } : {}) };
  },
});

export const mintGatewayKey = workerMutation({
  args: {},
  returns: v.object({ keyId: v.id("api_keys"), key: v.string() }),
  handler: async (ctx) => {
    const row = await findWorkerGateway(ctx, ctx.worker.workspaceId, ctx.worker.workerId);
    if (!row || (row.access !== "pending" && row.access !== "active"))
      throw new ConvexError({
        code: "ACP_GATEWAY_UNAVAILABLE",
        message: "Gateway access is not ready to issue a key on this Worker.",
      });
    const worker = await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: ctx.worker.workspaceId,
      workerId: ctx.worker.workerId,
    });
    if (row.key) await ctx.db.patch(row.key, { revokedAt: Date.now() });
    const { key, preview } = generateApiKey();
    const keyId = await ctx.db.insert("api_keys", {
      workspace: ctx.worker.workspaceId,
      name: worker.name,
      hash: await hashText(key),
      preview,
      worker: ctx.worker.workerId,
      ...(row.telemetry === "off" ? { telemetry: "off" as const } : {}),
    });
    await ctx.db.patch(row._id, { access: "active", key: keyId, updatedAt: Date.now() });
    return { keyId, key };
  },
});

export const gatewayModels = workerQuery({
  args: {},
  returns: v.array(
    v.object({
      slug: v.string(),
      name: v.string(),
      context: v.optional(v.number()),
      output: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) =>
    (await workspaceOpenaiModels(ctx, ctx.worker.workspaceId)).map((model) => ({
      slug: model.id,
      name: model.name ?? model.id,
      ...(model.context_length != null ? { context: model.context_length } : {}),
      ...(model.top_provider?.max_completion_tokens != null
        ? { output: model.top_provider.max_completion_tokens }
        : {}),
    })),
});
