import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { toBase64Url } from "radium-crypto";
import { findUsers } from "../auth/users";
import { requireChatAccess } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { e2eeChatKeys, e2eeIdentities, e2eeTrustStores } from "./schema";
import { identityWire } from "./wire";
import { invalidKeys, requireBox, requireKeyId } from "./workspace-keys";

/** Largest trust store envelope accepted. */
export const MAX_TRUST_STORE_BYTES = 262144;
/** Users or key ids one directory read may name. */
export const MAX_DIRECTORY_IDS = 200;

/** The caller's own opaque pin envelope, or `null` before the first save. */
export async function getTrustStore(db: Database, userId: string) {
  const [store] = await db
    .select({ version: e2eeTrustStores.version, envelope: e2eeTrustStores.envelope })
    .from(e2eeTrustStores)
    .where(eq(e2eeTrustStores.userId, userId));
  return store ? { version: store.version, envelope: toBase64Url(store.envelope) } : null;
}

function trustStoreConflict(): never {
  throw new AppError("CONFLICT", "TRUST_STORE_CONFLICT");
}

/**
 * Compare-and-swap save: `version` must be `expectedVersion + 1` and `expectedVersion` the stored
 * version (`null` before the first save), so a stale device cannot overwrite a newer trust
 * decision. The check and the write are one statement: an insert that does nothing when a store
 * exists, or an update conditional on the expected version.
 */
export async function saveTrustStore(
  db: Database,
  userId: string,
  input: { expectedVersion: number | null; version: number; envelope: Uint8Array },
): Promise<void> {
  requireBox(input.envelope, MAX_TRUST_STORE_BYTES);
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version !== (input.expectedVersion ?? 0) + 1
  ) {
    trustStoreConflict();
  }
  const fields = { version: input.version, envelope: input.envelope, updatedAt: new Date() };
  const saved =
    input.expectedVersion === null
      ? await db
          .insert(e2eeTrustStores)
          .values({ userId, ...fields })
          .onConflictDoNothing({ target: e2eeTrustStores.userId })
          .returning({ id: e2eeTrustStores.id })
      : await db
          .update(e2eeTrustStores)
          .set(fields)
          .where(
            and(
              eq(e2eeTrustStores.userId, userId),
              eq(e2eeTrustStores.version, input.expectedVersion),
            ),
          )
          .returning({ id: e2eeTrustStores.id });
  if (saved.length === 0) {
    trustStoreConflict();
  }
}

/**
 * Which of `userIds` the caller may look up in the public-key directory: themselves and every
 * user sharing an active workspace with them (its owner or a direct member).
 */
async function visibleUsers(db: Database, userId: string, userIds: string[]): Promise<Set<string>> {
  const visible = new Set(userIds.filter((id) => id === userId));
  const others = [...new Set(userIds.filter((id) => id !== userId))];
  if (others.length === 0) {
    return visible;
  }
  const mine = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .leftJoin(
      workspaceMembers,
      and(eq(workspaceMembers.workspace, workspaces.id), eq(workspaceMembers.userId, userId)),
    )
    .where(
      and(
        isNull(workspaces.archivedAt),
        or(eq(workspaces.ownerId, userId), eq(workspaceMembers.userId, userId)),
      ),
    );
  const owners = await db
    .select({ userId: workspaces.ownerId })
    .from(workspaces)
    .where(and(inArray(workspaces.id, mine), inArray(workspaces.ownerId, others)));
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(inArray(workspaceMembers.workspace, mine), inArray(workspaceMembers.userId, others)),
    );
  for (const row of [...owners, ...members]) {
    visible.add(row.userId);
  }
  return visible;
}

function requireDirectorySize(ids: readonly string[]) {
  if (ids.length > MAX_DIRECTORY_IDS) {
    invalidKeys();
  }
}

/**
 * Active public identities, in request order (`null` for users without one), restricted to the
 * caller and users sharing an active workspace with them; naming anyone else is refused.
 */
export async function identityKeys(db: Database, userId: string, userIds: string[]) {
  requireDirectorySize(userIds);
  const visible = await visibleUsers(db, userId, userIds);
  if (userIds.some((id) => !visible.has(id))) {
    invalidKeys();
  }
  const rows =
    userIds.length === 0
      ? []
      : await db
          .select()
          .from(e2eeIdentities)
          .where(and(inArray(e2eeIdentities.userId, userIds), eq(e2eeIdentities.status, "active")));
  const byUser = new Map(rows.map((row) => [row.userId, row]));
  return userIds.map((id) => {
    const row = byUser.get(id);
    return row ? identityWire(row) : null;
  });
}

/**
 * Display names for trust prompts and key status rows, under the same rule as
 * {@link identityKeys}. Names are labels, never trust anchors; clients still compare
 * fingerprints. Unknown accounts are absent.
 */
export async function identityNames(db: Database, userId: string, userIds: string[]) {
  requireDirectorySize(userIds);
  const unique = [...new Set(userIds)];
  const visible = await visibleUsers(db, userId, unique);
  if (unique.some((id) => !visible.has(id))) {
    invalidKeys();
  }
  const profiles = new Map((await findUsers(db, unique)).map((row) => [row.id, row.name]));
  return unique.flatMap((id) => {
    const name = profiles.get(id);
    return name === undefined ? [] : [{ userId: id, name }];
  });
}

/**
 * Identities by key id, retired ones included so old signatures stay verifiable after a reset;
 * pending keys never authenticate data and read as `null`, like unknown ones. Keys of users the
 * caller cannot see are refused, except the signer of `chatEpoch` (an epoch of a chat the caller
 * can read), so a removed creator's historical signatures stay verifiable.
 */
export async function identityKeysByKeyId(
  db: Database,
  userId: string,
  input: { keyIds: string[]; chatEpoch?: { chatId: string; epoch: number } },
) {
  requireDirectorySize(input.keyIds);
  for (const keyId of input.keyIds) {
    requireKeyId(keyId);
  }
  let chatSigner: string | null = null;
  if (input.chatEpoch) {
    const { chat } = await requireChatAccess(db, userId, input.chatEpoch.chatId);
    const [row] = await db
      .select({ signerKeyId: e2eeChatKeys.signerKeyId })
      .from(e2eeChatKeys)
      .where(and(eq(e2eeChatKeys.chat, chat.id), eq(e2eeChatKeys.epoch, input.chatEpoch.epoch)));
    chatSigner = row?.signerKeyId ?? null;
  }
  const rows =
    input.keyIds.length === 0
      ? []
      : await db.select().from(e2eeIdentities).where(inArray(e2eeIdentities.keyId, input.keyIds));
  const byKey = new Map(
    rows.flatMap((row) => (row.status === "pending" ? [] : [[row.keyId, row] as const])),
  );
  const visible = await visibleUsers(
    db,
    userId,
    [...byKey.values()].map((row) => row.userId),
  );
  return input.keyIds.map((keyId) => {
    const row = byKey.get(keyId);
    if (!row) {
      return null;
    }
    if (!visible.has(row.userId) && chatSigner !== keyId) {
      invalidKeys();
    }
    return { ...identityWire(row), status: row.status as "active" | "retired" };
  });
}
