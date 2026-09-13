import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { credentialPreview } from "../src/utils/credential_preview";
import { chatWorkspaceBackfillPatch } from "../src/utils/workspaces/migration";
import {
  MCP_SECRET_NAME,
  balanceSecretName,
  EXA_SECRET_NAME,
  exaSecretNamespace,
  mcpSecretNamespace,
  providerSecretNamespace,
  secrets,
  workspaceExaSecretNamespace,
  workspaceMcpSecretNamespace,
  workspaceProviderSecretNamespace,
} from "./secrets";
import { providerSnapshotFromCatalog } from "../src/utils/workspaces/provider";

export const migrations = new Migrations(components.migrations, { schema });

const DEFAULT_WORKSPACE_NAME = "Personal workspace";
const MAX_PROVIDER_CATALOG = 200;

async function providerCatalog(ctx: MutationCtx) {
  const providers = await ctx.db.query("providers").take(MAX_PROVIDER_CATALOG + 1);
  if (providers.length > MAX_PROVIDER_CATALOG) {
    throw new Error(
      `Provider catalogue exceeds the migration limit of ${MAX_PROVIDER_CATALOG}; paginate the catalogue before running ownership migration.`,
    );
  }
  return providers;
}

async function workspaceForBalance(ctx: MutationCtx, balanceId: Id<"balances">) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", balanceId))
    .first();
}

async function workspaceForUser(ctx: MutationCtx, userId: string) {
  const existing = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .first();
  if (existing) return existing;

  return await ctx.db.insert("workspaces", {
    ownerType: "user",
    ownerId: userId,
    name: DEFAULT_WORKSPACE_NAME,
  });
}

async function workspaceDocumentForUser(ctx: MutationCtx, userId: string) {
  const workspace = await workspaceForUser(ctx, userId);
  return typeof workspace === "string" ? await ctx.db.get("workspaces", workspace) : workspace;
}

async function existingWorkspaceCredential(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  provider: string,
) {
  return await ctx.db
    .query("workspace_credentials")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .first();
}

async function migrateProviderSecretsForBalance(
  ctx: MutationCtx,
  balance: Doc<"balances">,
  workspace: Doc<"workspaces">,
) {
  const providers = await providerCatalog(ctx);
  for (const provider of providers) {
    const configuration = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", workspace._id).eq("provider", provider.slug),
      )
      .first();
    if (configuration?.deletedAt !== undefined) continue;

    const oldNamespace = providerSecretNamespace(provider.slug);
    const oldSecret = await secrets.get(ctx, {
      namespace: oldNamespace,
      name: balanceSecretName(balance._id),
    });
    if (!oldSecret.ok) continue;

    const newNamespace = workspaceProviderSecretNamespace(workspace._id, provider.slug);
    const newSecret = await secrets.get(ctx, {
      namespace: newNamespace,
      name: provider.slug,
    });
    if (!newSecret.ok) {
      await secrets.put(ctx, {
        namespace: newNamespace,
        name: provider.slug,
        value: oldSecret.value,
        metadata: {
          kind: "provider",
          provider: provider.slug,
          workspace: workspace._id,
          preview:
            oldSecret.metadata?.preview ?? parseCredentialPreview(oldSecret.value, provider.env),
        },
      });
    }

    if (!(await existingWorkspaceCredential(ctx, workspace._id, provider.slug))) {
      await ctx.db.insert("workspace_credentials", {
        workspace: workspace._id,
        provider: provider.slug,
        preview:
          oldSecret.metadata?.preview ?? parseCredentialPreview(oldSecret.value, provider.env),
      });
    }
  }
}

async function migrateExaSecretForBalance(
  ctx: MutationCtx,
  balance: Doc<"balances">,
  workspace: Doc<"workspaces">,
) {
  const oldSecret = await secrets.get(ctx, {
    namespace: exaSecretNamespace(balance._id),
    name: EXA_SECRET_NAME,
  });
  if (!oldSecret.ok) return;

  const namespace = workspaceExaSecretNamespace(workspace._id);
  const newSecret = await secrets.get(ctx, { namespace, name: EXA_SECRET_NAME });
  if (newSecret.ok) return;

  await secrets.put(ctx, {
    namespace,
    name: EXA_SECRET_NAME,
    value: oldSecret.value,
    metadata: {
      kind: "exa",
      workspace: workspace._id,
      preview: oldSecret.metadata?.preview ?? { apiKey: credentialPreview(oldSecret.value) },
    },
  });
}

async function migrateMcpSecret(
  ctx: MutationCtx,
  server: Doc<"mcp_servers">,
  workspace: Doc<"workspaces">,
) {
  const oldSecret = await secrets.get(ctx, {
    namespace: mcpSecretNamespace(server._id),
    name: MCP_SECRET_NAME,
  });
  if (!oldSecret.ok) return;

  const namespace = workspaceMcpSecretNamespace(workspace._id, server._id);
  const newSecret = await secrets.get(ctx, { namespace, name: MCP_SECRET_NAME });
  if (newSecret.ok) return;

  await secrets.put(ctx, {
    namespace,
    name: MCP_SECRET_NAME,
    value: oldSecret.value,
    metadata: {
      kind: "mcp",
      mcpServer: server._id,
      preview: server.preview,
    },
  });
}

function parseCredentialPreview(value: string, env: string[]): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      env
        .map((name) => [name, (parsed as Record<string, unknown>)[name]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, credential]) => [name, credentialPreview(credential)]),
    );
  } catch {
    return {};
  }
}

/** Create one personal workspace for each legacy balance. */
export const workspacesFromBalances = migrations.define({
  table: "balances",
  batchSize: 1,
  migrateOne: async (ctx, balance) => {
    if (await workspaceForBalance(ctx, balance._id)) return;

    await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: balance.userId,
      name: DEFAULT_WORKSPACE_NAME,
      legacyBalance: balance._id,
      legacyOrganizationId: balance.organizationId,
      legacyTeamId: balance.teamId,
    });
  },
});

/** Give users with settings but no balance a personal workspace. */
export const workspacesFromSettings = migrations.define({
  table: "chatroom_settings",
  batchSize: 10,
  migrateOne: async (ctx, settings) => {
    await workspaceForUser(ctx, settings.userId);
  },
});

/** Copy the global provider catalogue's enabled state into each workspace. */
export const workspaceConfigurations = migrations.define({
  table: "workspaces",
  batchSize: 1,
  migrateOne: async (ctx, workspace) => {
    const providers = await providerCatalog(ctx);
    for (const provider of providers) {
      const existing = await ctx.db
        .query("workspace_configurations")
        .withIndex("by_workspace_and_provider", (q) =>
          q.eq("workspace", workspace._id).eq("provider", provider.slug),
        )
        .first();
      if (existing) {
        if (!existing.snapshot && existing.deletedAt === undefined) {
          await ctx.db.patch("workspace_configurations", existing._id, {
            snapshot: providerSnapshotFromCatalog(provider),
          });
        }
        continue;
      }

      await ctx.db.insert("workspace_configurations", {
        workspace: workspace._id,
        provider: provider.slug,
        enabled: provider.enabled,
        active: provider.enabled,
        snapshot: providerSnapshotFromCatalog(provider),
      });
    }
  },
});

/** Copy encrypted provider and Exa secrets into workspace namespaces. */
export const workspaceCredentials = migrations.define({
  table: "balances",
  batchSize: 1,
  migrateOne: async (ctx, balance) => {
    const workspace = await workspaceForBalance(ctx, balance._id);
    if (!workspace) return;
    await migrateProviderSecretsForBalance(ctx, balance, workspace);
    await migrateExaSecretForBalance(ctx, balance, workspace);
  },
});

/** Copy legacy key hashes without carrying over credit limits or usage counters. */
export const apiKeysFromKeys = migrations.define({
  table: "keys",
  batchSize: 25,
  migrateOne: async (ctx, key) => {
    const workspace = await workspaceForBalance(ctx, key.balance);
    if (!workspace) return;

    const existing = await ctx.db
      .query("api_keys")
      .withIndex("by_legacyKey", (q) => q.eq("legacyKey", key._id))
      .first();
    if (existing) return;

    await ctx.db.insert("api_keys", {
      workspace: workspace._id,
      name: key.name,
      hash: key.hash,
      preview: key.preview,
      legacyKey: key._id,
    });
  },
});

/** Associate MCP servers with their user's personal workspace. */
export const mcpServersToWorkspaces = migrations.define({
  table: "mcp_servers",
  batchSize: 25,
  migrateOne: async (ctx, server) => {
    const workspace = server.workspace
      ? await ctx.db.get("workspaces", server.workspace)
      : await workspaceDocumentForUser(ctx, server.userId);
    if (!workspace) return;
    await migrateMcpSecret(ctx, server, workspace);
    if (server.workspace) return;
    return { workspace: workspace._id };
  },
});

/** Copy per-user Chatroom defaults to the user's first workspace. */
export const chatroomSettingsToWorkspaces = migrations.define({
  table: "chatroom_settings",
  batchSize: 25,
  migrateOne: async (ctx, settings) => {
    const workspace = await workspaceDocumentForUser(ctx, settings.userId);
    if (!workspace) return;

    const existing = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .first();
    if (existing) return;

    await ctx.db.insert("workspace_settings", {
      workspace: workspace._id,
      defaultModel: settings.defaultModel,
      titleModel: settings.titleModel,
      enableChainOfThought: settings.enableChainOfThought,
      telemetry: settings.telemetry,
      builtinToolSets: settings.builtinToolSets,
      mcpServers: settings.mcpServers,
    });
  },
});

/** Add explicit personal workspace scope to legacy chats. */
export const chatsToWorkspaces = migrations.define({
  table: "aisdk_chats",
  batchSize: 25,
  migrateOne: async (ctx, chat) => {
    if (chat.workspace && chat.scope) return;
    const workspace = chat.workspace
      ? await ctx.db.get("workspaces", chat.workspace)
      : chat.balance
        ? await workspaceForBalance(ctx, chat.balance)
        : await workspaceDocumentForUser(ctx, chat.userId);
    if (!workspace) return;
    return chatWorkspaceBackfillPatch(chat, workspace._id);
  },
});

/** Add workspace/API-key attribution to historical completions. */
export const completionsToWorkspaces = migrations.define({
  table: "chat_completions",
  batchSize: 25,
  migrateOne: async (ctx, completion) => {
    if (completion.bill.workspace) return;
    if (!completion.bill.balance) return;

    const workspace = await workspaceForBalance(ctx, completion.bill.balance);
    if (!workspace) return;

    const apiKey = completion.bill.key
      ? await ctx.db
          .query("api_keys")
          .withIndex("by_legacyKey", (q) => q.eq("legacyKey", completion.bill.key!))
          .first()
      : null;
    return {
      bill: {
        ...completion.bill,
        workspace: workspace._id,
        ...(apiKey ? { apiKey: apiKey._id } : {}),
      },
    };
  },
});

/** Add workspace/API-key attribution to historical traces. */
export const tracesToWorkspaces = migrations.define({
  table: "telemetry_traces",
  batchSize: 25,
  migrateOne: async (ctx, trace) => {
    if (trace.workspace) return;
    if (!trace.balance) return;

    const workspace = await workspaceForBalance(ctx, trace.balance);
    if (!workspace) return;
    const apiKey = trace.key
      ? await ctx.db
          .query("api_keys")
          .withIndex("by_legacyKey", (q) => q.eq("legacyKey", trace.key!))
          .first()
      : null;
    return {
      workspace: workspace._id,
      ...(apiKey ? { apiKey: apiKey._id } : {}),
    };
  },
});

/** Keep spans queryable by workspace after their parent trace is migrated. */
export const spansToWorkspaces = migrations.define({
  table: "telemetry_spans",
  batchSize: 25,
  migrateOne: async (ctx, span) => {
    if (span.workspace) return;
    const trace = await ctx.db.get("telemetry_traces", span.trace);
    if (!trace?.workspace) return;
    return { workspace: trace.workspace };
  },
});

/** Run all ownership migrations in dependency order. */
export const runAll = migrations.runner([
  internal.migrations.workspacesFromBalances,
  internal.migrations.workspacesFromSettings,
  internal.migrations.workspaceConfigurations,
  internal.migrations.workspaceCredentials,
  internal.migrations.apiKeysFromKeys,
  internal.migrations.mcpServersToWorkspaces,
  internal.migrations.chatroomSettingsToWorkspaces,
  internal.migrations.chatsToWorkspaces,
  internal.migrations.completionsToWorkspaces,
  internal.migrations.tracesToWorkspaces,
  internal.migrations.spansToWorkspaces,
]);
