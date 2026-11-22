import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { keyTelemetryValidator } from "contracts/acp/gateway";
import { limitEventKindValidator } from "contracts/limits/events";
import type { GlobalModelInput } from "contracts/models_dev";
import type { ProviderRouting } from "contracts/routing/settings";
import { providerNpmValidator, type ProviderSnapshot } from "contracts/workspaces/provider";
import { checkIn, createdAt, id, instant, json, literals } from "../db/columns";
import { workers } from "../worker/schema";
import { workspaces } from "../workspaces/schema";

/*
 * Usage-limit shapes. They have no contracts home yet; these mirror
 * `packages/backend/src/limits/meters.ts` until the Gateway domain owns them.
 */

/**
 * One usage meter: every upstream signal (response headers, usage polls, error bodies) and the
 * owner's metered budget normalizes to this. Fraction used is derived, never stored. Times are ms
 * epochs.
 */
export type Meter = {
  /** Stable per adapter, e.g. `codex:primary`, `openrouter:key`, `budget`. */
  id: string;
  label: string;
  /** `account` meters are shared by every key of the upstream account. */
  scope: "credential" | "account";
  unit: "percent" | "usd" | "requests" | "credits";
  /** Percent meters: 0-100; other units: amount used. */
  used?: number;
  /** Absent for percent meters and uncapped balances. */
  limit?: number;
  /** Balances without a cap. */
  remaining?: number;
  /** Window length; absent means the meter never resets. */
  windowSeconds?: number;
  resetsAt?: number;
  source: "header" | "poll" | "error" | "metered";
  observedAt: number;
};

/** Highest alert already fired for a meter; cleared by a reset or by hysteresis. */
export type AlertState = {
  meter: string;
  level: "low" | "critical" | "exhausted";
  resetsAt?: number;
};

/** Workspace usage-limit alert thresholds: percent used, and USD under which a balance meter alerts. */
export type LimitSettings = { warnPercent: number; criticalPercent: number; lowBalance: number };

const BUDGET_PERIODS = ["day", "week", "month"] as const;
const MODEL_TYPES = ["chat", "embedding", "image-generation"] as const;
const CREDENTIAL_TYPES = ["api_key", "oauth"] as const;
const SECRET_EVENT_TYPES = ["created", "updated", "deleted", "rotated"] as const;

const KEY_TELEMETRY = literals(keyTelemetryValidator);
const LIMIT_EVENT_KINDS = literals(limitEventKindValidator);
const PROVIDER_NPM = literals(providerNpmValidator);

/**
 * A workspace's configuration of one provider (a slug from the global {@link providers}
 * catalogue or an owner-defined one). `snapshot` holds the workspace-local endpoint and model
 * mapping; `routing` the owner's overrides (priority, weight, cooling, error rules), null meaning
 * defaults. A row with `deletedAt` is a tombstone: the provider was removed, its credentials are
 * gone, and keeping the row stops anything from restoring it.
 */
export const workspaceProviders = pgTable(
  "workspace_providers",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Provider slug. */
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull(),
    active: boolean("active").notNull(),
    snapshot: json<ProviderSnapshot>("snapshot"),
    deletedAt: instant("deleted_at"),
    routing: json<ProviderRouting>("routing"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "workspace_providers_tombstone",
      sql`${table.deletedAt} is null or (not ${table.enabled} and not ${table.active})`,
    ),
    // One configuration per provider in a workspace; also every provider lookup
    // (providers.list, completion pricing, routing, limits).
    uniqueIndex("workspace_providers_workspace_provider").on(table.workspace, table.provider),
  ],
);

/**
 * Non-secret metadata for one credential (API key set or OAuth account) of a workspace provider.
 * A provider may hold several; each value set is encrypted in {@link secrets} under the workspace
 * provider namespace. `provider` names a {@link workspaceProviders} row by slug; it is not a
 * foreign key because credentials carried over from the legacy per-user keys may exist for a
 * provider without a configuration row.
 */
export const workspaceCredentials = pgTable(
  "workspace_credentials",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** Masked display values by field name. */
    preview: json<Record<string, string>>("preview").notNull(),
    /** Owner-chosen name; null means a name derived from the preview. */
    label: text("label"),
    /** Disabled credentials are kept but never routed. */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Name of the secret inside the workspace provider namespace. Null for credentials created
     * before pools, whose secret is named after the provider slug.
     */
    secretName: text("secret_name"),
    /**
     * Upstream account identity reported by an OAuth flow (for example a ChatGPT account ID),
     * used to recognise reconnects of the same account; not a secret.
     */
    account: text("account"),
    /**
     * Tier inside the provider: higher is tried first, lower serves only when every higher
     * credential is blocked.
     */
    priority: integer("priority").notNull().default(0),
    /** Share inside the provider for weighted round-robin; 0 excludes the credential. */
    weight: integer("weight").notNull().default(1),
    /** Owner budget metered from Radium's own completions: USD per period, both or neither. */
    budgetAmount: doublePrecision("budget_amount"),
    budgetPeriod: text("budget_period", { enum: BUDGET_PERIODS }),
    /**
     * Masked preview of the adapter-declared limit key (an OpenRouter management key), stored
     * in {@link secrets} next to the credential; null when none is set.
     */
    limitKeyPreview: text("limit_key_preview"),
    createdAt: createdAt(),
  },
  (table) => [
    check("workspace_credentials_weight", sql`${table.weight} >= 0`),
    check(
      "workspace_credentials_budget_set",
      sql`num_nonnulls(${table.budgetAmount}, ${table.budgetPeriod}) in (0, 2)`,
    ),
    check(
      "workspace_credentials_budget_amount",
      sql`${table.budgetAmount} is null or ${table.budgetAmount} > 0`,
    ),
    checkIn("workspace_credentials_budget_period", table.budgetPeriod, BUDGET_PERIODS),
    // A provider's credentials in creation order (providers.listCredentials, routing, limits
    // list); also a workspace's credentials by the leading column.
    index("workspace_credentials_workspace_provider").on(table.workspace, table.provider),
    // A secret belongs to one credential; one credential per upstream account, so reconnecting
    // an account finds its row (providers.bindOAuthCredential) even under concurrent flows.
    uniqueIndex("workspace_credentials_secret")
      .on(table.workspace, table.provider, table.secretName)
      .where(sql`${table.secretName} is not null`),
    uniqueIndex("workspace_credentials_account")
      .on(table.workspace, table.provider, table.account)
      .where(sql`${table.account} is not null`),
  ],
);

/**
 * Gateway API keys are workspace-scoped and store only the SHA-512 hash and a masked preview.
 * Revoking sets `revokedAt` and keeps the row: completions keep their attribution and a revoked
 * Worker key still answers with its dedicated "key deleted" error. Rows are never deleted. A
 * Worker's key goes with the Worker.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Hex SHA-512 of the key. */
    hash: text("hash").notNull(),
    /** Masked, non-secret display value (e.g. `rad-sk-…aB12`). */
    preview: text("preview"),
    revokedAt: instant("revoked_at"),
    /** Set for a Worker's own Gateway key. */
    worker: text("worker").references(() => workers.id, { onDelete: "cascade" }),
    /** `off` stops telemetry capture for requests made with this key. */
    telemetry: text("telemetry", { enum: KEY_TELEMETRY }).notNull().default("workspace"),
    createdAt: createdAt(),
  },
  (table) => [
    check("api_keys_name", sql`btrim(${table.name}) <> ''`),
    checkIn("api_keys_telemetry", table.telemetry, KEY_TELEMETRY),
    // Bearer key resolution on every Gateway request (keys.getKeyInfo).
    uniqueIndex("api_keys_hash").on(table.hash),
    // A workspace's keys, newest first (keys.listKeys).
    index("api_keys_workspace").on(table.workspace, table.createdAt.desc(), table.id.desc()),
    // A Worker has at most one live key; every issue revokes the previous one first. Revoked
    // keys are not indexed: Workers are never deleted, so the cascade does not need them.
    uniqueIndex("api_keys_worker_active")
      .on(table.worker)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Usage-limit snapshot of one pooled credential: meters from response headers, error bodies,
 * polls and its metered budget; poll scheduling; and the alert state behind {@link limitEvents}.
 * Created with the credential and removed with it. Its workspace and provider are the
 * credential's.
 */
export const credentialLimits = pgTable(
  "credential_limits",
  {
    id: id(),
    credential: text("credential")
      .notNull()
      .references(() => workspaceCredentials.id, { onDelete: "cascade" }),
    meters: json<Meter[]>("meters").notNull().default([]),
    /** Upstream plan, e.g. ChatGPT `plan_type`. */
    plan: text("plan"),
    /** Last write of the snapshot; drives write throttling. */
    updatedAt: instant("updated_at").notNull(),
    /** Last meters from real traffic (headers or error bodies); fresh data defers polls. */
    passiveAt: instant("passive_at"),
    /** Last successful poll. */
    polledAt: instant("polled_at"),
    /** Last poll attempt (scheduled or owner refresh). */
    pollAttemptAt: instant("poll_attempt_at"),
    /**
     * Next scheduled poll, or the lease of a poll in flight; null when the provider has no
     * pollable adapter.
     */
    nextPollAt: instant("next_poll_at"),
    /** Last failed poll: bounded upstream message and time, with the HTTP status if there was one. */
    pollErrorMessage: text("poll_error_message"),
    pollErrorStatus: integer("poll_error_status"),
    pollErrorAt: instant("poll_error_at"),
    /** Consecutive failed polls; drives backoff and one `poll_failed` per streak. */
    pollFailures: integer("poll_failures").notNull().default(0),
    alerts: json<AlertState[]>("alerts").notNull().default([]),
    /** Set when `credential_expired` fired; cleared (with `credential_restored`) by a success. */
    expiredAt: instant("expired_at"),
    /** Budget period end; the poll job recomputes the budget meter once it passes. */
    budgetResetsAt: instant("budget_resets_at"),
    /** A budget recompute is scheduled; coalesces completions. */
    budgetPendingAt: instant("budget_pending_at"),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "credential_limits_poll_error",
      sql`num_nonnulls(${table.pollErrorMessage}, ${table.pollErrorAt}) in (0, 2) and (${table.pollErrorStatus} is null or ${table.pollErrorMessage} is not null)`,
    ),
    check("credential_limits_poll_failures", sql`${table.pollFailures} >= 0`),
    // One snapshot per credential; also its lookup and the cascade from `workspace_credentials`.
    uniqueIndex("credential_limits_credential").on(table.credential),
    // The `limits.poll` job's claim: due rows, `for update skip locked`.
    index("credential_limits_next_poll")
      .on(table.nextPollAt)
      .where(sql`${table.nextPollAt} is not null`),
    // The same job's budget rollover scan: periods that ended.
    index("credential_limits_budget_resets")
      .on(table.budgetResetsAt)
      .where(sql`${table.budgetResetsAt} is not null`),
  ],
);

/**
 * Usage-limit and credential-health events, each with its complete payload (meter before and
 * after, the credential's snapshot, provider and credential identity, the thresholds in force)
 * for delivery channels. Kept 30 days. Names are captured so an event outlives its credential;
 * deleting the credential clears `credential`.
 */
export const limitEvents = pgTable(
  "limit_events",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: LIMIT_EVENT_KINDS }).notNull(),
    provider: text("provider").notNull(),
    providerName: text("provider_name").notNull(),
    credential: text("credential").references(() => workspaceCredentials.id, {
      onDelete: "set null",
    }),
    credentialName: text("credential_name").notNull(),
    meter: json<Meter>("meter"),
    previous: json<Meter>("previous"),
    threshold: doublePrecision("threshold"),
    /** Upstream HTTP status for credential and poll events. */
    status: integer("status"),
    message: text("message").notNull(),
    /** The credential's meters and plan when the event fired. */
    snapshot: json<{ meters: Meter[]; plan?: string }>("snapshot").notNull(),
    /** The workspace thresholds in force when the event fired. */
    settingsWarnPercent: doublePrecision("settings_warn_percent").notNull(),
    settingsCriticalPercent: doublePrecision("settings_critical_percent").notNull(),
    settingsLowBalance: doublePrecision("settings_low_balance").notNull(),
    occurredAt: instant("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("limit_events_kind", table.kind, LIMIT_EVENT_KINDS),
    // A workspace's recent events, newest first (limits.listEvents).
    index("limit_events_workspace_occurred").on(
      table.workspace,
      table.occurredAt.desc(),
      table.id.desc(),
    ),
    // The 30-day retention delete (limits.pruneEvents).
    index("limit_events_occurred").on(table.occurredAt),
    // Cascade from `workspace_credentials`: removing a credential clears its events' link.
    index("limit_events_credential")
      .on(table.credential)
      .where(sql`${table.credential} is not null`),
  ],
);

/**
 * Upstream subscription login sessions (ChatGPT device flow), keyed by the session id inside the
 * stored cookie. Losing one forces a new login. Expiry is lazy: an expired row reads as absent
 * until a write replaces it. Rate-limit buckets of the same Convex table live in Valkey.
 */
export const subscriptionSessions = pgTable(
  "subscription_sessions",
  {
    id: id(),
    provider: text("provider").notNull(),
    key: text("key").notNull(),
    value: json<unknown>("value").notNull(),
    expiresAt: instant("expires_at"),
    createdAt: createdAt(),
  },
  (table) => [
    // The upsert identity and every read and delete (subscriptions.getState/setState/deleteState).
    uniqueIndex("subscription_sessions_provider_key").on(table.provider, table.key),
  ],
);

/**
 * Secret Store envelopes. Each secret has a random data key (DEK); the value is encrypted with it
 * (AES-256-GCM, AAD `["value", namespace, name]`) and the DEK is wrapped under the key-encryption
 * key `keyVersion` of `SECRET_STORE_KEYS` (AAD `["dek", namespace, name, version]`). The text
 * columns are stored exactly as the envelope encoded them; the namespace and name are bound into
 * the AAD, so rows are never renamed.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    /** Null is the store's default namespace; names are unique inside it too. */
    namespace: text("namespace"),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    iv: text("iv").notNull(),
    wrappedDEK: text("wrapped_dek").notNull(),
    dekIv: text("dek_iv").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** Plaintext facts about the secret, such as the masked preview shown to the owner. */
    metadata: json<Record<string, unknown>>("metadata"),
    /** After this the value reads as expired; null never expires. */
    expiresAt: instant("expires_at"),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("secrets_namespace", sql`${table.namespace} is null or ${table.namespace} <> ''`),
    check("secrets_name", sql`btrim(${table.name}) <> ''`),
    // The store upserts and reads by (namespace, name); a null namespace is a value of its own,
    // as in the Convex index, so nulls are not distinct.
    unique("secrets_namespace_name").on(table.namespace, table.name).nullsNotDistinct(),
    // Key rotation: rows still wrapped under an older key version.
    index("secrets_key_version").on(table.keyVersion),
  ],
);

/**
 * Append-only audit trail of secret changes (never values). Events outlive their secret: the
 * delete event is written first, then the secret goes and `secret` is cleared, leaving the
 * namespace and name.
 */
export const secretEvents = pgTable(
  "secret_events",
  {
    id: id(),
    secret: text("secret").references(() => secrets.id, { onDelete: "set null" }),
    namespace: text("namespace"),
    name: text("name").notNull(),
    type: text("type", { enum: SECRET_EVENT_TYPES }).notNull(),
    /** Operation context (a delete reason, a key-version move), not the secret's own metadata. */
    metadata: json<Record<string, unknown>>("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("secret_events_type", table.type, SECRET_EVENT_TYPES),
    // Set null from `secrets` (every secret delete) and one secret's history.
    index("secret_events_secret")
      .on(table.secret)
      .where(sql`${table.secret} is not null`),
  ],
);

/** Global model catalogue author (a lab or company), unique by slug. */
export const authors = pgTable(
  "authors",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Resolving an author by slug while importing models; also authors.authorInfo.
    uniqueIndex("authors_slug").on(table.slug),
  ],
);

/**
 * Global model identity, unique by canonical slug. Providers map their own model ids onto it;
 * workspace mutations only add rows, never change existing ones.
 */
export const models = pgTable(
  "models",
  {
    id: id(),
    name: text("name").notNull(),
    launchDate: instant("launch_date").notNull(),
    author: text("author")
      .notNull()
      .references(() => authors.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    /** Link to the model weights. */
    modelWeights: text("model_weights"),
    type: text("type", { enum: MODEL_TYPES }).notNull(),
    description: text("description").notNull(),
    warning: text("warning"),
    reasoning: boolean("reasoning").notNull(),
    /**
     * Reasoning capabilities; null means not declared, which differs from false
     * (`reasoning_none` false removes the "none" effort).
     */
    featuresReasoningMinimal: boolean("features_reasoning_minimal"),
    featuresReasoningNone: boolean("features_reasoning_none"),
    featuresReasoningBudget: boolean("features_reasoning_budget"),
    featuresReasoningEfforts: text("features_reasoning_efforts").array(),
    architecture: json<GlobalModelInput["architecture"]>("architecture").notNull(),
    defaultTemperature: doublePrecision("default_temperature"),
    defaultTopP: doublePrecision("default_top_p"),
    defaultFrequencyPenalty: doublePrecision("default_frequency_penalty"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("models_type", table.type, MODEL_TYPES),
    // Lookup by slug (models.modelInfo, catalogue import dedupe, completion pricing).
    uniqueIndex("models_slug").on(table.slug),
  ],
);

/**
 * Global provider catalogue, unique by slug. Workspaces copy a row into their own
 * {@link workspaceProviders} snapshot; the catalogue itself is never edited from a workspace.
 */
export const providers = pgTable(
  "providers",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    npm: text("npm", { enum: PROVIDER_NPM }).notNull(),
    /** Environment variable names the adapter reads its credentials from. */
    env: text("env").array().notNull(),
    catalogueProvider: text("catalogue_provider"),
    credentialType: text("credential_type", { enum: CREDENTIAL_TYPES }),
    oauthFlow: text("oauth_flow"),
    doc: text("doc"),
    /** Base URL of an OpenAI-compatible API. */
    api: text("api"),
    enabled: boolean("enabled").notNull(),
    models: json<ProviderSnapshot["models"]>("models").notNull().default([]),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("providers_npm", table.npm, PROVIDER_NPM),
    checkIn("providers_credential_type", table.credentialType, CREDENTIAL_TYPES),
    // Lookup by slug (catalogue fallback for a workspace provider, provider listing).
    uniqueIndex("providers_slug").on(table.slug),
  ],
);

/** An application that calls the Gateway, for attributing completions. */
export const aiApps = pgTable("ai_apps", {
  id: id(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  /** Icon URL. */
  icon: text("icon"),
  createdAt: createdAt(),
});
