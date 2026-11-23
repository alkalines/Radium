import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import { base64urlBytes } from "contracts/wire";
import { toBase64Url } from "radium-crypto";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { workspaceAccess } from "../workspaces/access";
import { workspaceUserIds, type Workspace } from "../workspaces/workspaces";
import { e2eeInvites, e2eeJoinRequests, e2eePhrases, e2eeWorkspaceGrants } from "./schema";
import {
  activeIdentity,
  grantInput,
  invalidKeys,
  lockWorkspaceKeys,
  requireBox,
  requireKeyId,
  storeGrant,
  type GrantInput,
} from "./workspace-keys";

/**
 * Workspace admission (`docs/E2EE/Keys.md`, "Access links", "Workspace key phrase", "Key
 * requests"): single-use access links for one intended member, the optional key phrase, and key
 * requests. Link secrets and phrases never reach the server; it stores their owner-sealed copies
 * and the joiner's MAC so the owner can check the proof before endorsing the joiner's self-grant.
 * Every refusal is `E2EE_KEYS_INVALID`.
 */

/** How long an access link stays usable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAC_BYTES = 32;
/** Link payloads, phrase wrappers and owner-sealed secrets: bounded boxes, as `requireBox`. */
const MAX_ADMISSION_BOX_BYTES = 65536;

const keyIdInput = z.string().max(32);

/** A joiner's proof of the link secret or phrase, with their signed self-grant. */
export const joinInput = z.object({
  keyId: keyIdInput,
  mac: base64urlBytes(MAC_BYTES),
  selfGrant: grantInput,
});

export const createInviteInput = z.object({
  inviteId: keyIdInput,
  invitedUserId: z.string().min(1).max(256),
  epoch: z.number().int(),
  sealed: base64urlBytes(MAX_ADMISSION_BOX_BYTES),
  ownerSecret: base64urlBytes(MAX_ADMISSION_BOX_BYTES),
});

export const setPhraseInput = z.object({
  epoch: z.number().int(),
  phraseId: keyIdInput,
  wrapper: base64urlBytes(MAX_ADMISSION_BOX_BYTES),
  ownerSecret: base64urlBytes(MAX_ADMISSION_BOX_BYTES),
});

type JoinInput = { keyId: string; mac: Uint8Array; selfGrant: GrantInput };
type JoinProof = {
  source: "invite" | "phrase";
  ownerSecret: Uint8Array;
  epoch: number;
  sourceId: string;
};

/**
 * Stores a joiner's self-grant of the current member key and their admission proof (one per
 * identity; a newer proof replaces it), for the owner to verify and endorse. The proof secrets stay
 * sealed to the owner key. The caller holds the workspace lock.
 */
async function join(
  tx: Database,
  workspace: Workspace,
  userId: string,
  input: JoinInput,
  proof: JoinProof,
): Promise<void> {
  requireKeyId(input.keyId);
  const identity = await activeIdentity(tx, userId);
  const { selfGrant } = input;
  if (
    !identity ||
    identity.keyId !== input.keyId ||
    input.mac.byteLength !== MAC_BYTES ||
    selfGrant.userId !== userId ||
    selfGrant.recipientKeyId !== input.keyId ||
    selfGrant.granterKeyId !== input.keyId ||
    selfGrant.purpose !== "member" ||
    selfGrant.epoch !== proof.epoch ||
    proof.epoch !== workspace.keyEpoch
  ) {
    invalidKeys();
  }
  await storeGrant(tx, workspace, selfGrant, userId, true);
  const row = { mac: input.mac, ...proof, createdAt: new Date() };
  await tx
    .insert(e2eeJoinRequests)
    .values({ workspace: workspace.id, userId, keyId: input.keyId, ...row })
    .onConflictDoUpdate({
      target: [e2eeJoinRequests.workspace, e2eeJoinRequests.userId, e2eeJoinRequests.keyId],
      set: row,
    });
}

/**
 * Creates a seven-day single-use access link for an existing member at the current epoch. A
 * pending link for the same member and expired links of the workspace are replaced.
 */
export async function createInvite(
  db: Database,
  workspaceId: string,
  userId: string,
  input: z.output<typeof createInviteInput>,
): Promise<void> {
  requireKeyId(input.inviteId);
  requireBox(input.sealed);
  requireBox(input.ownerSecret);
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, true);
    if (
      !workspace.keyEpoch ||
      input.epoch !== workspace.keyEpoch ||
      input.invitedUserId === workspace.ownerId ||
      !(await workspaceUserIds(tx, workspace)).includes(input.invitedUserId)
    ) {
      invalidKeys();
    }
    const [taken] = await tx
      .select({ id: e2eeInvites.id })
      .from(e2eeInvites)
      .where(eq(e2eeInvites.inviteId, input.inviteId));
    if (taken) {
      invalidKeys();
    }
    await tx
      .delete(e2eeInvites)
      .where(
        and(
          eq(e2eeInvites.workspace, workspace.id),
          or(
            eq(e2eeInvites.invitedUserId, input.invitedUserId),
            lte(e2eeInvites.expiresAt, new Date()),
          ),
        ),
      );
    // Invite ids are global; another workspace may race for the same random id.
    const inserted = await tx
      .insert(e2eeInvites)
      .values({
        workspace: workspace.id,
        ...input,
        createdBy: workspace.ownerId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .onConflictDoNothing({ target: e2eeInvites.inviteId })
      .returning({ id: e2eeInvites.id });
    if (inserted.length === 0) {
      invalidKeys();
    }
  });
}

async function findInvite(db: Database, inviteId: string) {
  const [invite] = await db.select().from(e2eeInvites).where(eq(e2eeInvites.inviteId, inviteId));
  return invite;
}

/**
 * An unexpired link's payload, only for its intended account while that account can access the
 * workspace and the link's epoch is current; `null` otherwise, alike for every reason.
 */
export async function getInvite(db: Database, userId: string, inviteId: string) {
  requireKeyId(inviteId);
  const invite = await findInvite(db, inviteId);
  if (!invite || invite.invitedUserId !== userId || invite.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  const access = await workspaceAccess(db, userId, invite.workspace);
  if (!access || access.workspace.keyEpoch !== invite.epoch) {
    return null;
  }
  return {
    workspace: invite.workspace,
    epoch: invite.epoch,
    sealed: toBase64Url(invite.sealed),
    expiresAt: invite.expiresAt.getTime(),
    ownerId: access.workspace.ownerId,
  };
}

/**
 * Consumes a link exactly once, by its intended account before it expires, and stores the
 * joiner's self-grant and proof. The link is claimed with one conditional delete under the
 * workspace lock, so of two concurrent accepts exactly one succeeds; a refused join rolls the
 * claim back.
 */
export async function acceptInvite(
  db: Database,
  userId: string,
  input: JoinInput & { inviteId: string },
): Promise<void> {
  requireKeyId(input.inviteId);
  const invite = await findInvite(db, input.inviteId);
  if (!invite || invite.invitedUserId !== userId) {
    invalidKeys();
  }
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, invite.workspace, userId, false);
    const [claimed] = await tx
      .delete(e2eeInvites)
      .where(
        and(
          eq(e2eeInvites.id, invite.id),
          eq(e2eeInvites.invitedUserId, userId),
          gt(e2eeInvites.expiresAt, sql`now()`),
        ),
      )
      .returning();
    if (!claimed) {
      invalidKeys();
    }
    await join(tx, workspace, userId, input, {
      source: "invite",
      ownerSecret: claimed.ownerSecret,
      epoch: claimed.epoch,
      sourceId: claimed.inviteId,
    });
  });
}

/** Revokes a pending link of an owned workspace; unknown links are a no-op. */
export async function revokeInvite(db: Database, workspaceId: string, inviteId: string) {
  requireKeyId(inviteId);
  await db
    .delete(e2eeInvites)
    .where(and(eq(e2eeInvites.workspace, workspaceId), eq(e2eeInvites.inviteId, inviteId)));
}

/** Replaces the current epoch's optional key-phrase wrapper. */
export async function setPhrase(
  db: Database,
  workspaceId: string,
  userId: string,
  input: z.output<typeof setPhraseInput>,
): Promise<void> {
  requireKeyId(input.phraseId);
  requireBox(input.wrapper);
  requireBox(input.ownerSecret);
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, true);
    if (!workspace.keyEpoch || input.epoch !== workspace.keyEpoch) {
      invalidKeys();
    }
    const row = {
      phraseId: input.phraseId,
      wrapper: input.wrapper,
      ownerSecret: input.ownerSecret,
      createdBy: workspace.ownerId,
      createdAt: new Date(),
    };
    await tx
      .insert(e2eePhrases)
      .values({ workspace: workspace.id, epoch: input.epoch, ...row })
      .onConflictDoUpdate({ target: [e2eePhrases.workspace, e2eePhrases.epoch], set: row });
  });
}

/** Removes every phrase wrapper of an owned workspace; grants stay. */
export async function removePhrase(db: Database, workspaceId: string): Promise<void> {
  await db.delete(e2eePhrases).where(eq(e2eePhrases.workspace, workspaceId));
}

/** Accepts the current phrase as a workspace user, pending the owner's check of the MAC. */
export async function acceptPhrase(
  db: Database,
  workspaceId: string,
  userId: string,
  input: JoinInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, false);
    const [phrase] = await tx
      .select()
      .from(e2eePhrases)
      .where(
        and(
          eq(e2eePhrases.workspace, workspace.id),
          eq(e2eePhrases.epoch, workspace.keyEpoch ?? 0),
        ),
      );
    if (!phrase) {
      invalidKeys();
    }
    await join(tx, workspace, userId, input, {
      source: "phrase",
      ownerSecret: phrase.ownerSecret,
      epoch: phrase.epoch,
      sourceId: phrase.phraseId,
    });
  });
}

/**
 * Asks for a grant of the current member key to the caller's active identity. Idempotent: nothing
 * happens when the owner already granted it or the same identity already asked; otherwise the
 * caller's older requests are replaced.
 */
export async function requestKeys(
  db: Database,
  workspaceId: string,
  userId: string,
  keyId: string,
): Promise<void> {
  requireKeyId(keyId);
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, false);
    const identity = await activeIdentity(tx, userId);
    if (!identity || identity.keyId !== keyId || !workspace.keyEpoch) {
      invalidKeys();
    }
    const [granted] = await tx
      .select({ id: e2eeWorkspaceGrants.id })
      .from(e2eeWorkspaceGrants)
      .where(
        and(
          eq(e2eeWorkspaceGrants.workspace, workspace.id),
          eq(e2eeWorkspaceGrants.userId, userId),
          eq(e2eeWorkspaceGrants.epoch, workspace.keyEpoch),
          eq(e2eeWorkspaceGrants.purpose, "member"),
          eq(e2eeWorkspaceGrants.recipientKeyId, keyId),
          eq(e2eeWorkspaceGrants.granterUserId, workspace.ownerId),
        ),
      );
    if (granted) {
      return;
    }
    const mine = and(
      eq(e2eeJoinRequests.workspace, workspace.id),
      eq(e2eeJoinRequests.userId, userId),
    );
    const [asked] = await tx
      .select({ id: e2eeJoinRequests.id })
      .from(e2eeJoinRequests)
      .where(and(mine, eq(e2eeJoinRequests.keyId, keyId)));
    if (asked) {
      return;
    }
    await tx.delete(e2eeJoinRequests).where(mine);
    await tx
      .insert(e2eeJoinRequests)
      .values({ workspace: workspace.id, userId, keyId, source: "request" });
  });
}

/** Denies one join request of an owned workspace, leaving every grant intact. */
export async function dismissJoinRequest(db: Database, workspaceId: string, requestId: string) {
  await db
    .delete(e2eeJoinRequests)
    .where(and(eq(e2eeJoinRequests.workspace, workspaceId), eq(e2eeJoinRequests.id, requestId)));
}

/** Retention: deletes up to `batch` expired access links. */
export async function pruneExpiredInvites(db: Database, now: number, batch: number) {
  const deleted = await db
    .delete(e2eeInvites)
    .where(
      sql`${e2eeInvites.id} in (select ${e2eeInvites.id} from ${e2eeInvites} where ${e2eeInvites.expiresAt} <= ${new Date(now)} limit ${batch})`,
    )
    .returning({ id: e2eeInvites.id });
  return deleted.length;
}
