import { Migrations } from "@convex-dev/migrations";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import schema from "./schema";
import { credentialPreview } from "../src/credential_preview";
import { getDefaultWorkspaceForUser } from "./workspaces";
import {
  chatWorkspaceBackfillPatch,
  isLegacyChatOwnershipConsistent,
  migratedRevocationPatch,
  OWNERSHIP_MIGRATION_REMEDIATION,
  secretFailureNeedsRepair,
} from "../src/workspaces/migration";
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
  type SecretNamespace,
} from "./secrets";
import { providerSnapshotFromCatalog } from "../src/workspaces/provider";

export const migrations = new Migrations(components.migrations, { schema });

const DEFAULT_WORKSPACE_NAME = "Personal workspace";

function migrationBlocked(reason: string): Error {
  return new Error(`Ownership migration blocked: ${reason}. ${OWNERSHIP_MIGRATION_REMEDIATION}`);
}

function assertWorkspaceOwner(workspace: Doc<"workspaces">, ownerId?: string): void {
  if (workspace.ownerType !== "user" || (ownerId !== undefined && workspace.ownerId !== ownerId)) {
    throw migrationBlocked("a workspace ownership mapping is invalid");
  }
}

async function workspaceUserCanAccess(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  userId: string,
): Promise<boolean> {
  if (workspace.ownerId === userId) return true;
  const member = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace_and_userId", (q) =>
      q.eq("workspace", workspace._id).eq("userId", userId),
    )
    .first();
  return member !== null;
}

async function balanceWorkspaceCandidates(ctx: QueryCtx | MutationCtx, balanceId: Id<"balances">) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", balanceId))
    .take(2);
}

async function workspaceForBalance(ctx: MutationCtx, balanceId: Id<"balances">) {
  const balance = await ctx.db.get("balances", balanceId);
  if (!balance) throw migrationBlocked("a legacy balance reference is missing");

  const mappings = await balanceWorkspaceCandidates(ctx, balanceId);
  if (mappings.length > 1) {
    throw migrationBlocked("a legacy balance has multiple workspace mappings");
  }

  const workspace = mappings[0];
  if (!workspace) return { balance, workspace: null };
  assertWorkspaceOwner(workspace, balance.userId);
  return { balance, workspace };
}

async function requiredWorkspaceForBalance(ctx: MutationCtx, balanceId: Id<"balances">) {
  const mapping = await workspaceForBalance(ctx, balanceId);
  if (!mapping.workspace) throw migrationBlocked("a legacy balance has no workspace mapping");
  return mapping;
}

async function workspaceForUser(ctx: MutationCtx, userId: string) {
  const existing = await getDefaultWorkspaceForUser(ctx, userId);
  if (existing) return existing;

  const workspaceId = await ctx.db.insert("workspaces", {
    ownerType: "user",
    ownerId: userId,
    name: DEFAULT_WORKSPACE_NAME,
  });
  const workspace = await ctx.db.get("workspaces", workspaceId);
  if (!workspace) throw migrationBlocked("a newly created default workspace is missing");
  return workspace;
}

async function workspaceDocumentForUser(ctx: MutationCtx, userId: string) {
  return await workspaceForUser(ctx, userId);
}

async function ensureProviderMigrationBudget(ctx: MutationCtx): Promise<void> {
  const metrics = await ctx.meta.getTransactionMetrics();
  if (
    metrics.bytesRead.remaining < 1 ||
    metrics.bytesWritten.remaining < 1 ||
    metrics.databaseQueries.remaining < 1 ||
    metrics.documentsRead.remaining < 1 ||
    metrics.documentsWritten.remaining < 1
  ) {
    throw migrationBlocked(
      "the provider catalogue does not fit in one workspace migration transaction; split provider work or reduce provider snapshot size before retrying",
    );
  }
}

/** Iterate the complete provider catalogue through its indexed paginator. */
async function forEachProvider(
  ctx: MutationCtx,
  callback: (provider: Doc<"providers">) => Promise<void>,
): Promise<void> {
  let previousSlug: string | undefined;
  for await (const provider of ctx.db.query("providers").withIndex("by_slug").order("asc")) {
    if (provider.slug === previousSlug) {
      throw migrationBlocked("the provider catalogue contains duplicate slugs");
    }
    previousSlug = provider.slug;
    await ensureProviderMigrationBudget(ctx);
    await callback(provider);
  }
}

async function forEachProviderRead(
  ctx: QueryCtx,
  callback: (provider: Doc<"providers">, duplicateSlug: boolean) => Promise<void>,
): Promise<void> {
  let previousSlug: string | undefined;
  for await (const provider of ctx.db.query("providers").withIndex("by_slug").order("asc")) {
    const duplicateSlug = provider.slug === previousSlug;
    previousSlug = provider.slug;
    await callback(provider, duplicateSlug);
  }
}

type SecretReadResult = Awaited<ReturnType<typeof secrets.get>>;

function readableSecret(result: SecretReadResult, description: string) {
  if (result.ok) return result;
  if (!secretFailureNeedsRepair(result.reason)) return null;
  throw migrationBlocked(`a ${description} secret is ${result.reason}`);
}

type SecretLookup = { namespace: SecretNamespace; name: string };

async function inspectSecret(
  ctx: QueryCtx | MutationCtx,
  args: SecretLookup,
): Promise<SecretReadResult> {
  try {
    return await secrets.get(ctx, args);
  } catch {
    return { ok: false, reason: "key_unavailable" };
  }
}

async function readSecretForMigration(ctx: MutationCtx, args: SecretLookup, description: string) {
  return readableSecret(await inspectSecret(ctx, args), description);
}

const verificationPageValidator = v.object({
  checked: v.number(),
  continueCursor: v.string(),
  isDone: v.boolean(),
  pageClean: v.boolean(),
  issues: v.record(v.string(), v.number()),
  samples: v.record(v.string(), v.array(v.string())),
});

type VerificationIssues = Record<string, number>;
type VerificationSamples = Record<string, string[]>;

function addVerificationIssue(
  issues: VerificationIssues,
  samples: VerificationSamples,
  code: string,
  sampleId?: string,
): void {
  issues[code] = (issues[code] ?? 0) + 1;
  if (sampleId === undefined) return;
  const sample = samples[code] ?? [];
  if (sample.length < 5 && !sample.includes(sampleId)) sample.push(sampleId);
  samples[code] = sample;
}

function verificationPage(
  result: { page: unknown[]; continueCursor: string; isDone: boolean },
  issues: VerificationIssues,
  samples: VerificationSamples,
) {
  return {
    checked: result.page.length,
    continueCursor: result.continueCursor,
    isDone: result.isDone,
    pageClean: Object.keys(issues).length === 0,
    issues,
    samples,
  };
}

async function defaultWorkspaceForUserRead(ctx: QueryCtx, userId: string) {
  return await getDefaultWorkspaceForUser(ctx, userId);
}

async function workspaceRequiresProviderConfiguration(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
): Promise<boolean> {
  if (workspace.legacyBalance !== undefined) return true;
  const [settings, servers] = await Promise.all([
    ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(1),
    ctx.db
      .query("mcp_servers")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(1),
  ]);
  return settings.length > 0 || servers.length > 0;
}

async function apiKeyCandidatesForRead(ctx: QueryCtx, legacyKey: Id<"keys">) {
  return await ctx.db
    .query("api_keys")
    .withIndex("by_legacyKey", (q) => q.eq("legacyKey", legacyKey))
    .take(2);
}

async function workspaceConfigurationCandidatesForRead(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  provider: string,
) {
  return await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .take(2);
}

async function workspaceCredentialCandidatesForRead(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  provider: string,
) {
  return await ctx.db
    .query("workspace_credentials")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .take(2);
}

async function existingWorkspaceCredential(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  provider: string,
) {
  const credentials = await ctx.db
    .query("workspace_credentials")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .take(2);
  if (credentials.length > 1) {
    throw migrationBlocked("a workspace has duplicate provider credential metadata");
  }
  return credentials[0];
}

async function existingWorkspaceConfiguration(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  provider: string,
) {
  const configurations = await ctx.db
    .query("workspace_configurations")
    .withIndex("by_workspace_and_provider", (q) =>
      q.eq("workspace", workspace).eq("provider", provider),
    )
    .take(2);
  if (configurations.length > 1) {
    throw migrationBlocked("a workspace has duplicate provider configuration rows");
  }
  return configurations[0];
}

async function existingApiKeyForLegacyKey(ctx: MutationCtx, legacyKey: Id<"keys">) {
  const apiKeys = await ctx.db
    .query("api_keys")
    .withIndex("by_legacyKey", (q) => q.eq("legacyKey", legacyKey))
    .take(2);
  if (apiKeys.length > 1) {
    throw migrationBlocked("a legacy API key has duplicate workspace mappings");
  }
  return apiKeys[0];
}

async function migrateProviderSecretsForBalance(
  ctx: MutationCtx,
  balance: Doc<"balances">,
  workspace: Doc<"workspaces">,
) {
  await forEachProvider(ctx, async (provider) => {
    const configuration = await existingWorkspaceConfiguration(ctx, workspace._id, provider.slug);
    if (!configuration) {
      throw migrationBlocked("a workspace provider configuration is missing");
    }
    const credential = await existingWorkspaceCredential(ctx, workspace._id, provider.slug);
    if (configuration?.deletedAt !== undefined) return;

    const oldNamespace = providerSecretNamespace(provider.slug);
    const oldSecret = await readSecretForMigration(
      ctx,
      {
        namespace: oldNamespace,
        name: balanceSecretName(balance._id),
      },
      "legacy provider credential",
    );
    const newNamespace = workspaceProviderSecretNamespace(workspace._id, provider.slug);
    const newSecret = await readSecretForMigration(
      ctx,
      {
        namespace: newNamespace,
        name: provider.slug,
      },
      "workspace provider credential",
    );
    if (!oldSecret) {
      if (!credential && newSecret) {
        throw migrationBlocked("a workspace provider secret has no credential metadata");
      }
      if (credential && !newSecret) {
        throw migrationBlocked("workspace credential metadata has no readable secret");
      }
      return;
    }
    if (!newSecret && credential) {
      throw migrationBlocked("workspace credential metadata has no readable secret");
    }
    if (!newSecret) {
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

    const preview =
      newSecret?.metadata?.preview ??
      oldSecret.metadata?.preview ??
      parseCredentialPreview(newSecret?.value ?? oldSecret.value, provider.env);
    if (!credential) {
      await ctx.db.insert("workspace_credentials", {
        workspace: workspace._id,
        provider: provider.slug,
        preview,
      });
    }
  });
}

async function migrateExaSecretForBalance(
  ctx: MutationCtx,
  balance: Doc<"balances">,
  workspace: Doc<"workspaces">,
) {
  const oldSecret = await readSecretForMigration(
    ctx,
    {
      namespace: exaSecretNamespace(balance._id),
      name: EXA_SECRET_NAME,
    },
    "legacy Exa credential",
  );

  const namespace = workspaceExaSecretNamespace(workspace._id);
  const newSecret = await readSecretForMigration(
    ctx,
    { namespace, name: EXA_SECRET_NAME },
    "workspace Exa credential",
  );
  if (!oldSecret) return;
  if (newSecret) return;

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
  if (server.auth.type !== "bearer") return;

  const oldSecret = await readSecretForMigration(
    ctx,
    {
      namespace: mcpSecretNamespace(server._id),
      name: MCP_SECRET_NAME,
    },
    "legacy MCP credential",
  );

  const namespace = workspaceMcpSecretNamespace(workspace._id, server._id);
  const newSecret = await readSecretForMigration(
    ctx,
    { namespace, name: MCP_SECRET_NAME },
    "workspace MCP credential",
  );
  if (!oldSecret) return;
  if (newSecret) return;

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

async function workspaceForChat(ctx: MutationCtx, chat: Doc<"aisdk_chats">) {
  const balance = chat.balance ? await ctx.db.get("balances", chat.balance) : null;
  if (chat.balance && !balance) {
    throw migrationBlocked("a chat references a missing legacy balance");
  }
  if (balance && balance.userId !== chat.userId) {
    throw migrationBlocked(
      "a legacy chat user does not own its legacy balance; do not migrate the chat",
    );
  }

  if (chat.workspace) {
    const workspace = await ctx.db.get("workspaces", chat.workspace);
    if (!workspace || workspace.ownerType !== "user") {
      throw migrationBlocked("a chat references an invalid workspace");
    }
    if (
      chat.balance &&
      !isLegacyChatOwnershipConsistent({
        chatUserId: chat.userId,
        workspaceOwnerId: workspace.ownerId,
        balanceId: chat.balance,
        workspaceLegacyBalance: workspace.legacyBalance,
      })
    ) {
      throw migrationBlocked("a chat workspace mapping is inconsistent; do not migrate the chat");
    }
    if (chat.balance) assertWorkspaceOwner(workspace, chat.userId);
    return workspace;
  }

  if (!balance) throw migrationBlocked("a chat has no legacy balance or workspace mapping");
  const mapping = await requiredWorkspaceForBalance(ctx, balance._id);
  return mapping.workspace;
}

async function apiKeyForLegacyKey(
  ctx: MutationCtx,
  key: Doc<"keys">,
  workspace: Doc<"workspaces">,
) {
  const apiKey = await existingApiKeyForLegacyKey(ctx, key._id);
  if (!apiKey) throw migrationBlocked("a legacy API key has no workspace mapping");
  if (apiKey.workspace !== workspace._id || apiKey.hash !== key.hash) {
    throw migrationBlocked("a workspace API key does not match its legacy key owner");
  }
  return apiKey;
}

async function completionOwnership(ctx: MutationCtx, completion: Doc<"chat_completions">) {
  let balance = completion.bill.balance
    ? await ctx.db.get("balances", completion.bill.balance)
    : undefined;
  if (completion.bill.balance && !balance) {
    throw migrationBlocked("a completion references a missing legacy balance");
  }

  let legacyKey = completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : undefined;
  if (completion.bill.key && !legacyKey) {
    throw migrationBlocked("a completion references a missing legacy API key");
  }

  let apiKey = completion.bill.apiKey
    ? await ctx.db.get("api_keys", completion.bill.apiKey)
    : undefined;
  if (completion.bill.apiKey && !apiKey) {
    throw migrationBlocked("a completion references a missing workspace API key");
  }

  if (!legacyKey && apiKey?.legacyKey) {
    legacyKey = await ctx.db.get("keys", apiKey.legacyKey);
    if (!legacyKey) throw migrationBlocked("a workspace API key references a missing legacy key");
  }
  if (legacyKey) {
    if (balance && legacyKey.balance !== balance._id) {
      throw migrationBlocked("a completion legacy key does not belong to its legacy balance");
    }
    if (!balance) {
      balance = await ctx.db.get("balances", legacyKey.balance);
      if (!balance) throw migrationBlocked("a completion legacy key references a missing balance");
    }
  }

  let workspace = completion.bill.workspace
    ? await ctx.db.get("workspaces", completion.bill.workspace)
    : undefined;
  if (completion.bill.workspace && !workspace) {
    throw migrationBlocked("a completion references a missing workspace");
  }
  if (!workspace && apiKey) workspace = await ctx.db.get("workspaces", apiKey.workspace);
  if (!workspace && balance)
    workspace = (await requiredWorkspaceForBalance(ctx, balance._id)).workspace;
  if (!workspace) throw migrationBlocked("a completion has no workspace ownership mapping");

  assertWorkspaceOwner(workspace, balance?.userId);
  if (balance && workspace.legacyBalance !== balance._id) {
    throw migrationBlocked("a completion workspace does not match its legacy balance");
  }
  if (apiKey && apiKey.workspace !== workspace._id) {
    throw migrationBlocked("a completion workspace API key belongs to another workspace");
  }
  if (legacyKey) {
    const mappedApiKey = await apiKeyForLegacyKey(ctx, legacyKey, workspace);
    if (apiKey && apiKey._id !== mappedApiKey._id) {
      throw migrationBlocked("a completion API key does not match its legacy key");
    }
    apiKey = mappedApiKey;
  }

  if ((completion.chatId === undefined) !== (completion.userId === undefined)) {
    throw migrationBlocked("a completion chat attribution is incomplete");
  }
  if (completion.chatId) {
    const chat = await ctx.db.get("aisdk_chats", completion.chatId);
    if (!chat) throw migrationBlocked("a completion references a missing chat");
    if (chat.userId !== completion.userId) {
      throw migrationBlocked("a completion chat owner is inconsistent");
    }
    const chatWorkspace = await workspaceForChat(ctx, chat);
    if (chatWorkspace._id !== workspace._id) {
      throw migrationBlocked("a completion chat belongs to another workspace");
    }
  }

  return { balance, legacyKey, apiKey, workspace };
}

async function traceOwnership(ctx: MutationCtx, trace: Doc<"telemetry_traces">) {
  let balance = trace.balance ? await ctx.db.get("balances", trace.balance) : undefined;
  if (trace.balance && !balance) {
    throw migrationBlocked("a trace references a missing legacy balance");
  }

  let legacyKey = trace.key ? await ctx.db.get("keys", trace.key) : undefined;
  if (trace.key && !legacyKey)
    throw migrationBlocked("a trace references a missing legacy API key");

  let apiKey = trace.apiKey ? await ctx.db.get("api_keys", trace.apiKey) : undefined;
  if (trace.apiKey && !apiKey) {
    throw migrationBlocked("a trace references a missing workspace API key");
  }
  if (!legacyKey && apiKey?.legacyKey) {
    legacyKey = await ctx.db.get("keys", apiKey.legacyKey);
    if (!legacyKey) throw migrationBlocked("a workspace API key references a missing legacy key");
  }
  if (legacyKey) {
    if (balance && legacyKey.balance !== balance._id) {
      throw migrationBlocked("a trace legacy key does not belong to its legacy balance");
    }
    if (!balance) {
      balance = await ctx.db.get("balances", legacyKey.balance);
      if (!balance) throw migrationBlocked("a trace legacy key references a missing balance");
    }
  }

  let workspace = trace.workspace ? await ctx.db.get("workspaces", trace.workspace) : undefined;
  if (trace.workspace && !workspace)
    throw migrationBlocked("a trace references a missing workspace");
  if (!workspace && apiKey) workspace = await ctx.db.get("workspaces", apiKey.workspace);
  if (!workspace && balance)
    workspace = (await requiredWorkspaceForBalance(ctx, balance._id)).workspace;
  if (!workspace || workspace.ownerType !== "user") {
    throw migrationBlocked("a trace has no valid workspace ownership mapping");
  }

  if (!trace.workspace && !(await workspaceUserCanAccess(ctx, workspace, trace.userId))) {
    throw migrationBlocked("a trace user is not an authorized workspace member");
  }
  if (balance) {
    if (balance.userId !== trace.userId) {
      throw migrationBlocked("a trace user does not own its legacy balance");
    }
    if (workspace.legacyBalance !== balance._id) {
      throw migrationBlocked("a trace workspace does not match its legacy balance");
    }
  }
  if (apiKey && apiKey.workspace !== workspace._id) {
    throw migrationBlocked("a trace workspace API key belongs to another workspace");
  }
  if (legacyKey) {
    const mappedApiKey = await apiKeyForLegacyKey(ctx, legacyKey, workspace);
    if (apiKey && apiKey._id !== mappedApiKey._id) {
      throw migrationBlocked("a trace API key does not match its legacy key");
    }
    apiKey = mappedApiKey;
  }

  if (trace.chatId) {
    const chat = await ctx.db.get("aisdk_chats", trace.chatId);
    if (!chat) throw migrationBlocked("a trace references a missing chat");
    if (chat.userId !== trace.userId) throw migrationBlocked("a trace chat owner is inconsistent");
    const chatWorkspace = await workspaceForChat(ctx, chat);
    if (chatWorkspace._id !== workspace._id) {
      throw migrationBlocked("a trace chat belongs to another workspace");
    }
  }
  if (trace.chatCompletionId) {
    const completion = await ctx.db.get("chat_completions", trace.chatCompletionId);
    if (!completion) throw migrationBlocked("a trace references a missing completion");
    if (completion.bill.workspace !== workspace._id) {
      throw migrationBlocked("a trace completion belongs to another workspace");
    }
  }

  return { balance, legacyKey, apiKey, workspace };
}

/** Create one personal workspace for each legacy balance. */
export const workspacesFromBalances = migrations.define({
  table: "balances",
  batchSize: 1,
  migrateOne: async (ctx, balance) => {
    const mapping = await workspaceForBalance(ctx, balance._id);
    if (mapping.workspace) return;

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

/** Give users with settings but no balance a deterministic default workspace. */
export const workspacesFromSettings = migrations.define({
  table: "chatroom_settings",
  batchSize: 10,
  migrateOne: async (ctx, settings) => {
    await workspaceForUser(ctx, settings.userId);
  },
});

/** Associate MCP servers before provider configurations enumerate workspaces. */
export const mcpServersToWorkspaces = migrations.define({
  table: "mcp_servers",
  batchSize: 25,
  migrateOne: async (ctx, server) => {
    const workspace = server.workspace
      ? await ctx.db.get("workspaces", server.workspace)
      : await workspaceDocumentForUser(ctx, server.userId);
    if (!workspace) throw migrationBlocked("an MCP server has no workspace mapping");
    assertWorkspaceOwner(workspace, server.userId);
    await migrateMcpSecret(ctx, server, workspace);
    if (server.workspace) return;
    return { workspace: workspace._id };
  },
});

/** Copy the global provider catalogue's enabled state into each workspace. */
export const workspaceConfigurations = migrations.define({
  table: "workspaces",
  batchSize: 1,
  migrateOne: async (ctx, workspace) => {
    assertWorkspaceOwner(workspace);
    await forEachProvider(ctx, async (provider) => {
      const existing = await existingWorkspaceConfiguration(ctx, workspace._id, provider.slug);
      if (existing) {
        if (!existing.snapshot && existing.deletedAt === undefined) {
          await ctx.db.patch("workspace_configurations", existing._id, {
            snapshot: providerSnapshotFromCatalog(provider),
          });
        }
        return;
      }

      await ctx.db.insert("workspace_configurations", {
        workspace: workspace._id,
        provider: provider.slug,
        enabled: provider.enabled,
        active: provider.enabled,
        snapshot: providerSnapshotFromCatalog(provider),
      });
    });
  },
});

/** Copy encrypted provider and Exa secrets into workspace namespaces. */
export const workspaceCredentials = migrations.define({
  table: "balances",
  batchSize: 1,
  migrateOne: async (ctx, balance) => {
    const mapping = await requiredWorkspaceForBalance(ctx, balance._id);
    await migrateProviderSecretsForBalance(ctx, mapping.balance, mapping.workspace);
    await migrateExaSecretForBalance(ctx, mapping.balance, mapping.workspace);
  },
});

/** Copy legacy key hashes and propagate source revocations. */
export const apiKeysFromKeys = migrations.define({
  table: "keys",
  batchSize: 25,
  migrateOne: async (ctx, key) => {
    const workspace = (await requiredWorkspaceForBalance(ctx, key.balance)).workspace;
    const existing = await existingApiKeyForLegacyKey(ctx, key._id);
    if (existing) {
      if (existing.workspace !== workspace._id || existing.hash !== key.hash) {
        throw migrationBlocked("a workspace API key does not match its legacy key");
      }
      const revocationPatch = migratedRevocationPatch(key.revokedAt, existing.revokedAt);
      if (Object.keys(revocationPatch).length > 0) {
        await ctx.db.patch("api_keys", existing._id, revocationPatch);
      }
      if (key.revokedAt === undefined && existing.revokedAt !== undefined) {
        await ctx.db.patch("keys", key._id, { revokedAt: existing.revokedAt });
      }
      return;
    }

    const sameHash = await ctx.db
      .query("api_keys")
      .withIndex("by_hash", (q) => q.eq("hash", key.hash))
      .take(2);
    if (sameHash.length > 0) {
      throw migrationBlocked("an API key hash is already assigned to another workspace key");
    }

    await ctx.db.insert("api_keys", {
      workspace: workspace._id,
      name: key.name,
      hash: key.hash,
      preview: key.preview,
      legacyKey: key._id,
      ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
    });
  },
});

/** Copy per-user Chatroom defaults to the user's deterministic default workspace. */
export const chatroomSettingsToWorkspaces = migrations.define({
  table: "chatroom_settings",
  batchSize: 25,
  migrateOne: async (ctx, settings) => {
    const workspace = await workspaceDocumentForUser(ctx, settings.userId);
    for (const serverId of settings.mcpServers) {
      const server = await ctx.db.get("mcp_servers", serverId);
      if (!server || server.userId !== settings.userId || server.workspace !== workspace._id) {
        throw migrationBlocked("Chatroom settings reference an invalid MCP server ownership edge");
      }
    }

    const settingsRows = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(2);
    if (settingsRows.length > 1) {
      throw migrationBlocked("a workspace has duplicate settings rows");
    }
    if (settingsRows[0]) return;

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
    const workspace = await workspaceForChat(ctx, chat);
    return chatWorkspaceBackfillPatch(chat, workspace._id);
  },
});

/** Add workspace/API-key attribution to historical completions. */
export const completionsToWorkspaces = migrations.define({
  table: "chat_completions",
  batchSize: 25,
  migrateOne: async (ctx, completion) => {
    const ownership = await completionOwnership(ctx, completion);
    return {
      bill: {
        ...completion.bill,
        ...(completion.bill.balance || !ownership.balance
          ? {}
          : { balance: ownership.balance._id }),
        ...(completion.bill.workspace === ownership.workspace._id
          ? {}
          : { workspace: ownership.workspace._id }),
        ...(ownership.apiKey && completion.bill.apiKey !== ownership.apiKey._id
          ? { apiKey: ownership.apiKey._id }
          : {}),
      },
    };
  },
});

/** Add workspace/API-key attribution to historical traces. */
export const tracesToWorkspaces = migrations.define({
  table: "telemetry_traces",
  batchSize: 25,
  migrateOne: async (ctx, trace) => {
    const ownership = await traceOwnership(ctx, trace);
    return {
      ...(trace.balance || !ownership.balance ? {} : { balance: ownership.balance._id }),
      ...(trace.workspace === ownership.workspace._id
        ? {}
        : { workspace: ownership.workspace._id }),
      ...(ownership.apiKey && trace.apiKey !== ownership.apiKey._id
        ? { apiKey: ownership.apiKey._id }
        : {}),
    };
  },
});

/** Keep spans queryable by the validated parent trace workspace. */
export const spansToWorkspaces = migrations.define({
  table: "telemetry_spans",
  batchSize: 25,
  migrateOne: async (ctx, span) => {
    const trace = await ctx.db.get("telemetry_traces", span.trace);
    if (!trace) throw migrationBlocked("a span references a missing trace");
    if (!trace.workspace) throw migrationBlocked("a span parent trace has no workspace mapping");

    const workspace = await ctx.db.get("workspaces", trace.workspace);
    if (!workspace) throw migrationBlocked("a span parent trace references a missing workspace");
    if (trace.balance) {
      const balance = await ctx.db.get("balances", trace.balance);
      if (
        !balance ||
        balance.userId !== trace.userId ||
        workspace.legacyBalance !== trace.balance
      ) {
        throw migrationBlocked("a legacy span trace does not match its balance owner");
      }
      assertWorkspaceOwner(workspace, balance.userId);
    } else if (workspace.ownerType !== "user") {
      throw migrationBlocked("an explicit workspace span trace references an invalid workspace");
    }
    if (span.workspace && span.workspace !== trace.workspace) {
      throw migrationBlocked("a span workspace does not match its parent trace");
    }
    if (span.balance) {
      if (!trace.balance || span.balance !== trace.balance) {
        throw migrationBlocked("a span legacy balance does not match its parent trace");
      }
      const balance = await ctx.db.get("balances", span.balance);
      if (!balance || balance.userId !== trace.userId) {
        throw migrationBlocked("a span legacy balance owner is invalid");
      }
      const mapping = await requiredWorkspaceForBalance(ctx, span.balance);
      if (mapping.workspace._id !== trace.workspace) {
        throw migrationBlocked("a span legacy balance maps to another workspace");
      }
    }
    if (span.workspace) return;
    return { workspace: trace.workspace };
  },
});

/** Run all ownership migrations in dependency order. */
export const runAll = migrations.runner([
  internal.migrations.workspacesFromBalances,
  internal.migrations.workspacesFromSettings,
  internal.migrations.mcpServersToWorkspaces,
  internal.migrations.workspaceConfigurations,
  internal.migrations.workspaceCredentials,
  internal.migrations.apiKeysFromKeys,
  internal.migrations.chatroomSettingsToWorkspaces,
  internal.migrations.chatsToWorkspaces,
  internal.migrations.completionsToWorkspaces,
  internal.migrations.tracesToWorkspaces,
  internal.migrations.spansToWorkspaces,
]);

async function verifiedWorkspaceForBalance(
  ctx: QueryCtx,
  balance: Doc<"balances">,
  issues: VerificationIssues,
  samples: VerificationSamples,
) {
  const mappings = await balanceWorkspaceCandidates(ctx, balance._id);
  if (mappings.length === 0) {
    addVerificationIssue(issues, samples, "balance_workspace_missing", balance._id);
    return null;
  }
  if (mappings.length > 1) {
    addVerificationIssue(issues, samples, "balance_workspace_duplicate", balance._id);
    return null;
  }

  const workspace = mappings[0]!;
  if (workspace.ownerType !== "user" || workspace.ownerId !== balance.userId) {
    addVerificationIssue(issues, samples, "balance_workspace_owner_mismatch", balance._id);
    return null;
  }
  if (workspace.archivedAt !== undefined) {
    addVerificationIssue(issues, samples, "balance_workspace_archived", balance._id);
  }
  return workspace;
}

async function verifiedApiKeyForLegacyKey(
  ctx: QueryCtx,
  key: Doc<"keys">,
  workspace: Doc<"workspaces">,
  issues: VerificationIssues,
  samples: VerificationSamples,
  prefix: "completion" | "trace" | "key" = "key",
) {
  const apiKeys = await apiKeyCandidatesForRead(ctx, key._id);
  if (apiKeys.length === 0) {
    addVerificationIssue(issues, samples, `${prefix}_api_key_missing`, key._id);
    return null;
  }
  if (apiKeys.length > 1) {
    addVerificationIssue(issues, samples, "legacy_key_target_duplicate", key._id);
    return null;
  }

  const apiKey = apiKeys[0]!;
  if (apiKey.workspace !== workspace._id || apiKey.hash !== key.hash) {
    addVerificationIssue(issues, samples, "legacy_key_target_owner_mismatch", key._id);
    return null;
  }
  if (key.revokedAt !== undefined && apiKey.revokedAt === undefined) {
    addVerificationIssue(issues, samples, "legacy_key_revocation_missing", key._id);
  }
  if (key.revokedAt === undefined && apiKey.revokedAt !== undefined) {
    addVerificationIssue(issues, samples, "legacy_key_revocation_not_propagated", key._id);
  }
  return apiKey;
}

function recordVerificationSecretFailure(
  issues: VerificationIssues,
  samples: VerificationSamples,
  code: string,
  result: SecretReadResult,
  sampleId: string,
): void {
  if (result.ok) return;
  addVerificationIssue(
    issues,
    samples,
    result.reason === "not_found" ? code : `${code}_${result.reason}`,
    sampleId,
  );
}

export const verifyBalances = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("balances").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const balance of result.page) {
      await verifiedWorkspaceForBalance(ctx, balance, issues, samples);
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyWorkspaces = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("workspaces").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const workspace of result.page) {
      if (workspace.ownerType !== "user" || !workspace.ownerId) {
        addVerificationIssue(issues, samples, "workspace_owner_invalid", workspace._id);
      }
      if (!workspace.legacyBalance) continue;

      const balance = await ctx.db.get("balances", workspace.legacyBalance);
      if (!balance) {
        addVerificationIssue(issues, samples, "workspace_balance_missing", workspace._id);
        continue;
      }
      if (balance.userId !== workspace.ownerId) {
        addVerificationIssue(issues, samples, "workspace_balance_owner_mismatch", workspace._id);
      }
      const mappings = await balanceWorkspaceCandidates(ctx, balance._id);
      if (mappings.length > 1) {
        addVerificationIssue(issues, samples, "workspace_balance_duplicate", workspace._id);
      } else if (mappings[0]?._id !== workspace._id) {
        addVerificationIssue(issues, samples, "workspace_balance_mapping_mismatch", workspace._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyWorkspaceConfigurations = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("workspace_configurations").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const configuration of result.page) {
      const workspace = await ctx.db.get("workspaces", configuration.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "configuration_workspace_missing", configuration._id);
      }
      if (configuration.snapshot && configuration.snapshot.slug !== configuration.provider) {
        addVerificationIssue(issues, samples, "configuration_snapshot_mismatch", configuration._id);
      }
      const duplicates = await workspaceConfigurationCandidatesForRead(
        ctx,
        configuration.workspace,
        configuration.provider,
      );
      if (duplicates.length > 1) {
        addVerificationIssue(issues, samples, "configuration_duplicate", configuration._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyWorkspaceCredentials = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("workspace_credentials").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const credential of result.page) {
      const workspace = await ctx.db.get("workspaces", credential.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "credential_workspace_missing", credential._id);
        continue;
      }
      const configurations = await workspaceConfigurationCandidatesForRead(
        ctx,
        credential.workspace,
        credential.provider,
      );
      const credentialMetadata = await workspaceCredentialCandidatesForRead(
        ctx,
        credential.workspace,
        credential.provider,
      );
      if (credentialMetadata.length > 1) {
        addVerificationIssue(issues, samples, "credential_metadata_duplicate", credential._id);
      }
      if (configurations.length === 0) {
        addVerificationIssue(issues, samples, "credential_configuration_missing", credential._id);
      } else if (configurations.length > 1) {
        addVerificationIssue(issues, samples, "credential_configuration_duplicate", credential._id);
      } else if (configurations[0]!.deletedAt !== undefined) {
        addVerificationIssue(issues, samples, "credential_configuration_deleted", credential._id);
      }
      const secret = await inspectSecret(ctx, {
        namespace: workspaceProviderSecretNamespace(credential.workspace, credential.provider),
        name: credential.provider,
      });
      recordVerificationSecretFailure(
        issues,
        samples,
        "workspace_credential_secret_missing",
        secret,
        credential._id,
      );
    }
    return verificationPage(result, issues, samples);
  },
});

/** Verify that every provider catalogue row has one workspace configuration row. */
export const verifyProviderConfigurations = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("workspaces").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const workspace of result.page) {
      const requiresConfiguration = await workspaceRequiresProviderConfiguration(ctx, workspace);
      await forEachProviderRead(ctx, async (provider, duplicateSlug) => {
        if (duplicateSlug) {
          addVerificationIssue(issues, samples, "provider_catalog_duplicate", workspace._id);
        }
        const configurations = await workspaceConfigurationCandidatesForRead(
          ctx,
          workspace._id,
          provider.slug,
        );
        if (configurations.length === 0) {
          if (requiresConfiguration) {
            addVerificationIssue(issues, samples, "configuration_missing", workspace._id);
          }
          return;
        }
        if (configurations.length > 1) {
          addVerificationIssue(issues, samples, "configuration_duplicate", workspace._id);
          return;
        }
        const configuration = configurations[0]!;
        if (!configuration.snapshot && configuration.deletedAt === undefined) {
          addVerificationIssue(issues, samples, "configuration_snapshot_missing", workspace._id);
        } else if (
          configuration.snapshot?.slug !== undefined &&
          configuration.snapshot.slug !== provider.slug
        ) {
          addVerificationIssue(issues, samples, "configuration_snapshot_mismatch", workspace._id);
        }
      });
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyKeys = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("keys").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const key of result.page) {
      const balance = await ctx.db.get("balances", key.balance);
      if (!balance) {
        addVerificationIssue(issues, samples, "key_balance_missing", key._id);
        continue;
      }
      const workspace = await verifiedWorkspaceForBalance(ctx, balance, issues, samples);
      if (!workspace) continue;
      await verifiedApiKeyForLegacyKey(ctx, key, workspace, issues, samples);

      const sameHash = await ctx.db
        .query("api_keys")
        .withIndex("by_hash", (q) => q.eq("hash", key.hash))
        .take(2);
      if (sameHash.length > 1) {
        addVerificationIssue(issues, samples, "api_key_hash_duplicate", key._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyApiKeys = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("api_keys").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const apiKey of result.page) {
      const workspace = await ctx.db.get("workspaces", apiKey.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "api_key_workspace_missing", apiKey._id);
        continue;
      }
      if (workspace.ownerType !== "user") {
        addVerificationIssue(issues, samples, "api_key_workspace_owner_invalid", apiKey._id);
      }
      const sameHash = await ctx.db
        .query("api_keys")
        .withIndex("by_hash", (q) => q.eq("hash", apiKey.hash))
        .take(2);
      if (sameHash.length > 1) {
        addVerificationIssue(issues, samples, "api_key_hash_duplicate", apiKey._id);
      }
      if (!apiKey.legacyKey) continue;

      const key = await ctx.db.get("keys", apiKey.legacyKey);
      if (!key) {
        addVerificationIssue(issues, samples, "api_key_legacy_key_missing", apiKey._id);
        continue;
      }
      if (key.hash !== apiKey.hash) {
        addVerificationIssue(issues, samples, "api_key_legacy_hash_mismatch", apiKey._id);
      }
      const balance = await ctx.db.get("balances", key.balance);
      if (!balance) {
        addVerificationIssue(issues, samples, "api_key_legacy_balance_missing", apiKey._id);
      } else {
        const mapping = await verifiedWorkspaceForBalance(ctx, balance, issues, samples);
        if (mapping && mapping._id !== workspace._id) {
          addVerificationIssue(issues, samples, "api_key_legacy_workspace_mismatch", apiKey._id);
        }
      }
      if (key.revokedAt !== undefined && apiKey.revokedAt === undefined) {
        addVerificationIssue(issues, samples, "api_key_revocation_missing", apiKey._id);
      }
      if (key.revokedAt === undefined && apiKey.revokedAt !== undefined) {
        addVerificationIssue(issues, samples, "api_key_revocation_not_propagated", apiKey._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyWorkspaceSettings = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("workspace_settings").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const settings of result.page) {
      const workspace = await ctx.db.get("workspaces", settings.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "workspace_settings_workspace_missing", settings._id);
        continue;
      }
      const duplicates = await ctx.db
        .query("workspace_settings")
        .withIndex("by_workspace", (q) => q.eq("workspace", settings.workspace))
        .take(2);
      if (duplicates.length > 1) {
        addVerificationIssue(issues, samples, "workspace_settings_duplicate", settings._id);
      }
      for (const serverId of settings.mcpServers) {
        const server = await ctx.db.get("mcp_servers", serverId);
        if (!server) {
          addVerificationIssue(issues, samples, "workspace_settings_mcp_missing", settings._id);
        } else if (server.userId !== workspace.ownerId || server.workspace !== workspace._id) {
          addVerificationIssue(
            issues,
            samples,
            "workspace_settings_mcp_owner_mismatch",
            settings._id,
          );
        }
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyProviderSecrets = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    provider: v.optional(v.string()),
  },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("balances").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};

    for (const balance of result.page) {
      const workspace = await verifiedWorkspaceForBalance(ctx, balance, issues, samples);
      if (!workspace) continue;

      const checkProvider = async (provider: Doc<"providers">, duplicateSlug = false) => {
        if (duplicateSlug) {
          addVerificationIssue(issues, samples, "provider_catalog_duplicate", balance._id);
        }
        const configurations = await workspaceConfigurationCandidatesForRead(
          ctx,
          workspace._id,
          provider.slug,
        );
        if (configurations.length > 1) {
          addVerificationIssue(issues, samples, "configuration_duplicate", balance._id);
          return;
        }
        if (configurations[0]?.deletedAt !== undefined) return;

        const credentials = await workspaceCredentialCandidatesForRead(
          ctx,
          workspace._id,
          provider.slug,
        );
        if (credentials.length > 1) {
          addVerificationIssue(issues, samples, "credential_metadata_duplicate", balance._id);
        }

        const legacy = await inspectSecret(ctx, {
          namespace: providerSecretNamespace(provider.slug),
          name: balanceSecretName(balance._id),
        });
        if (!legacy.ok && legacy.reason !== "not_found") {
          recordVerificationSecretFailure(
            issues,
            samples,
            "legacy_provider_secret_unavailable",
            legacy,
            balance._id,
          );
        }
        if (!legacy.ok && legacy.reason === "not_found" && credentials.length === 0) {
          const currentWithoutLegacy = await inspectSecret(ctx, {
            namespace: workspaceProviderSecretNamespace(workspace._id, provider.slug),
            name: provider.slug,
          });
          if (currentWithoutLegacy.ok) {
            addVerificationIssue(issues, samples, "credential_metadata_missing", balance._id);
          } else if (currentWithoutLegacy.reason !== "not_found") {
            recordVerificationSecretFailure(
              issues,
              samples,
              "workspace_provider_secret_unexpected",
              currentWithoutLegacy,
              balance._id,
            );
          }
          return;
        }

        const current = await inspectSecret(ctx, {
          namespace: workspaceProviderSecretNamespace(workspace._id, provider.slug),
          name: provider.slug,
        });
        recordVerificationSecretFailure(
          issues,
          samples,
          legacy.ok || credentials.length > 0
            ? "workspace_provider_secret_missing"
            : "workspace_provider_secret_unexpected",
          current,
          balance._id,
        );
        if (legacy.ok && !current.ok) return;
        if (legacy.ok && credentials.length === 0) {
          addVerificationIssue(issues, samples, "credential_metadata_missing", balance._id);
        }
      };

      if (args.provider) {
        const providers = await ctx.db
          .query("providers")
          .withIndex("by_slug", (q) => q.eq("slug", args.provider!))
          .take(2);
        if (providers.length === 0) {
          addVerificationIssue(issues, samples, "provider_missing", balance._id);
        } else {
          await checkProvider(providers[0]!, providers.length > 1);
        }
      } else {
        await forEachProviderRead(ctx, checkProvider);
      }

      const legacyExa = await inspectSecret(ctx, {
        namespace: exaSecretNamespace(balance._id),
        name: EXA_SECRET_NAME,
      });
      if (!legacyExa.ok && legacyExa.reason !== "not_found") {
        recordVerificationSecretFailure(
          issues,
          samples,
          "legacy_exa_secret_unavailable",
          legacyExa,
          balance._id,
        );
      }
      const currentExa = await inspectSecret(ctx, {
        namespace: workspaceExaSecretNamespace(workspace._id),
        name: EXA_SECRET_NAME,
      });
      if (legacyExa.ok) {
        recordVerificationSecretFailure(
          issues,
          samples,
          "workspace_exa_secret_missing",
          currentExa,
          balance._id,
        );
      } else if (!currentExa.ok && currentExa.reason !== "not_found") {
        recordVerificationSecretFailure(
          issues,
          samples,
          "workspace_exa_secret_unexpected",
          currentExa,
          balance._id,
        );
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyMcpServers = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("mcp_servers").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const server of result.page) {
      if (!server.workspace) {
        addVerificationIssue(issues, samples, "mcp_workspace_missing", server._id);
        continue;
      }
      const workspace = await ctx.db.get("workspaces", server.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "mcp_workspace_missing", server._id);
        continue;
      }
      if (workspace.ownerType !== "user" || workspace.ownerId !== server.userId) {
        addVerificationIssue(issues, samples, "mcp_workspace_owner_mismatch", server._id);
        continue;
      }

      if (server.auth.type !== "bearer") continue;
      const current = await inspectSecret(ctx, {
        namespace: workspaceMcpSecretNamespace(workspace._id, server._id),
        name: MCP_SECRET_NAME,
      });
      if (current.ok) continue;
      if (current.reason !== "not_found") {
        recordVerificationSecretFailure(
          issues,
          samples,
          "workspace_mcp_secret_missing",
          current,
          server._id,
        );
        continue;
      }

      const legacy = await inspectSecret(ctx, {
        namespace: mcpSecretNamespace(server._id),
        name: MCP_SECRET_NAME,
      });
      if (legacy.ok) {
        addVerificationIssue(issues, samples, "workspace_mcp_secret_missing", server._id);
      } else {
        recordVerificationSecretFailure(
          issues,
          samples,
          "legacy_mcp_secret_missing",
          legacy,
          server._id,
        );
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyChatroomSettings = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("chatroom_settings").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const settings of result.page) {
      const workspace = await defaultWorkspaceForUserRead(ctx, settings.userId);
      if (!workspace) {
        addVerificationIssue(issues, samples, "settings_workspace_missing", settings._id);
        continue;
      }
      const targetRows = await ctx.db
        .query("workspace_settings")
        .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
        .take(2);
      if (targetRows.length === 0) {
        addVerificationIssue(issues, samples, "workspace_settings_missing", settings._id);
      } else if (targetRows.length > 1) {
        addVerificationIssue(issues, samples, "workspace_settings_duplicate", settings._id);
      }

      for (const serverId of settings.mcpServers) {
        const server = await ctx.db.get("mcp_servers", serverId);
        if (!server) {
          addVerificationIssue(issues, samples, "settings_mcp_missing", settings._id);
        } else if (server.userId !== settings.userId || server.workspace !== workspace._id) {
          addVerificationIssue(issues, samples, "settings_mcp_owner_mismatch", settings._id);
        }
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyChats = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("aisdk_chats").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const chat of result.page) {
      if (!chat.workspace) {
        addVerificationIssue(issues, samples, "chat_workspace_missing", chat._id);
        continue;
      }
      const workspace = await ctx.db.get("workspaces", chat.workspace);
      if (!workspace) {
        addVerificationIssue(issues, samples, "chat_workspace_missing", chat._id);
        continue;
      }
      if (workspace.ownerType !== "user") {
        addVerificationIssue(issues, samples, "chat_workspace_owner_mismatch", chat._id);
      }
      if (workspace.archivedAt !== undefined) {
        addVerificationIssue(issues, samples, "chat_workspace_archived", chat._id);
      }
      if (!chat.scope) addVerificationIssue(issues, samples, "chat_scope_missing", chat._id);
      if (!chat.balance) continue;

      const balance = await ctx.db.get("balances", chat.balance);
      if (!balance) {
        addVerificationIssue(issues, samples, "chat_balance_missing", chat._id);
        continue;
      }
      if (
        !isLegacyChatOwnershipConsistent({
          chatUserId: chat.userId,
          balanceOwnerId: balance.userId,
          workspaceOwnerId: workspace.ownerId,
          balanceId: chat.balance,
          workspaceLegacyBalance: workspace.legacyBalance,
        })
      ) {
        addVerificationIssue(issues, samples, "chat_ownership_inconsistent", chat._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyCompletions = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("chat_completions").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const completion of result.page) {
      if (!completion.bill.workspace) {
        addVerificationIssue(issues, samples, "completion_workspace_missing", completion._id);
      }
      const balance = completion.bill.balance
        ? await ctx.db.get("balances", completion.bill.balance)
        : undefined;
      if (completion.bill.balance && !balance) {
        addVerificationIssue(issues, samples, "completion_balance_missing", completion._id);
      }
      const key = completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : undefined;
      if (completion.bill.key && !key) {
        addVerificationIssue(issues, samples, "completion_legacy_key_missing", completion._id);
      }
      if (key && !balance) {
        addVerificationIssue(issues, samples, "completion_balance_missing", completion._id);
      }
      if (key && balance && key.balance !== balance._id) {
        addVerificationIssue(issues, samples, "completion_key_balance_mismatch", completion._id);
      }

      const apiKey = completion.bill.apiKey
        ? await ctx.db.get("api_keys", completion.bill.apiKey)
        : undefined;
      if (completion.bill.apiKey && !apiKey) {
        addVerificationIssue(issues, samples, "completion_api_key_missing", completion._id);
      }

      const workspace = completion.bill.workspace
        ? await ctx.db.get("workspaces", completion.bill.workspace)
        : balance
          ? ((await verifiedWorkspaceForBalance(ctx, balance, issues, samples)) ?? undefined)
          : apiKey
            ? await ctx.db.get("workspaces", apiKey.workspace)
            : undefined;
      if (!workspace) {
        addVerificationIssue(issues, samples, "completion_workspace_missing", completion._id);
        continue;
      }
      if (workspace.ownerType !== "user" || workspace.archivedAt !== undefined) {
        addVerificationIssue(issues, samples, "completion_workspace_invalid", completion._id);
      }
      if (balance && workspace.legacyBalance !== balance._id) {
        addVerificationIssue(
          issues,
          samples,
          "completion_workspace_balance_mismatch",
          completion._id,
        );
      }
      if (balance && workspace.ownerId !== balance.userId) {
        addVerificationIssue(
          issues,
          samples,
          "completion_workspace_owner_mismatch",
          completion._id,
        );
      }
      if (apiKey && apiKey.workspace !== workspace._id) {
        addVerificationIssue(
          issues,
          samples,
          "completion_api_key_workspace_mismatch",
          completion._id,
        );
      }
      if (key) {
        const mappedApiKey = await verifiedApiKeyForLegacyKey(
          ctx,
          key,
          workspace,
          issues,
          samples,
          "completion",
        );
        if (apiKey && mappedApiKey && apiKey._id !== mappedApiKey._id) {
          addVerificationIssue(issues, samples, "completion_api_key_mismatch", completion._id);
        }
        if (!completion.bill.apiKey) {
          addVerificationIssue(issues, samples, "completion_api_key_missing", completion._id);
        }
      }
      if ((completion.chatId === undefined) !== (completion.userId === undefined)) {
        addVerificationIssue(
          issues,
          samples,
          "completion_chat_attribution_incomplete",
          completion._id,
        );
      }
      if (completion.chatId) {
        const chat = await ctx.db.get("aisdk_chats", completion.chatId);
        if (!chat) {
          addVerificationIssue(issues, samples, "completion_chat_missing", completion._id);
        } else {
          if (chat.userId !== completion.userId) {
            addVerificationIssue(issues, samples, "completion_chat_owner_mismatch", completion._id);
          }
          if (chat.balance) {
            const chatBalance = await ctx.db.get("balances", chat.balance);
            if (
              !chatBalance ||
              chatBalance.userId !== chat.userId ||
              workspace.legacyBalance !== chat.balance
            ) {
              addVerificationIssue(
                issues,
                samples,
                "completion_chat_workspace_owner_mismatch",
                completion._id,
              );
            }
          }
          if (chat.workspace !== workspace._id) {
            addVerificationIssue(
              issues,
              samples,
              "completion_chat_workspace_mismatch",
              completion._id,
            );
          }
          if (balance && chat.balance && chat.balance !== balance._id) {
            addVerificationIssue(
              issues,
              samples,
              "completion_chat_balance_mismatch",
              completion._id,
            );
          }
        }
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyTraces = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("telemetry_traces").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const trace of result.page) {
      if (!trace.workspace) {
        addVerificationIssue(issues, samples, "trace_workspace_missing", trace._id);
      }
      const balance = trace.balance ? await ctx.db.get("balances", trace.balance) : undefined;
      if (trace.balance && !balance) {
        addVerificationIssue(issues, samples, "trace_balance_missing", trace._id);
      }
      if (balance && balance.userId !== trace.userId) {
        addVerificationIssue(issues, samples, "trace_balance_owner_mismatch", trace._id);
      }

      const key = trace.key ? await ctx.db.get("keys", trace.key) : undefined;
      if (trace.key && !key)
        addVerificationIssue(issues, samples, "trace_legacy_key_missing", trace._id);
      if (key && !balance)
        addVerificationIssue(issues, samples, "trace_balance_missing", trace._id);
      if (key && balance && key.balance !== balance._id) {
        addVerificationIssue(issues, samples, "trace_key_balance_mismatch", trace._id);
      }

      const apiKey = trace.apiKey ? await ctx.db.get("api_keys", trace.apiKey) : undefined;
      if (trace.apiKey && !apiKey)
        addVerificationIssue(issues, samples, "trace_api_key_missing", trace._id);

      const workspace = trace.workspace
        ? await ctx.db.get("workspaces", trace.workspace)
        : balance
          ? ((await verifiedWorkspaceForBalance(ctx, balance, issues, samples)) ?? undefined)
          : apiKey
            ? await ctx.db.get("workspaces", apiKey.workspace)
            : undefined;
      if (!workspace) {
        addVerificationIssue(issues, samples, "trace_workspace_missing", trace._id);
        continue;
      }
      if (
        workspace.ownerType !== "user" ||
        (balance
          ? workspace.ownerId !== trace.userId
          : !trace.workspace && !(await workspaceUserCanAccess(ctx, workspace, trace.userId)))
      ) {
        addVerificationIssue(issues, samples, "trace_workspace_owner_mismatch", trace._id);
      }
      if (workspace.archivedAt !== undefined) {
        addVerificationIssue(issues, samples, "trace_workspace_archived", trace._id);
      }
      if (balance && workspace.legacyBalance !== balance._id) {
        addVerificationIssue(issues, samples, "trace_workspace_balance_mismatch", trace._id);
      }
      if (apiKey && apiKey.workspace !== workspace._id) {
        addVerificationIssue(issues, samples, "trace_api_key_workspace_mismatch", trace._id);
      }
      if (key) {
        const mappedApiKey = await verifiedApiKeyForLegacyKey(
          ctx,
          key,
          workspace,
          issues,
          samples,
          "trace",
        );
        if (apiKey && mappedApiKey && apiKey._id !== mappedApiKey._id) {
          addVerificationIssue(issues, samples, "trace_api_key_mismatch", trace._id);
        }
        if (!trace.apiKey)
          addVerificationIssue(issues, samples, "trace_api_key_missing", trace._id);
      }

      if (trace.chatId) {
        const chat = await ctx.db.get("aisdk_chats", trace.chatId);
        if (!chat) {
          addVerificationIssue(issues, samples, "trace_chat_missing", trace._id);
        } else {
          if (chat.userId !== trace.userId) {
            addVerificationIssue(issues, samples, "trace_chat_owner_mismatch", trace._id);
          }
          if (chat.workspace && chat.workspace !== workspace._id) {
            addVerificationIssue(issues, samples, "trace_chat_workspace_mismatch", trace._id);
          }
          if (chat.balance) {
            const chatBalance = await ctx.db.get("balances", chat.balance);
            if (
              !chatBalance ||
              chatBalance.userId !== chat.userId ||
              workspace.legacyBalance !== chat.balance
            ) {
              addVerificationIssue(issues, samples, "trace_chat_workspace_mismatch", trace._id);
            }
          }
        }
      }
      if (trace.chatCompletionId) {
        const completion = await ctx.db.get("chat_completions", trace.chatCompletionId);
        if (!completion) {
          addVerificationIssue(issues, samples, "trace_completion_missing", trace._id);
        } else if (completion.bill.workspace !== workspace._id) {
          addVerificationIssue(issues, samples, "trace_completion_workspace_mismatch", trace._id);
        }
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifySpans = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("telemetry_spans").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const span of result.page) {
      const trace = await ctx.db.get("telemetry_traces", span.trace);
      if (!trace) {
        addVerificationIssue(issues, samples, "span_trace_missing", span._id);
        continue;
      }
      if (!trace.workspace) {
        addVerificationIssue(issues, samples, "span_trace_workspace_missing", span._id);
      } else if (!span.workspace) {
        addVerificationIssue(issues, samples, "span_workspace_missing", span._id);
      } else if (span.workspace !== trace.workspace) {
        addVerificationIssue(issues, samples, "span_workspace_mismatch", span._id);
      }
      if (span.balance && (!trace.balance || span.balance !== trace.balance)) {
        addVerificationIssue(issues, samples, "span_balance_mismatch", span._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});

export const verifyTelemetryPayloads = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: verificationPageValidator,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("telemetry_payloads").paginate(args.paginationOpts);
    const issues: VerificationIssues = {};
    const samples: VerificationSamples = {};
    for (const payload of result.page) {
      const trace = await ctx.db.get("telemetry_traces", payload.trace);
      if (!trace) {
        addVerificationIssue(issues, samples, "payload_trace_missing", payload._id);
        continue;
      }
      if (!trace.workspace) {
        addVerificationIssue(issues, samples, "payload_trace_workspace_missing", payload._id);
      }
      if (!payload.span) continue;
      const span = await ctx.db.get("telemetry_spans", payload.span);
      if (!span) {
        addVerificationIssue(issues, samples, "payload_span_missing", payload._id);
      } else if (span.trace !== payload.trace) {
        addVerificationIssue(issues, samples, "payload_span_trace_mismatch", payload._id);
      } else if (trace.workspace && span.workspace !== trace.workspace) {
        addVerificationIssue(issues, samples, "payload_span_workspace_mismatch", payload._id);
      }
    }
    return verificationPage(result, issues, samples);
  },
});
