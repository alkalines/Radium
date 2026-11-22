import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { findWorkspaceForLegacyBalance } from "../../convex/workspaces";
import { limitNotificationBody, notificationTitle } from "contracts/notifications/contract";
import { workspaceHash } from "../telemetry/hash";
import type { LegacyBox, LegacyRecipient } from "contracts/e2ee/legacy-contract";
import { activeLegacyRecipient } from "./legacy-crypto";
import type { LegacyAdapter } from "./migration-contract";
import { blobScheme, KEYED_HASH_VERSION, messageSessionKey, nodeScheme, REKEYED_HASH_VERSION } from "./migration-telemetry-provenance";
import { persistedAudience } from "./migration-telemetry-proofs";
import { directAudience, referrerAudience } from "./migration-telemetry-attribution";
import type { TelemetryAudience } from "./migration-telemetry-contract";

type Ctx = QueryCtx | MutationCtx;
type Workspace = Doc<"workspaces">;

/** Fields the migration adds to every historical row; the schema owner declares them. */
type Migrated = { legacyContent?: LegacyBox; legacyHashVersion?: number };
type Blob = Doc<"telemetry_blobs"> & Migrated;
type Node = Doc<"telemetry_nodes"> & Migrated;
type Request = Doc<"telemetry_requests"> & Migrated;
type Trace = Doc<"telemetry_traces"> & Migrated;
type Span = Doc<"telemetry_spans"> & Migrated;
type Payload = Doc<"telemetry_payloads"> & Migrated;
type Session = Doc<"telemetry_sessions"> & Migrated;
type RoutingSession = Doc<"routing_sessions"> & Migrated;
type Notification = Doc<"notifications"> & Migrated;

const tables = [
  "telemetry_blobs", "telemetry_nodes", "telemetry_requests", "telemetry_sessions",
  "telemetry_traces", "telemetry_spans", "telemetry_payloads", "notifications", "routing_sessions",
] as const;
type Table = (typeof tables)[number];

const HISTORICAL_SPAN_NAME = "Historical span";

async function requireWorkspace(ctx: Ctx, id: Id<"workspaces">): Promise<Workspace> {
  const workspace = await ctx.db.get("workspaces", id);
  if (!workspace) throw new Error("Telemetry record has no owning workspace");
  return workspace;
}

/** Legacy AI SDK traces name their workspace directly or only through the old balance. */
async function traceWorkspace(ctx: Ctx, trace: Doc<"telemetry_traces">): Promise<Workspace> {
  const viaBalance = trace.balance ? await findWorkspaceForLegacyBalance(ctx, trace.balance) : null;
  if (trace.workspace && viaBalance && viaBalance._id !== trace.workspace) {
    throw new Error("Telemetry trace workspace and balance disagree");
  }
  const id = trace.workspace ?? viaBalance?._id;
  if (!id) throw new Error("Telemetry trace has ambiguous workspace ownership");
  return requireWorkspace(ctx, id);
}

/** Spans and payloads are valid only inside the trace that owns them. */
async function owningTrace(ctx: Ctx, table: "telemetry_spans" | "telemetry_payloads", row: Span | Payload) {
  const trace = await ctx.db.get("telemetry_traces", row.trace);
  if (!trace) throw new Error("Telemetry record has no owning trace");
  const workspace = await traceWorkspace(ctx, trace);
  if (table === "telemetry_spans") {
    const span = row as Span;
    if (span.workspace && span.workspace !== workspace._id) throw new Error("Telemetry workspace mismatch");
  } else {
    const payload = row as Payload;
    if (payload.span) {
      const span = await ctx.db.get("telemetry_spans", payload.span);
      if (!span || span.trace !== payload.trace) throw new Error("Telemetry payload span mismatch");
    }
  }
  return { trace, workspace };
}

/** The workspace and audience that may read a (non-notification) row, proven from its owners. */
async function attribution(ctx: Ctx, table: Exclude<Table, "notifications">, row: unknown): Promise<{
  workspace: Workspace;
  audience: TelemetryAudience;
}> {
  switch (table) {
    case "routing_sessions": {
      const binding = row as RoutingSession;
      const workspace = await requireWorkspace(ctx, binding.workspace);
      // Affinity rows have no trustworthy chat attribution. Keep the original fingerprint custodial until TTL cleanup.
      return { workspace, audience: { kind: "custody", reason: "orphan" } };
    }
    case "telemetry_requests": {
      const request = row as Request;
      const workspace = await requireWorkspace(ctx, request.workspace);
      return { workspace, audience: await directAudience(ctx, workspace, request.chatId) };
    }
    case "telemetry_traces": {
      const trace = row as Trace;
      const workspace = await traceWorkspace(ctx, trace);
      return { workspace, audience: await directAudience(ctx, workspace, trace.chatId) };
    }
    case "telemetry_spans":
    case "telemetry_payloads": {
      const { trace, workspace } = await owningTrace(ctx, table, row as Span | Payload);
      return { workspace, audience: await directAudience(ctx, workspace, trace.chatId) };
    }
    case "telemetry_sessions": {
      const session = row as Session;
      const workspace = await requireWorkspace(ctx, session.workspace);
      return { workspace, audience: await directAudience(ctx, workspace, session.chatId) };
    }
    case "telemetry_blobs":
    case "telemetry_nodes": {
      const shared = row as Blob | Node;
      const workspace = await requireWorkspace(ctx, shared.workspace);
      // A complete bounded proof is always fresh and wins. Only a row too wide for one transaction
      // falls back to a finished persisted proof of the current generation (see `persistedAudience`).
      const bounded = await referrerAudience(ctx, workspace, { table, id: shared._id });
      const settled = bounded.kind === "custody" && bounded.reason === "over_budget" && shared.legacyContent?.kind === "custody"
        ? await persistedAudience(ctx, table, shared._id)
        : undefined;
      return { workspace, audience: settled ?? bounded };
    }
  }
}

/** Custody is the absence of a recipient; the audience never widens to the owner implicitly. */
async function audienceRecipient(ctx: Ctx, workspace: Workspace, audience: TelemetryAudience): Promise<LegacyRecipient | undefined> {
  if (audience.kind === "owner") return activeLegacyRecipient(ctx, { workspace: workspace._id, purpose: "owner" });
  if (audience.kind === "chat") return activeLegacyRecipient(ctx, { workspace: workspace._id, chat: audience.chat });
  return undefined;
}

/** Plaintext fields to move into the sidecar, with the generic values the schema still requires. */
function extractFields(row: Record<string, unknown>, fields: readonly string[], placeholders: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    if (row[field] === undefined) continue;
    if (row[field] === placeholders[field]) continue;
    value[field] = row[field];
    patch[field] = placeholders[field];
  }
  return { value, patch };
}

/**
 * Legacy rows carry unkeyed content fingerprints, a dictionary oracle for guessed content. They
 * are replaced by a keyed digest of the old value and the old value moves into the sidecar.
 * Rows that already carry the marker, or whose blob is natively sealed, keep their keyed hash
 * because native ciphertext authenticates it.
 */
async function rekeyedHash(workspace: Workspace, domain: string, hash: string) {
  return {
    value: { legacyHash: hash },
    patch: { hash: await workspaceHash(workspace._id, domain, hash), legacyHashVersion: REKEYED_HASH_VERSION },
  };
}

/**
 * Extracts historical telemetry and notification plaintext without touching native ciphertext.
 * Telemetry rows are shared across requests, so a blob or node is sealed to the owner only when
 * every referencing request is owner-visible (see `migration-telemetry-attribution.ts`).
 */
export const domain: LegacyAdapter = {
  tables,

  async inspect(ctx, tableName, source) {
    const table = tableName as Table;
    const row = source as Record<string, unknown>;
    let value: Record<string, unknown> = {};
    let patch: Record<string, unknown> = {};
    let storage: { id: Id<"_storage">; field: string; encoding: "text" } | undefined;

    if (table === "notifications") {
      const notification = source as Notification;
      const title = notificationTitle(notification.kind);
      const body = notification.chat ? "Session" : "Workspace";
      const genericDiffers = notification.title !== title || notification.body !== body;
      if (genericDiffers) {
        // Native sealing (pending or done) writes generic text, never anything else.
        if (notification.legacyContent || notification.sealed) {
          throw new Error("Notification has both encrypted and plaintext content");
        }
        value = { title: notification.title, body: notification.body };
        patch = { title, body };
      }
      const detail = notification.limitMetadata;
      if (detail !== undefined) {
        // Credential, provider and meter labels are plaintext detail the producer no longer stores.
        value.limitMetadata = detail;
        patch.limitMetadata = undefined;
        if (!genericDiffers && !notification.sealed) {
          value.title = title;
          value.body = limitNotificationBody(detail);
        }
      }
    } else if (table === "telemetry_nodes") {
      const node = source as Node;
      if (node.legacyHashVersion === undefined && !node.legacyContent && (await nodeScheme(ctx, node)) === "unkeyed") {
        const workspace = await requireWorkspace(ctx, node.workspace);
        ({ value, patch } = await rekeyedHash(workspace, "legacy-node-hash", node.hash));
      }
    } else if (table === "telemetry_blobs") {
      const blob = source as Blob;
      ({ value, patch } = extractFields(row, ["content", "meta"], {}));
      if (blob.storage && !blob.sealed) {
        // Plaintext File Storage; sealed blobs keep their encrypted envelope file.
        if (blob.content !== undefined) throw new Error("Telemetry blob has ambiguous content sources");
        storage = { id: blob.storage, field: "content", encoding: "text" };
        patch.storage = undefined;
      }
      if (!blob.sealed && blob.legacyHashVersion === undefined && !blob.legacyContent) {
        const scheme = await blobScheme(ctx, blob);
        if (scheme === "unkeyed") {
          const workspace = await requireWorkspace(ctx, blob.workspace);
          const rekey = await rekeyedHash(workspace, "legacy-blob-hash", blob.hash);
          value = { ...value, ...rekey.value };
          patch = { ...patch, ...rekey.patch };
        } else if (Object.keys(value).length > 0 || storage) {
          // Keyed content is sealed with its hash kept; the marker preserves that provenance so
          // chain neighbours are never mistaken for unkeyed ones once the content is ciphertext.
          patch.legacyHashVersion = KEYED_HASH_VERSION;
        }
      }
    } else if (table === "telemetry_requests") {
      const request = source as Request;
      ({ value, patch } = extractFields(row, ["error"]));
      if (request.attempts.some((attempt) => attempt.message !== undefined)) {
        value.attempts = request.attempts.map((attempt) => attempt.message ?? null);
        patch.attempts = request.attempts.map((attempt) => ({ ...attempt, message: undefined }));
      }
    } else if (table === "telemetry_payloads") {
      ({ value, patch } = extractFields(row, ["inputJson", "outputJson"]));
    } else if (table === "telemetry_spans") {
      ({ value, patch } = extractFields(row, ["name", "toolName", "toolCallId", "error"], { name: HISTORICAL_SPAN_NAME }));
    } else if (table === "routing_sessions") {
      const binding = source as RoutingSession;
      const old = /^(msg:[0-9a-f]{16})(::.*)?$/.exec(binding.key);
      if (old) {
        if (binding.legacyContent || binding.legacyHashVersion !== undefined) throw new Error("Routing session has a rekey marker beside an unkeyed key");
        const workspace = await requireWorkspace(ctx, binding.workspace);
        value = { legacyKey: binding.key };
        patch = {
          key: `msg:${await workspaceHash(workspace._id, "legacy-routing-session", old[1]!)}${old[2] ?? ""}`,
          legacyHashVersion: REKEYED_HASH_VERSION,
        };
      } else if (binding.key.startsWith("msg:") && !/^msg:[0-9a-f]{64}(?:::|$)/.test(binding.key)) {
        throw new Error("Routing session has an unknown message fingerprint format");
      }
    } else if (table === "telemetry_sessions") {
      // Dev wrote `msg:` + FNV-1a 64 (16 hex) of the first system/user text: a dictionary oracle,
      // rekeyed exactly once. `key` and `parentKey` use ONE deterministic mapping, so a parent and
      // its children agree whichever of them migrates first. Native keyed keys (64 hex) and
      // explicit client ids stay untouched; the originals live only in the sidecar value.
      const session = source as Session;
      const shapes = [messageSessionKey(session.key), session.parentKey === undefined ? undefined : messageSessionKey(session.parentKey)];
      if (shapes.includes("unknown")) throw new Error("Telemetry session has an unknown message fingerprint format");
      const unkeyed = shapes.map((shape) => shape === "unkeyed");
      if (unkeyed.some(Boolean)) {
        if (session.legacyHashVersion !== undefined) throw new Error("Telemetry session has a rekey marker beside an unkeyed key");
        // The marker says "unkeyed originally", so a keyed key beside an unkeyed parent is contradictory.
        if (shapes[0] === "keyed") throw new Error("Telemetry session mixes keyed and unkeyed fingerprints");
        const workspace = await requireWorkspace(ctx, session.workspace);
        const rekey = async (key: string) => `msg:${await workspaceHash(workspace._id, "legacy-routing-session", key)}`;
        if (unkeyed[0]) {
          value.legacyKey = session.key;
          patch.key = await rekey(session.key);
        }
        if (unkeyed[1]) {
          value.legacyParentKey = session.parentKey;
          patch.parentKey = await rekey(session.parentKey!);
        }
        patch.legacyHashVersion = REKEYED_HASH_VERSION;
      }
    } else {
      ({ value, patch } = extractFields(row, ["error"]));
    }

    if (Object.keys(value).length === 0 && !storage) return null;
    if ((source as Migrated).legacyContent) throw new Error("Telemetry row has both legacy ciphertext and plaintext");

    if (table === "notifications") {
      const notification = source as Notification;
      const recipient = await activeLegacyRecipient(ctx, { userId: notification.userId });
      return { value, patch, recipient, workspace: notification.workspace, userId: notification.userId };
    }
    const { workspace, audience } = await attribution(ctx, table, source);
    const recipient = await audienceRecipient(ctx, workspace, audience);
    return { value, patch, recipient, workspace: workspace._id, storage, ...(audience.kind === "chat" ? { chat: audience.chat } : {}) };
  },

  async releaseRecipient(ctx, tableName, source) {
    const table = tableName as Table;
    if (table === "notifications") {
      const notification = source as Notification;
      return activeLegacyRecipient(ctx, { userId: notification.userId });
    }
    const { workspace, audience } = await attribution(ctx, table, source);
    return audienceRecipient(ctx, workspace, audience);
  },
};
