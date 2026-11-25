import { base64urlBytes } from "contracts/wire";
import { AMK_WRAPPER_BYTES, SIGNATURE_BYTES } from "radium-crypto";
import { z } from "zod";
import {
  ownedWorkspaceProcedure,
  publicProcedure,
  router,
  sessionProcedure,
  workspaceProcedure,
} from "../trpc/init";
import { myKeyStatus, setRecoveryWrapper } from "./account";
import {
  addChatKeyWraps,
  chatKeyInput,
  chatKeys,
  chatKeysSetupInput,
  MAX_REWRAP_PAGE,
  MAX_WRAPS,
  replaceWorkspaceWraps,
  rotateChatKey,
  setupChatKeys,
  signChatKey,
  signChatKeyInput,
  staleWorkspaceWraps,
  staleWrapCursorInput,
  wrapInput,
} from "./chat-keys";
import { offerDeviceRecovery, takeDeviceRecovery } from "./device-recovery";
import {
  acceptInvite,
  acceptPhrase,
  createInvite,
  createInviteInput,
  dismissJoinRequest,
  getInvite,
  joinInput,
  removePhrase,
  requestKeys,
  revokeInvite,
  setPhrase,
  setPhraseInput,
} from "./invites";
import { legacyStorageInput, legacyStorageUrl } from "./legacy-storage";
import {
  getTrustStore,
  identityKeys,
  identityKeysByKeyId,
  identityNames,
  MAX_DIRECTORY_IDS,
  MAX_TRUST_STORE_BYTES,
  saveTrustStore,
} from "./trust-store";
import {
  createWorkerPairing,
  createWorkerPairingInput,
  workerKeys,
  workerPairings,
} from "./worker-keys";
import {
  addGrants,
  bootstrapWorkspaceKeys,
  grantInput,
  MAX_GRANTS,
  publishRoster,
  rosterInput,
  rotateWorkspaceEpoch,
  workspaceArchivedEpochs,
  workspaceKeyState,
  workspaceKeysInput,
} from "./workspace-keys";

const idInput = z.string().min(1).max(256);
const keyIdInput = z.string().max(32);
const slotIdInput = z.string().max(64);
const chatInput = z.object({ chatId: idInput });

/**
 * Convex `api.e2ee.*` for browsers (`docs/E2EE.md`): account keys, device recovery, the trust
 * store and public-key directory, workspace key epochs, grants, rosters and admission, chat keys,
 * and Worker pairing. Bytes are unpadded base64url both ways; every key refusal is
 * `E2EE_KEYS_INVALID`. Worker-machine reads and writes come with the Worker router.
 */
export const e2eeRouter = router({
  /** Account key status of the caller (`state: "none"` before keys exist). */
  myKeyStatus: sessionProcedure.query(({ ctx }) =>
    myKeyStatus(ctx.runtime.drivers.db, ctx.user.id),
  ),
  /** Replaces the recovery wrapper, signed by the active identity over the previous one. */
  setRecoveryWrapper: sessionProcedure
    .input(
      z.object({
        keyId: keyIdInput,
        recoveryWrapper: base64urlBytes(AMK_WRAPPER_BYTES),
        signature: base64urlBytes(SIGNATURE_BYTES),
      }),
    )
    .mutation(({ ctx, input }) => setRecoveryWrapper(ctx.runtime.drivers.db, ctx.user.id, input)),
  /** The unlocked device offers its wrapped AMK for one slot, for 15 minutes. */
  offerDeviceRecovery: sessionProcedure
    .input(z.object({ slotId: slotIdInput, sealedAmk: base64urlBytes(AMK_WRAPPER_BYTES) }))
    .mutation(({ ctx, input }) => offerDeviceRecovery(ctx.runtime.drivers.kv, ctx.user.id, input)),
  /** No session: the resetting page takes an offer once by its unguessable slot id. */
  takeDeviceRecovery: publicProcedure
    .input(z.object({ slotId: slotIdInput }))
    .mutation(async ({ ctx, input }) =>
      takeDeviceRecovery(
        ctx.runtime.drivers.kv,
        (await ctx.clientAddress?.()) ?? null,
        input.slotId,
      ),
    ),

  getTrustStore: sessionProcedure.query(({ ctx }) =>
    getTrustStore(ctx.runtime.drivers.db, ctx.user.id),
  ),
  /** Compare-and-swap; a stale writer gets `CONFLICT` `TRUST_STORE_CONFLICT`. */
  saveTrustStore: sessionProcedure
    .input(
      z.object({
        expectedVersion: z.number().int().nullable(),
        version: z.number().int(),
        envelope: base64urlBytes(MAX_TRUST_STORE_BYTES),
      }),
    )
    .mutation(({ ctx, input }) => saveTrustStore(ctx.runtime.drivers.db, ctx.user.id, input)),
  identityKeys: sessionProcedure
    .input(z.object({ userIds: z.array(idInput).max(MAX_DIRECTORY_IDS) }))
    .query(({ ctx, input }) => identityKeys(ctx.runtime.drivers.db, ctx.user.id, input.userIds)),
  identityNames: sessionProcedure
    .input(z.object({ userIds: z.array(idInput).max(MAX_DIRECTORY_IDS) }))
    .query(({ ctx, input }) => identityNames(ctx.runtime.drivers.db, ctx.user.id, input.userIds)),
  identityKeysByKeyId: sessionProcedure
    .input(
      z.object({
        keyIds: z.array(keyIdInput).max(MAX_DIRECTORY_IDS),
        chatEpoch: z.object({ chatId: idInput, epoch: z.number().int() }).optional(),
      }),
    )
    .query(({ ctx, input }) => identityKeysByKeyId(ctx.runtime.drivers.db, ctx.user.id, input)),

  workspaceKeyState: workspaceProcedure.query(({ ctx }) =>
    workspaceKeyState(ctx.runtime.drivers.db, ctx.access, ctx.user.id),
  ),
  workspaceArchivedEpochs: workspaceProcedure
    .input(z.object({ fromEpoch: z.number().int(), toEpoch: z.number().int() }))
    .query(({ ctx, input }) =>
      workspaceArchivedEpochs(ctx.runtime.drivers.db, ctx.access.workspace, ctx.user.id, input),
    ),
  bootstrapWorkspaceKeys: ownedWorkspaceProcedure
    .input(workspaceKeysInput)
    .mutation(({ ctx, input: { workspace, ...keys } }) =>
      bootstrapWorkspaceKeys(ctx.runtime.drivers.db, workspace, ctx.user.id, keys),
    ),
  rotateWorkspaceEpoch: ownedWorkspaceProcedure
    .input(workspaceKeysInput)
    .mutation(({ ctx, input: { workspace, ...keys } }) =>
      rotateWorkspaceEpoch(ctx.runtime.drivers.db, workspace, ctx.user.id, keys),
    ),
  addGrants: workspaceProcedure
    .input(z.object({ grants: z.array(grantInput).max(MAX_GRANTS) }))
    .mutation(({ ctx, input }) =>
      addGrants(ctx.runtime.drivers.db, input.workspace, ctx.user.id, input.grants),
    ),
  publishRoster: ownedWorkspaceProcedure
    .input(z.object({ roster: rosterInput }))
    .mutation(({ ctx, input }) =>
      publishRoster(ctx.runtime.drivers.db, input.workspace, ctx.user.id, input.roster),
    ),

  createInvite: ownedWorkspaceProcedure
    .input(createInviteInput)
    .mutation(({ ctx, input: { workspace, ...invite } }) =>
      createInvite(ctx.runtime.drivers.db, workspace, ctx.user.id, invite),
    ),
  /** The invite's payload for its intended account only; `null` otherwise. */
  getInvite: sessionProcedure
    .input(z.object({ inviteId: keyIdInput }))
    .query(({ ctx, input }) => getInvite(ctx.runtime.drivers.db, ctx.user.id, input.inviteId)),
  acceptInvite: sessionProcedure
    .input(joinInput.extend({ inviteId: keyIdInput }))
    .mutation(({ ctx, input }) => acceptInvite(ctx.runtime.drivers.db, ctx.user.id, input)),
  revokeInvite: ownedWorkspaceProcedure
    .input(z.object({ inviteId: keyIdInput }))
    .mutation(({ ctx, input }) =>
      revokeInvite(ctx.runtime.drivers.db, input.workspace, input.inviteId),
    ),
  setPhrase: ownedWorkspaceProcedure
    .input(setPhraseInput)
    .mutation(({ ctx, input: { workspace, ...phrase } }) =>
      setPhrase(ctx.runtime.drivers.db, workspace, ctx.user.id, phrase),
    ),
  removePhrase: ownedWorkspaceProcedure.mutation(({ ctx, input }) =>
    removePhrase(ctx.runtime.drivers.db, input.workspace),
  ),
  acceptPhrase: workspaceProcedure
    .input(joinInput)
    .mutation(({ ctx, input: { workspace, ...join } }) =>
      acceptPhrase(ctx.runtime.drivers.db, workspace, ctx.user.id, join),
    ),
  requestKeys: workspaceProcedure
    .input(z.object({ keyId: keyIdInput }))
    .mutation(({ ctx, input }) =>
      requestKeys(ctx.runtime.drivers.db, input.workspace, ctx.user.id, input.keyId),
    ),
  dismissJoinRequest: ownedWorkspaceProcedure
    .input(z.object({ requestId: idInput }))
    .mutation(({ ctx, input }) =>
      dismissJoinRequest(ctx.runtime.drivers.db, input.workspace, input.requestId),
    ),

  chatKeys: sessionProcedure
    .input(chatInput.extend({ epoch: z.number().int().optional() }))
    .query(({ ctx, input }) => chatKeys(ctx.runtime.drivers.db, ctx.user.id, input)),
  setupChatKeys: sessionProcedure
    .input(chatInput.extend({ keys: chatKeysSetupInput }))
    .mutation(({ ctx, input }) => setupChatKeys(ctx.runtime.drivers.db, ctx.user.id, input)),
  rotateChatKey: sessionProcedure
    .input(chatInput.extend({ epoch: chatKeyInput, wraps: z.array(wrapInput).max(MAX_WRAPS) }))
    .mutation(({ ctx, input }) => rotateChatKey(ctx.runtime.drivers.db, ctx.user.id, input)),
  addChatKeyWraps: sessionProcedure
    .input(chatInput.extend({ wraps: z.array(wrapInput).max(MAX_WRAPS) }))
    .mutation(({ ctx, input }) => addChatKeyWraps(ctx.runtime.drivers.db, ctx.user.id, input)),
  signChatKey: sessionProcedure
    .input(signChatKeyInput.extend({ chatId: idInput }))
    .mutation(({ ctx, input }) => signChatKey(ctx.runtime.drivers.db, ctx.user.id, input)),
  staleWorkspaceWraps: ownedWorkspaceProcedure
    .input(
      z.object({
        cursor: staleWrapCursorInput.nullish(),
        limit: z.number().int().min(1).max(MAX_REWRAP_PAGE).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      staleWorkspaceWraps(ctx.runtime.drivers.db, ctx.access.workspace, input),
    ),
  replaceWorkspaceWraps: ownedWorkspaceProcedure
    .input(
      z.object({
        replacements: z.array(z.object({ oldWrap: idInput, wrap: wrapInput })).max(MAX_REWRAP_PAGE),
      }),
    )
    .mutation(({ ctx, input }) =>
      replaceWorkspaceWraps(
        ctx.runtime.drivers.db,
        input.workspace,
        ctx.user.id,
        input.replacements,
      ),
    ),

  createWorkerPairing: ownedWorkspaceProcedure
    .input(createWorkerPairingInput)
    .mutation(({ ctx, input: { workspace, ...pairing } }) =>
      createWorkerPairing(ctx.runtime.drivers.db, workspace, ctx.user.id, pairing),
    ),
  workerPairings: ownedWorkspaceProcedure.query(({ ctx }) =>
    workerPairings(ctx.runtime.drivers.db, ctx.access.workspace),
  ),
  workerKeys: workspaceProcedure.query(({ ctx }) =>
    workerKeys(ctx.runtime.drivers.db, ctx.access.workspace),
  ),

  /**
   * Download URL of a historical box's envelope kept in the object store (`storageId`): a
   * presigned GET, or the same-origin `/api/files/legacy?table&record` route on local disk;
   * `null` when the box is inline. Authorized like the source row itself.
   */
  legacyStorageUrl: sessionProcedure
    .input(legacyStorageInput)
    .query(({ ctx, input }) => legacyStorageUrl(ctx.runtime, ctx.user.id, input)),
});
