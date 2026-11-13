import { describe, expect, test } from "bun:test";
import {
  chatKeyStatement,
  createAccountKeys,
  fingerprint,
  generateEncryptionKeyPair,
  grantStatement,
  randomBytes,
  sealBox,
  sign,
  toBase64Url,
} from "radium-crypto";
import {
  openTrustStore,
  sealTrustStore,
  type PublicIdentity,
  type TrustStore,
} from "./trust-store";
import {
  joinMac,
  openInvitePayload,
  openWorkspaceGrant,
  sealInvitePayload,
  signRoster,
  verifyRoster,
  type WorkspaceRoster,
} from "./workspace-proofs";
import { verifyChatEpoch } from "./chat-keys";

async function account(userId: string) {
  const keys = await createAccountKeys();
  const identity: PublicIdentity = {
    userId,
    keyId: toBase64Url(keys.identity.keyId),
    suite: keys.identity.suite,
    encryptionPublicKey: keys.identity.encryption.publicKey,
    signingPublicKey: keys.identity.signing.publicKey,
    fingerprint: await fingerprint({
      encryptionPublicKey: keys.identity.encryption.publicKey,
      signingPublicKey: keys.identity.signing.publicKey,
    }),
  };
  return { ...keys, public: identity };
}
const id = () => toBase64Url(randomBytes(16));

describe("workspace trust boundaries", () => {
  test("trust store seal/open round trip and rollback refusal", async () => {
    const own = await account("me");
    const store: TrustStore = {
      v: 1,
      version: 2,
      pins: {
        friend: { keyId: id(), fingerprint: "fingerprint", state: "verified", updatedAt: 1 },
      },
    };
    const envelope = await sealTrustStore({
      amk: own.amk,
      keyId: own.public.keyId,
      userId: "me",
      store,
    });
    const input = {
      amk: own.amk,
      keyId: own.public.keyId,
      userId: "me",
      version: 2,
      envelope,
      highWater: 2,
    };
    expect(await openTrustStore(input)).toEqual(store);
    expect(openTrustStore({ ...input, highWater: 3 })).rejects.toThrow("rollback");
  });

  test("roster verifies only its original body and owner signer", async () => {
    const own = await account("owner");
    const stranger = await account("stranger");
    const body: WorkspaceRoster = {
      v: 1,
      workspace: "workspace",
      version: 1,
      epoch: 1,
      owner: {
        userId: own.public.userId,
        keyId: own.public.keyId,
        fingerprint: own.public.fingerprint,
      },
      epochs: [
        {
          epoch: 1,
          memberKeyId: id(),
          memberKeyHash: toBase64Url(randomBytes(32)),
          ownerKeyId: id(),
          ownerKeyHash: toBase64Url(randomBytes(32)),
        },
      ],
      members: [],
    };
    const signed = await signRoster(body, own.identity.signing.seed);
    const input = { ...signed, workspaceId: "workspace", owner: own.public, highWater: 0 };
    expect(await verifyRoster(input)).toEqual(body);
    const tampered = signed.body.slice();
    tampered[10] ^= 1;
    expect(verifyRoster({ ...input, body: tampered })).rejects.toThrow();
    expect(verifyRoster({ ...input, owner: stranger.public })).rejects.toThrow();
  });

  test("a correctly signed grant cannot substitute a seed outside the owner roster", async () => {
    const own = await account("owner");
    const seed = randomBytes(32);
    const different = await generateEncryptionKeyPair();
    const recipientKeyId = own.public.keyId;
    const sealed = await sealBox({
      recipientPublicKey: own.public.encryptionPublicKey,
      plaintext: seed,
      aad: {
        table: "e2ee_workspace_grants",
        workspace: "workspace",
        parent: "owner",
        record: "1:member",
        field: recipientKeyId,
      },
      pad: "none",
    });
    const signature = await sign(
      own.identity.signing.seed,
      grantStatement({
        workspaceId: "workspace",
        epoch: 1,
        purpose: "member",
        recipientUserId: "owner",
        recipientKeyId,
        sealed,
      }),
    );
    expect(
      openWorkspaceGrant({
        workspaceId: "workspace",
        epoch: 1,
        purpose: "member",
        userId: "owner",
        recipientKeyId,
        sealed,
        signature,
        granter: own.public,
        recipientSeed: own.identity.encryption.seed,
        epochPublicKey: different.publicKey,
        rosterKeyHash: toBase64Url(randomBytes(32)),
      }),
    ).rejects.toThrow();
  });

  test("invite payload and identity MAC round trip; wrong secret fails", async () => {
    const own = await account("owner");
    const inviteId = id();
    const secret = randomBytes(32);
    const payload = {
      v: 1 as const,
      workspace: "workspace",
      epoch: 1,
      memberSeed: toBase64Url(randomBytes(32)),
      owner: { userId: "owner", keyId: own.public.keyId, fingerprint: own.public.fingerprint },
    };
    const sealed = await sealInvitePayload({
      secret,
      id: inviteId,
      payload,
      invitedUserId: "member",
    });
    const input = {
      secret,
      id: inviteId,
      workspaceId: "workspace",
      epoch: 1,
      invitedUserId: "member",
      sealed,
    };
    expect(await openInvitePayload(input)).toEqual(payload);
    expect(openInvitePayload({ ...input, secret: randomBytes(32) })).rejects.toThrow();
    const mac = await joinMac({ secret, workspaceId: "workspace", identity: own.public });
    expect(await joinMac({ secret, workspaceId: "workspace", identity: own.public })).toEqual(mac);
    expect(
      await joinMac({ secret: randomBytes(32), workspaceId: "workspace", identity: own.public }),
    ).not.toEqual(mac);
  });

  test("chat key open verifier rejects a modified signature", async () => {
    const own = await account("owner");
    const chat = await generateEncryptionKeyPair();
    const input = {
      workspaceId: "workspace",
      e2eeId: id(),
      epoch: 1,
      keyId: id(),
      suite: chat.suite,
      publicKey: chat.publicKey,
      signingPublicKey: own.public.signingPublicKey,
    };
    const signature = await sign(
      own.identity.signing.seed,
      chatKeyStatement({
        workspaceId: input.workspaceId,
        chatE2eeId: input.e2eeId,
        epoch: 1,
        keyId: input.keyId,
        suite: input.suite,
        publicKey: input.publicKey,
      }),
    );
    await verifyChatEpoch({ ...input, signature });
    signature[0] ^= 1;
    expect(verifyChatEpoch({ ...input, signature })).rejects.toThrow();
  });
});
