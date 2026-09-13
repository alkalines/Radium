import { v } from "convex/values";
import { credentialPreview } from "@/utils/credential_preview";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedWorkspace } from "./workspaces";
import {
  EXA_SECRET_NAME,
  exaSecretNamespace,
  secrets,
  workspaceExaSecretNamespace,
} from "./secrets";

/** The secret key under which the Exa API key is stored. */
export const EXA_API_KEY_SECRET = "apiKey";

/** Read the masked preview of a workspace's Exa key, or `null` if none is set. */
export const getApiKey = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args): Promise<{ preview: string } | null> => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const row = await secrets.get(ctx, {
      namespace: workspaceExaSecretNamespace(args.workspace),
      name: EXA_SECRET_NAME,
    });
    if (row.ok) {
      const preview = row.metadata?.preview?.[EXA_API_KEY_SECRET];
      return preview ? { preview } : null;
    }

    if (!workspace.legacyBalance) return null;
    const legacyRow = await secrets.get(ctx, {
      namespace: exaSecretNamespace(workspace.legacyBalance),
      name: EXA_SECRET_NAME,
    });
    const preview = legacyRow.ok ? legacyRow.metadata?.preview?.[EXA_API_KEY_SECRET] : undefined;
    return preview ? { preview } : null;
  },
});

/** Create or replace the workspace's Exa API key. */
export const setApiKey = mutation({
  args: { workspace: v.id("workspaces"), apiKey: v.string() },
  handler: async (ctx, args) => {
    await requireOwnedWorkspace(ctx, args.workspace);

    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new Error("An Exa API key is required.");

    const preview = { [EXA_API_KEY_SECRET]: credentialPreview(apiKey) };
    const result = await secrets.put(ctx, {
      namespace: workspaceExaSecretNamespace(args.workspace),
      name: EXA_SECRET_NAME,
      value: apiKey,
      metadata: { kind: "exa", workspace: args.workspace, preview },
    });

    return result.secretId;
  },
});

/** Delete the workspace's Exa API key. */
export const deleteApiKey = mutation({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    await secrets.remove(ctx, {
      namespace: workspaceExaSecretNamespace(args.workspace),
      name: EXA_SECRET_NAME,
    });
    if (workspace.legacyBalance) {
      await secrets.remove(ctx, {
        namespace: exaSecretNamespace(workspace.legacyBalance),
        name: EXA_SECRET_NAME,
      });
    }
    return true;
  },
});

/** Load the workspace's Exa API key for the server-side web-search tool. */
export const getApiKeyForRuntime = internalQuery({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace) return null;

    const row = await secrets.get(ctx, {
      namespace: workspaceExaSecretNamespace(args.workspace),
      name: EXA_SECRET_NAME,
    });
    if (row.ok) return row.value;
    if (!workspace.legacyBalance) return null;

    const legacyRow = await secrets.get(ctx, {
      namespace: exaSecretNamespace(workspace.legacyBalance),
      name: EXA_SECRET_NAME,
    });
    return legacyRow.ok ? legacyRow.value : null;
  },
});
