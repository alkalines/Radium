import { and, asc, eq } from "drizzle-orm";
import { assertValidPlacement } from "contracts/routing/settings";
import type { ProviderSnapshot } from "contracts/workspaces/provider";
import { newId } from "../db/ids";
import type { Database } from "../drivers/types";
import { AppError, assertValid } from "../errors";
import type { Runtime } from "../runtime";
import { ensureCredentialLimits, recordLoginPlan } from "./limits/store";
import {
  providerCredentialRows,
  requireWorkspaceProvider,
  workspaceProviderRecord,
  workspaceProviderRecords,
} from "./providers";
import { clearCredentialCooldowns } from "./routing/state";
import { workspaceCredentials, workspaceProviders } from "./schema";
import {
  getSecret,
  putSecret,
  removeSecret,
  workspaceProviderSecretNamespace,
  type SecretKeyring,
} from "./secrets";
import { subscriptionAdapter } from "./subscriptions/registry";

/** One credential row of a workspace provider. */
export type CredentialRow = typeof workspaceCredentials.$inferSelect;

/** Upper bound on credentials per workspace provider; keeps routing reads and decrypts bounded. */
export const MAX_PROVIDER_CREDENTIALS = 50;

const MAX_LABEL_LENGTH = 64;

/**
 * Secret name of a credential inside its workspace provider namespace. Credentials created
 * before pools occupy the provider-slug name; pooled credentials are named after their row id.
 */
export function credentialSecretName(credential: Pick<CredentialRow, "provider" | "secretName">) {
  return credential.secretName ?? credential.provider;
}

/** Secret name of a credential's limit key (an OpenRouter management key), next to its values. */
export function limitKeySecretName(credential: string) {
  return `${credential}:limit-key`;
}

/** Display name: the owner label, else the first masked preview value. */
export function credentialDisplayName(credential: Pick<CredentialRow, "label" | "preview">) {
  return credential.label ?? Object.values(credential.preview)[0] ?? "Credential";
}

/** Masked preview of one value: never more than its last four characters. */
export function credentialPreview(value: string) {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

/** Masks every credential value for previews; raw values stay in the Secret Store. */
export function maskCredentialValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, credentialPreview(value)]),
  );
}

/** Trimmed owner label, or `null` to clear it. Refuses labels over 64 characters. */
export function normalizeCredentialLabel(label: string) {
  const trimmed = label.trim();
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new AppError(
      "BAD_REQUEST",
      `Credential labels must be at most ${MAX_LABEL_LENGTH} characters.`,
    );
  }
  return trimmed || null;
}

/** Refuses values unless every environment variable the provider declares is non-empty. */
export function assertRequiredCredentials(env: string[], values: Record<string, string>) {
  for (const required of env) {
    if (!values[required]) {
      throw new AppError("BAD_REQUEST", `Missing required credential value: ${required}`);
    }
  }
}

/** The string entries of a stored credential value set (a JSON object). Throws when malformed. */
export function parseCredentialValues(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored credential values are not an object.");
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * The credential's decrypted values, or `undefined` when its secret is missing, expired, under an
 * unconfigured key, or malformed. A secret that fails authentication throws: it needs recovery
 * rather than being skipped. Values stay inside the server.
 */
export async function readCredentialValues(
  db: Database,
  keyring: SecretKeyring,
  credential: Pick<CredentialRow, "workspace" | "provider" | "secretName">,
): Promise<Record<string, string> | undefined> {
  const stored = await getSecret(db, keyring, {
    namespace: workspaceProviderSecretNamespace(credential.workspace, credential.provider),
    name: credentialSecretName(credential),
  });
  if (!stored.ok) return undefined;
  try {
    return parseCredentialValues(stored.value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Owner services (`providers.*Credential*`). Authorization (owned workspace) is the procedure's.

/**
 * Every credential of the workspace's configured providers as masked previews, by provider
 * (configuration order), then creation. Values stay write-only.
 */
export async function listCredentials(db: Database, workspace: string) {
  const records = await workspaceProviderRecords(db, workspace);
  const rows = await db
    .select()
    .from(workspaceCredentials)
    .where(eq(workspaceCredentials.workspace, workspace))
    .orderBy(asc(workspaceCredentials.createdAt), asc(workspaceCredentials.id));
  return records.flatMap((record) =>
    rows
      .filter((row) => row.provider === record.provider.slug)
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        name: credentialDisplayName(row),
        label: row.label,
        preview: row.preview,
        enabled: row.enabled,
        priority: row.priority,
        weight: row.weight,
      })),
  );
}

/** Secret metadata stored beside a provider credential's values. */
function secretMetadata(credential: Pick<CredentialRow, "workspace" | "provider">, preview: Record<string, string>) {
  return { kind: "provider", provider: credential.provider, workspace: credential.workspace, preview };
}

/**
 * Inserts a pooled credential row and its secret (named after the row id) and creates its limit
 * snapshot, so a pollable credential is polled before its first use. The caller holds the
 * provider's configuration lock, which makes the pool cap exact under concurrent adds.
 */
async function insertCredential(
  tx: Database,
  keyring: SecretKeyring,
  workspace: string,
  provider: string,
  credential: {
    values: Record<string, string>;
    preview: Record<string, string>;
    label?: string | null;
    account?: string;
    priority?: number;
    weight?: number;
  },
) {
  const existing = await providerCredentialRows(tx, workspace, provider);
  if (existing.length >= MAX_PROVIDER_CREDENTIALS) {
    throw new AppError(
      "BAD_REQUEST",
      `A provider can hold at most ${MAX_PROVIDER_CREDENTIALS} credentials.`,
    );
  }
  const id = newId();
  const [row] = await tx
    .insert(workspaceCredentials)
    .values({
      id,
      workspace,
      provider,
      preview: credential.preview,
      label: credential.label ?? null,
      secretName: id,
      account: credential.account ?? null,
      priority: credential.priority ?? 0,
      weight: credential.weight ?? 1,
    })
    .returning();
  await putSecret(
    tx,
    keyring,
    { namespace: workspaceProviderSecretNamespace(workspace, provider), name: id },
    JSON.stringify(credential.values),
    secretMetadata(row!, credential.preview),
  );
  await ensureCredentialLimits(tx, row!);
  return row!;
}

/**
 * Adds an API-key credential (one value per provider environment variable) to a provider's
 * pool. Values go to the Secret Store; the row keeps masked previews. OAuth accounts are added
 * through their login flow instead.
 *
 * @returns the new credential id.
 */
export async function createCredential(
  runtime: Runtime,
  workspace: string,
  input: {
    provider: string;
    label?: string;
    priority?: number;
    weight?: number;
    credentials: Record<string, string>;
  },
) {
  return await runtime.drivers.db.transaction(async (tx) => {
    const { provider } = await requireWorkspaceProvider(tx, workspace, input.provider);
    if (provider.credential_type === "oauth") {
      throw new AppError("BAD_REQUEST", `Connect ${provider.name} accounts through its login flow.`);
    }
    assertRequiredCredentials(provider.env, input.credentials);
    const placement = { priority: input.priority ?? 0, weight: input.weight ?? 1 };
    assertValid(() => assertValidPlacement(placement));
    const row = await insertCredential(tx, runtime.secrets, workspace, input.provider, {
      values: input.credentials,
      preview: maskCredentialValues(input.credentials),
      label: input.label === undefined ? null : normalizeCredentialLabel(input.label),
      ...placement,
    });
    return row.id;
  });
}

/**
 * The workspace's credential `id` and its configured provider, both locked for the transaction.
 * Unknown, foreign and unconfigured-provider credentials are the same `NOT_FOUND`.
 */
async function requireCredential(tx: Database, workspace: string, id: string) {
  const [credential] = await tx
    .select()
    .from(workspaceCredentials)
    .where(and(eq(workspaceCredentials.id, id), eq(workspaceCredentials.workspace, workspace)));
  if (!credential) throw new AppError("NOT_FOUND", "Credential not found.");
  const record = await requireWorkspaceProvider(tx, workspace, credential.provider);
  // Re-read under the provider lock: a concurrent removal may have won it.
  const [locked] = await tx
    .select()
    .from(workspaceCredentials)
    .where(eq(workspaceCredentials.id, id))
    .for("update");
  if (!locked) throw new AppError("NOT_FOUND", "Credential not found.");
  return { provider: record.provider, credential: locked };
}

/**
 * Renames, enables or disables, re-ranks (priority and weight inside the provider), or replaces
 * the values of one credential. Omitted fields are unchanged; an empty label clears it. New
 * values need every provider environment variable and are refused for OAuth accounts.
 */
export async function updateCredential(
  runtime: Runtime,
  workspace: string,
  input: {
    credential: string;
    label?: string;
    enabled?: boolean;
    priority?: number;
    weight?: number;
    credentials?: Record<string, string>;
  },
) {
  await runtime.drivers.db.transaction(async (tx) => {
    const { provider, credential } = await requireCredential(tx, workspace, input.credential);
    const change: Partial<typeof workspaceCredentials.$inferInsert> = {};
    if (input.label !== undefined) change.label = normalizeCredentialLabel(input.label);
    if (input.enabled !== undefined) change.enabled = input.enabled;
    if (input.priority !== undefined || input.weight !== undefined) {
      const placement = {
        priority: input.priority ?? credential.priority,
        weight: input.weight ?? credential.weight,
      };
      assertValid(() => assertValidPlacement(placement));
      Object.assign(change, placement);
    }
    if (input.credentials !== undefined) {
      if (provider.credential_type === "oauth") {
        throw new AppError(
          "BAD_REQUEST",
          `Reconnect ${provider.name} accounts through its login flow.`,
        );
      }
      assertRequiredCredentials(provider.env, input.credentials);
      change.preview = maskCredentialValues(input.credentials);
      await putSecret(
        tx,
        runtime.secrets,
        {
          namespace: workspaceProviderSecretNamespace(workspace, credential.provider),
          name: credentialSecretName(credential),
        },
        JSON.stringify(input.credentials),
        secretMetadata(credential, change.preview),
      );
    }
    if (Object.keys(change).length > 0) {
      await tx
        .update(workspaceCredentials)
        .set(change)
        .where(eq(workspaceCredentials.id, credential.id));
    }
  });
}

/** Removes one credential of `provider`; an OAuth account's upstream session is ended too. */
export async function deleteCredential(
  runtime: Runtime,
  workspace: string,
  input: { provider: string; credential: string },
) {
  await runtime.drivers.db.transaction(async (tx) => {
    const { provider, credential } = await requireCredential(tx, workspace, input.credential);
    if (credential.provider !== input.provider) {
      throw new AppError("NOT_FOUND", "Credential not found.");
    }
    await removeCredential(tx, runtime, provider, credential);
  });
}

/**
 * Removes a credential with everything attached: its secret and limit key, its routing
 * cooldowns, its limit snapshot (cascade) and, for an OAuth provider with a registered flow,
 * its upstream session. Completions and limit events keep their history (`set null`).
 */
export async function removeCredential(
  tx: Database,
  runtime: Runtime,
  provider: Pick<ProviderSnapshot, "credential_type" | "oauth_flow">,
  credential: CredentialRow,
) {
  const adapter = subscriptionAdapter(provider);
  if (adapter) {
    const values = await readStoredValues(tx, runtime.secrets, credential);
    if (values) await adapter.endSession(tx, runtime.drivers.kv, values);
  }
  await removeCredentialRecord(tx, runtime, credential);
}

async function removeCredentialRecord(tx: Database, runtime: Runtime, credential: CredentialRow) {
  const namespace = workspaceProviderSecretNamespace(credential.workspace, credential.provider);
  await removeSecret(tx, { namespace, name: limitKeySecretName(credential.id) });
  await removeSecret(tx, { namespace, name: credentialSecretName(credential) });
  await tx.delete(workspaceCredentials).where(eq(workspaceCredentials.id, credential.id));
  await clearCredentialCooldowns(
    runtime.drivers.kv,
    credential.workspace,
    credential.provider,
    credential.id,
  );
}

/**
 * A credential's stored values for comparison or session teardown. Unreadable or malformed
 * secrets read as absent, so disconnecting never gets stuck on them.
 */
async function readStoredValues(db: Database, keyring: SecretKeyring, credential: CredentialRow) {
  try {
    return await readCredentialValues(db, keyring, credential);
  } catch {
    return undefined;
  }
}

/** The row whose stored values equal `values` exactly, if any. */
async function findCredentialByValues(
  db: Database,
  keyring: SecretKeyring,
  rows: CredentialRow[],
  values: Record<string, string>,
) {
  const names = Object.keys(values);
  for (const row of rows) {
    const stored = await readStoredValues(db, keyring, row);
    if (!stored || Object.keys(stored).length !== names.length) continue;
    if (names.every((name) => stored[name] === values[name])) return row;
  }
  return undefined;
}

/**
 * Binds an upstream OAuth/subscription session to an owned workspace after a login flow
 * completed (called by the flow's route, which checked ownership). Binding the same values again
 * only refreshes the preview; a new session for an already connected `account` replaces that
 * account's values and ends the replaced session; any other session adds a credential. The
 * provider's configuration lock and the unique `(workspace, provider, account)` keep concurrent
 * status polls from creating two credentials for one account.
 */
export async function bindOAuthCredential(
  runtime: Runtime,
  input: {
    workspace: string;
    provider: string;
    account?: string;
    credentials: Record<string, string>;
    preview: Record<string, string>;
    /** Upstream plan reported at login, shown until live limit data replaces it. */
    plan?: string;
  },
) {
  await runtime.drivers.db.transaction(async (tx) => {
    const record = await workspaceProviderRecord(tx, input.workspace, input.provider, {
      lock: true,
    });
    if (!record || record.provider.credential_type !== "oauth") {
      throw new AppError("NOT_FOUND", `OAuth provider ${input.provider} is not configured.`);
    }
    if (record.configuration.snapshot === null) {
      await tx
        .update(workspaceProviders)
        .set({ snapshot: record.provider })
        .where(eq(workspaceProviders.id, record.configuration.id));
    }

    const rows = await providerCredentialRows(tx, input.workspace, input.provider);
    const sessionOwner = await findCredentialByValues(tx, runtime.secrets, rows, input.credentials);
    if (sessionOwner) {
      await tx
        .update(workspaceCredentials)
        .set({ preview: input.preview, account: input.account ?? sessionOwner.account })
        .where(eq(workspaceCredentials.id, sessionOwner.id));
      if (input.plan) await recordLoginPlan(tx, sessionOwner.id, input.plan);
      return;
    }

    const sameAccount =
      input.account === undefined ? undefined : rows.find((row) => row.account === input.account);
    if (!sameAccount) {
      const created = await insertCredential(tx, runtime.secrets, input.workspace, input.provider, {
        values: input.credentials,
        preview: input.preview,
        account: input.account,
      });
      if (input.plan) await recordLoginPlan(tx, created.id, input.plan);
      return;
    }

    // Reconnecting an account: keep its row (label, routing state), end the replaced session.
    const previous = await readStoredValues(tx, runtime.secrets, sameAccount);
    await putSecret(
      tx,
      runtime.secrets,
      {
        namespace: workspaceProviderSecretNamespace(input.workspace, input.provider),
        name: credentialSecretName(sameAccount),
      },
      JSON.stringify(input.credentials),
      secretMetadata(sameAccount, input.preview),
    );
    await tx
      .update(workspaceCredentials)
      .set({ preview: input.preview })
      .where(eq(workspaceCredentials.id, sameAccount.id));
    if (input.plan) await recordLoginPlan(tx, sameAccount.id, input.plan);
    if (previous) await subscriptionAdapter(record.provider)?.endSession(tx, runtime.drivers.kv, previous);
  });
}

/**
 * Removes the credential holding exactly `credentials` after its upstream session logged out or
 * expired. Other accounts of the provider are untouched.
 */
export async function unbindOAuthCredential(
  runtime: Runtime,
  input: { workspace: string; provider: string; credentials: Record<string, string> },
) {
  await runtime.drivers.db.transaction(async (tx) => {
    const record = await workspaceProviderRecord(tx, input.workspace, input.provider, {
      lock: true,
    });
    if (!record) return;
    const rows = await providerCredentialRows(tx, input.workspace, input.provider);
    const credential = await findCredentialByValues(tx, runtime.secrets, rows, input.credentials);
    if (credential) await removeCredentialRecord(tx, runtime, credential);
  });
}
