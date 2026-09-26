import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import {
  loadWorkspaceSettings,
  requireWorkspaceAccessForUser,
  requireWorkspaceOwnedByUser,
  updateWorkspaceSettings,
} from "./workspaces";

const workspaceArgs = { workspace: v.id("workspaces") };

/**
 * Validate the Better Auth session and workspace access before loading settings.
 * Members can read workspace defaults; owner-only builders reject them before
 * their handler runs. Chat visibility is checked separately by chat handlers.
 */
async function workspaceContext(
  ctx: QueryCtx,
  args: { workspace: Id<"workspaces"> },
  ownerOnly = false,
) {
  const identity = await authComponent.getAuthUser(ctx);

  if (!identity) throw new Error("Not logged in.");

  const record = ownerOnly
    ? await requireWorkspaceOwnedByUser(ctx, args.workspace, identity._id)
    : await requireWorkspaceAccessForUser(ctx, args.workspace, identity._id);

  // Resolve the legacy fallback once. Handlers receive an entry-time snapshot.
  const settings = await loadWorkspaceSettings(ctx, record);

  const workspace = {
    ...record,
    settings,
  };

  return { ctx: { identity, workspace }, args };
}

/**
 * Add a writer only to mutation contexts. The writer checks ownership even when
 * the surrounding mutation allows members, and does not refresh the snapshot.
 */
async function workspaceMutationContext(
  ctx: MutationCtx,
  args: { workspace: Id<"workspaces"> },
  ownerOnly = false,
) {
  const result = await workspaceContext(ctx, args, ownerOnly);
  const { identity, workspace } = result.ctx;

  return {
    ...result,
    ctx: {
      identity,
      workspace: {
        ...workspace,
        updateSettings: (overrides: Parameters<typeof updateWorkspaceSettings>[3]) =>
          updateWorkspaceSettings(ctx, workspace, identity._id, overrides),
      },
    },
  };
}

const workspaceAccess = {
  args: workspaceArgs,
  input: (ctx: QueryCtx, args: { workspace: Id<"workspaces"> }) => workspaceContext(ctx, args),
};

const workspaceWriteAccess = {
  args: workspaceArgs,
  input: (ctx: MutationCtx, args: { workspace: Id<"workspaces"> }) =>
    workspaceMutationContext(ctx, args),
};

const ownerAccess = {
  args: workspaceArgs,
  input: (ctx: QueryCtx, args: { workspace: Id<"workspaces"> }) =>
    workspaceContext(ctx, args, true),
};

const ownerWriteAccess = {
  args: workspaceArgs,
  input: (ctx: MutationCtx, args: { workspace: Id<"workspaces"> }) =>
    workspaceMutationContext(ctx, args, true),
};

/** Owner/member reads with an authorized workspace and its effective settings. */
export const workspaceQuery = customQuery(query, workspaceAccess);

/** Owner/member mutations; settings updates independently require ownership. */
export const workspaceMutation = customMutation(mutation, workspaceWriteAccess);

/** Owner-only reads, including workspace telemetry configuration. */
export const ownedWorkspaceQuery = customQuery(query, ownerAccess);

/** Owner-only mutations for workspace configuration and defaults. */
export const ownedWorkspaceMutation = customMutation(mutation, ownerWriteAccess);

/** Internal visibility still requires a propagated Better Auth session. Not for background jobs. */
export const internalWorkspaceQuery = customQuery(internalQuery, workspaceAccess);

/** Session-backed internal mutations with the same owner-only settings writer. */
export const internalWorkspaceMutation = customMutation(internalMutation, workspaceWriteAccess);
