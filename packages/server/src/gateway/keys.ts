import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { keyTelemetryValidator } from "contracts/acp/gateway";
import type { Database, Kv } from "../drivers/types";
import { AppError } from "../errors";
import { kvGet, kvSet } from "../kv";
import { releaseWorkerGatewayKey, workerNames } from "../worker/workers";
import { workspaces } from "../workspaces/schema";
import { apiKeys } from "./schema";

type KeyTelemetry = z.infer<typeof keyTelemetryValidator>;

/*
 * Gateway API keys (`rad-sk-…`): workspace-scoped bearer keys for `/api/openai/v1/*`. Only the
 * hex SHA-512 of a key and a masked preview are stored; the key is shown once at creation.
 *
 * Resolution is cached in Valkey (`gateway:key:<hash>`, {@link KEY_CACHE_TTL_MS}) because every
 * Gateway request resolves its key. A change that can invalidate a resolution (revoke, rename,
 * telemetry, workspace archive) overwrites the entry with a tombstone for the same TTL instead
 * of deleting it: a resolution that read Postgres before the change cannot cache its stale
 * answer afterwards, because caching is `SET NX` and never replaces the tombstone.
 */

const KEY_CACHE_TTL_MS = 60_000;
const KEY_TOMBSTONE = "invalidated";
const MAX_LISTED_KEYS = 200;
const MAX_KEY_NAME_LENGTH = 128;

/** Hex SHA-512 of a key: the only form stored. */
export async function hashApiKey(key: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-512", new TextEncoder().encode(key)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new key (`rad-sk-` + 24 random bytes base64url) and its masked preview. */
export function generateApiKey(): { key: string; preview: string } {
  const body = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  return { key: `rad-sk-${body}`, preview: `rad-sk-…${body.slice(-4)}` };
}

const keyCacheKey = (hash: string) => `gateway:key:${hash}`;

/** What a valid Gateway key grants: its workspace (owner) and telemetry choice. */
export type ResolvedApiKey = {
  id: string;
  name: string;
  workspace: string;
  /** The workspace owner; Gateway calls act for the workspace, attributed to its owner. */
  userId: string;
  telemetry: KeyTelemetry;
  /** Set for a Worker's own Gateway key. */
  worker: string | null;
};

/** Why a bearer key was refused; `message` is safe to return to the caller. */
export class ApiKeyRefused extends Error {
  constructor(message = "The Authorization is invalid!") {
    super(message);
    this.name = "ApiKeyRefused";
  }
}

/**
 * Resolves a Gateway bearer key without browser-session authentication. Unknown and revoked
 * keys, and keys of archived workspaces, are refused with the generic message; a revoked Worker
 * key gets the actionable "key deleted" message naming the Worker.
 */
export async function resolveApiKey(db: Database, kv: Kv, key: string): Promise<ResolvedApiKey> {
  const hash = await hashApiKey(key);
  const cached = await kvGet(kv, keyCacheKey(hash));
  if (cached && cached !== KEY_TOMBSTONE) return JSON.parse(cached) as ResolvedApiKey;

  const [row] = await db
    .select({ key: apiKeys, ownerId: workspaces.ownerId, archivedAt: workspaces.archivedAt })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspace))
    .where(eq(apiKeys.hash, hash));
  if (!row) throw new ApiKeyRefused();
  if (row.key.revokedAt !== null) {
    if (row.key.worker) {
      const name = (await workerNames(db, row.key.workspace, [row.key.worker])).get(row.key.worker);
      throw new ApiKeyRefused(
        `The Gateway key of Worker ${name ?? row.key.name} was deleted. The workspace owner can issue a new key in Settings → Workers.`,
      );
    }
    throw new ApiKeyRefused();
  }
  if (row.archivedAt !== null) throw new ApiKeyRefused();

  const resolved: ResolvedApiKey = {
    id: row.key.id,
    name: row.key.name,
    workspace: row.key.workspace,
    userId: row.ownerId,
    telemetry: row.key.telemetry,
    worker: row.key.worker,
  };
  await kvSet(kv, keyCacheKey(hash), JSON.stringify(resolved), {
    ttlMs: KEY_CACHE_TTL_MS,
    onlyIfAbsent: true,
  });
  return resolved;
}

/** Makes cached resolutions of the given key hashes stale (see the module comment). */
async function invalidateKeys(kv: Kv, hashes: string[]) {
  await Promise.all(
    hashes.map((hash) => kvSet(kv, keyCacheKey(hash), KEY_TOMBSTONE, { ttlMs: KEY_CACHE_TTL_MS })),
  );
}

/**
 * Invalidates the cached resolutions of every key of a workspace; called after the workspace
 * was archived so its keys stop working at once.
 */
export async function invalidateWorkspaceKeys(db: Database, kv: Kv, workspace: string) {
  const rows = await db
    .select({ hash: apiKeys.hash })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspace, workspace), isNull(apiKeys.revokedAt)));
  await invalidateKeys(
    kv,
    rows.map((row) => row.hash),
  );
}

function normalizeKeyName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("BAD_REQUEST", "Key name is required.");
  if (trimmed.length > MAX_KEY_NAME_LENGTH) {
    throw new AppError("BAD_REQUEST", `Key names must be at most ${MAX_KEY_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/** Active keys of the workspace, newest first (owner view; never the key itself). */
export async function listApiKeys(db: Database, workspace: string) {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.workspace, workspace), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(MAX_LISTED_KEYS);
  const names = await workerNames(
    db,
    workspace,
    rows.flatMap((row) => (row.worker ? [row.worker] : [])),
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.getTime(),
    name: row.name,
    preview: row.preview,
    telemetry: row.telemetry,
    worker: row.worker ? { id: row.worker, name: names.get(row.worker) ?? row.name } : null,
  }));
}

/**
 * Which of `ids` are keys of `workspace`, revoked ones included (rows are never deleted, so a
 * stored reference stays valid). Used to validate key lists other domains store.
 */
export async function workspaceApiKeyIds(
  db: Database,
  workspace: string,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspace, workspace), inArray(apiKeys.id, [...ids])));
  return new Set(rows.map((row) => row.id));
}

/** Creates a workspace key; the plaintext key is returned exactly once. */
export async function createApiKey(db: Database, workspace: string, name: string) {
  const keyName = normalizeKeyName(name);
  const { key, preview } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ workspace, name: keyName, hash: await hashApiKey(key), preview })
    .returning({ id: apiKeys.id });
  return { id: row!.id, key, preview };
}

/** The workspace's active key `id`, locked for the transaction; anything else is `NOT_FOUND`. */
async function requireActiveKey(tx: Database, workspace: string, id: string) {
  const [row] = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspace, workspace), isNull(apiKeys.revokedAt)))
    .for("update");
  if (!row) throw new AppError("NOT_FOUND", "Key not found.");
  return row;
}

/** Renames a workspace key. */
export async function renameApiKey(
  db: Database,
  kv: Kv,
  workspace: string,
  input: { key: string; name: string },
) {
  const name = normalizeKeyName(input.name);
  const hash = await db.transaction(async (tx) => {
    const row = await requireActiveKey(tx, workspace, input.key);
    await tx.update(apiKeys).set({ name }).where(eq(apiKeys.id, row.id));
    return row.hash;
  });
  await invalidateKeys(kv, [hash]);
}

/**
 * Revokes a workspace key for good (rows stay so completions keep their attribution). A Worker's
 * key also clears that Worker's Gateway access. Deleting an unknown or already revoked key of
 * the workspace succeeds, as in Convex.
 */
export async function revokeApiKey(db: Database, kv: Kv, workspace: string, id: string) {
  const hash = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspace, workspace), isNull(apiKeys.revokedAt)))
      .returning({ hash: apiKeys.hash, worker: apiKeys.worker });
    if (!row) return null;
    if (row.worker) await releaseWorkerGatewayKey(tx, id);
    return row.hash;
  });
  if (hash) await invalidateKeys(kv, [hash]);
  return true;
}

/** Turns telemetry capture off (or back to the workspace setting) for requests with this key. */
export async function setApiKeyTelemetry(
  db: Database,
  kv: Kv,
  workspace: string,
  input: { key: string; telemetry: KeyTelemetry },
) {
  const hash = await db.transaction(async (tx) => {
    const row = await requireActiveKey(tx, workspace, input.key);
    if (row.worker) {
      throw new AppError(
        "BAD_REQUEST",
        "Set Gateway telemetry for this key on its Worker in Settings → Workers.",
      );
    }
    await tx.update(apiKeys).set({ telemetry: input.telemetry }).where(eq(apiKeys.id, row.id));
    return row.hash;
  });
  await invalidateKeys(kv, [hash]);
}
