import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installFakeTrpc } from "./test-trpc";
import {
  chatKeyStatement,
  createAccountKeys,
  EMPTY_ROSTER_ARCHIVE,
  extendRosterArchive,
  fingerprint,
  generateEncryptionKeyPair,
  grantStatement,
  identitySelfSignature,
  randomBytes,
  ROSTER_EPOCH_WINDOW,
  sealBox,
  sha256,
  sign,
  signRoster,
  toBase64Url,
  type RosterEpoch,
} from "radium-crypto";
import { keyManager } from "./key-manager";
import {
  openTrustStore,
  sealTrustStore,
  trust,
  type PublicIdentity,
  type TrustStore,
} from "./trust-store";
import {
  joinMac,
  openInvitePayload,
  openWorkspaceGrant,
  sealInvitePayload,
} from "./workspace-proofs";
import { verifyChatEpoch } from "./chat-keys";
import { advanceHighWater } from "./runtime";
import {
  getMemberKey,
  KeylessDowngradeError,
  keyedWorkspaceClaim,
  workspaceKnownKeyed,
} from "./workspace-keys";

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

describe("keyless downgrade", () => {
  test("a workspace this device verified as keyed refuses the server's keyless claim", () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => void values.set(name, value),
      },
    });
    try {
      // Never verified here: the server's answer stands either way.
      expect(workspaceKnownKeyed("ws")).toBe(false);
      expect(keyedWorkspaceClaim("ws", false)).toBe(false);
      expect(keyedWorkspaceClaim("ws", true)).toBe(true);

      // Roster verification leaves the device marker; from then on keyless is a downgrade.
      advanceHighWater("radium.e2ee.roster.v1:ws", 3);
      expect(workspaceKnownKeyed("ws")).toBe(true);
      expect(keyedWorkspaceClaim("ws", true)).toBe(true);
      expect(() => keyedWorkspaceClaim("ws", false)).toThrow(KeylessDowngradeError);
      // Other workspaces are unaffected.
      expect(keyedWorkspaceClaim("other", false)).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("archived workspace epochs", () => {
  afterEach(() => mock.restore());

  /**
   * A keyed workspace whose version-3 roster window no longer lists epochs 1..4, behind a fake
   * backend that serves archived rows with `prefix` as its claimed chain value: the real one,
   * none, or a wrong one. `tamper` substitutes the member key of one served archived row.
   */
  async function archivedWorkspace(input: {
    workspace: string;
    prefix: "stored" | "none" | "wrong";
    tamper?: number;
  }) {
    const workspace = input.workspace;
    const owner = await account("owner");
    const total = ROSTER_EPOCH_WINDOW + 4;
    const archivedEpoch = 2;
    const member = await generateEncryptionKeyPair();
    const rows: Array<{ epoch: number; memberPublicKey: string; [field: string]: unknown }> = [];
    const entries: RosterEpoch[] = [];
    for (let epoch = 1; epoch <= total; epoch++) {
      const memberPublicKey = epoch === archivedEpoch ? member.publicKey : randomBytes(1216);
      const ownerPublicKey = randomBytes(1216);
      const row = {
        id: `epoch-${epoch}`,
        workspace,
        epoch,
        suite: 1,
        memberKeyId: id(),
        memberPublicKey: toBase64Url(memberPublicKey),
        ownerKeyId: id(),
        ownerPublicKey: toBase64Url(ownerPublicKey),
        createdBy: "owner",
        rosterArchiveHash: null,
        createdAt: 1,
      };
      rows.push(row);
      entries.push({
        epoch,
        memberKeyId: row.memberKeyId,
        memberKeyHash: toBase64Url(await sha256(memberPublicKey)),
        ownerKeyId: row.ownerKeyId,
        ownerKeyHash: toBase64Url(await sha256(ownerPublicKey)),
      });
    }
    const roster = await signRoster(
      {
        workspace,
        version: 7,
        epoch: total,
        owner: { userId: "owner", keyId: owner.public.keyId, fingerprint: owner.public.fingerprint },
        archive: { ...EMPTY_ROSTER_ARCHIVE },
        epochs: entries,
        members: [],
        workers: [],
      },
      owner.identity.signing.seed,
    );
    const recipientKeyId = owner.public.keyId;
    const sealed = await sealBox({
      recipientPublicKey: owner.public.encryptionPublicKey,
      plaintext: member.seed,
      aad: {
        table: "e2ee_workspace_grants",
        workspace,
        parent: "owner",
        record: `${archivedEpoch}:member`,
        field: recipientKeyId,
      },
      pad: "none",
    });
    const statement = grantStatement({
      workspaceId: workspace,
      epoch: archivedEpoch,
      purpose: "member",
      recipientUserId: "owner",
      recipientKeyId,
      sealed,
    });
    const grant = {
      id: "grant",
      workspace,
      epoch: archivedEpoch,
      purpose: "member",
      userId: "owner",
      recipientKeyId,
      granterUserId: "owner",
      granterKeyId: owner.public.keyId,
      sealed: toBase64Url(sealed),
      signature: toBase64Url(await sign(owner.identity.signing.seed, statement)),
      createdAt: 1,
    };
    const selfSignature = await identitySelfSignature(owner.identity);
    const archivedFrom: number[] = [];

    spyOn(keyManager, "getSnapshot").mockImplementation(() => ({
      state: "unlocked",
      userId: "owner",
      keyId: owner.public.keyId,
      fingerprint: owner.public.fingerprint,
    }));
    spyOn(keyManager, "useAmk").mockImplementation(async (fn) => fn(owner.amk, owner.identity));
    spyOn(trust, "check").mockImplementation(async () => "self");
    installFakeTrpc({
      "e2ee.identityKeys": () => [
        {
          userId: "owner",
          keyId: owner.public.keyId,
          suite: owner.public.suite,
          encryptionPublicKey: toBase64Url(owner.public.encryptionPublicKey),
          signingPublicKey: toBase64Url(owner.public.signingPublicKey),
          selfSignature: toBase64Url(selfSignature),
        },
      ],
      "e2ee.workspaceKeyState": () => ({
        role: "owner",
        ownerId: "owner",
        keyEpoch: total,
        epochs: rows.slice(-ROSTER_EPOCH_WINDOW),
        roster: {
          id: "roster",
          workspace,
          version: roster.version,
          body: toBase64Url(roster.body),
          signature: toBase64Url(roster.signature),
          signerKeyId: roster.signerKeyId,
          createdAt: 1,
        },
        myGrants: [],
        members: [{ userId: "owner", role: "owner", keyId: recipientKeyId, grantedEpoch: null }],
        joinRequests: [],
        phrase: null,
        invites: [],
      }),
      "e2ee.workspaceArchivedEpochs": async ({
        fromEpoch,
        toEpoch,
      }: {
        fromEpoch: number;
        toEpoch: number;
      }) => {
        archivedFrom.push(fromEpoch);
        let prefixHash: string | null = null;
        if (fromEpoch > 1 && input.prefix === "stored") {
          prefixHash = (await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, entries.slice(0, fromEpoch - 1)))
            .hash;
        }
        if (fromEpoch > 1 && input.prefix === "wrong") prefixHash = toBase64Url(randomBytes(32));
        return {
          prefixHash,
          epochs: rows
            .filter((row) => row.epoch >= fromEpoch && row.epoch <= toEpoch)
            .map((row) =>
              row.epoch === input.tamper
                ? { ...row, memberPublicKey: toBase64Url(randomBytes(1216)) }
                : row,
            ),
          myGrants: grant.epoch >= fromEpoch && grant.epoch <= toEpoch ? [grant] : [],
        };
      },
    });
    return { workspace, member, archivedFrom };
  }

  test("opens an archived epoch after checking the served rows against the signed archive", async () => {
    const stored = await archivedWorkspace({ workspace: "archived-stored", prefix: "stored" });
    const key = await getMemberKey(stored.workspace, 2);
    expect(toBase64Url(key.seed)).toBe(toBase64Url(stored.member.seed));
    // The stored chain value lets the client read from the requested epoch, not from epoch 1.
    expect(stored.archivedFrom).toEqual([2]);

    const unknown = await archivedWorkspace({ workspace: "archived-none", prefix: "none" });
    expect(toBase64Url((await getMemberKey(unknown.workspace, 2)).seed)).toBe(
      toBase64Url(unknown.member.seed),
    );
    expect(unknown.archivedFrom).toEqual([2, 1]);
  });

  test("refuses an archived epoch when a served row or the claimed prefix was substituted", async () => {
    const tampered = await archivedWorkspace({
      workspace: "archived-tampered",
      prefix: "stored",
      tamper: 3,
    });
    await expect(getMemberKey(tampered.workspace, 2)).rejects.toThrow(
      "Archived roster epochs differ from roster",
    );

    const wrong = await archivedWorkspace({ workspace: "archived-wrong", prefix: "wrong" });
    await expect(getMemberKey(wrong.workspace, 2)).rejects.toThrow(
      "Archived roster epochs differ from roster",
    );
  });
});
