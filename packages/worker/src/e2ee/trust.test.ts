import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_ROSTER_ARCHIVE,
  fingerprint,
  identitySelfSignature,
  randomBytes,
  ROSTER_EPOCH_WINDOW,
  sha256,
  sign,
  signingPublicKeyFromSeed,
  signRoster,
  toBase64Url,
  type RosterMember,
  type RosterWorker,
} from "radium-crypto";
import type { WorkerState } from "../auth/state.js";
import { parsePairingCode, parseSetupCode, WorkerProtocolError } from "../protocol.js";
import {
  WorkerTrust,
  WorkerTrustError,
  type WorkerTrustIdentity,
  type WorkerTrustState,
} from "./trust.js";

const now = Date.UTC(2026, 10, 13);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function encode(prefix: string, value: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

async function user(userId: string) {
  const seed = randomBytes(32);
  const keyId = randomBytes(16);
  const encryptionPublicKey = randomBytes(1216);
  const signingPublicKey = await signingPublicKeyFromSeed(seed);
  const selfSignature = await identitySelfSignature({
    keyId,
    suite: 1,
    encryption: { suite: 1, publicKey: encryptionPublicKey, seed: randomBytes(32) },
    signing: { suite: 1, publicKey: signingPublicKey, seed },
  });
  const binding: RosterMember = {
    userId,
    keyId: toBase64Url(keyId),
    fingerprint: await fingerprint({ encryptionPublicKey, signingPublicKey }),
  };
  const row: WorkerTrustIdentity = {
    userId,
    keyId: binding.keyId,
    suite: 1,
    encryptionPublicKey: encryptionPublicKey.slice().buffer,
    signingPublicKey: signingPublicKey.slice().buffer,
    selfSignature: selfSignature.slice().buffer,
    status: "active",
  };
  return { seed, signingPublicKey, binding, row };
}

const owner = await user("owner");

function ownerPin(identity = owner) {
  return {
    ...identity.binding,
    signingPublicKey: toBase64Url(identity.signingPublicKey),
  };
}

describe("setup and pairing codes", () => {
  const pairing = {
    pairingId: toBase64Url(randomBytes(16)),
    secret: toBase64Url(randomBytes(32)),
    owner: ownerPin(),
  };
  const v2 = {
    version: 2,
    backendUrl: "https://radium.example.convex.site",
    convexUrl: "https://radium.example.convex.cloud",
    enrollmentId: "enrollment",
    token: toBase64Url(randomBytes(32)),
    expiresAt: now + 60_000,
    ...pairing,
  };
  const pair = {
    version: 1,
    workspaceId: "workspace",
    workerId: "worker",
    ...pairing,
    expiresAt: now + 60_000,
  };

  it("accepts exact v2 setup and pairing codes and keeps the secret out of stored setup", () => {
    const setup = parseSetupCode(encode("radium-worker-v2.", v2), now);
    expect(setup.version).toBe(2);
    expect(setup.pairing?.owner).toEqual(pairing.owner);
    expect(setup.pairing?.secret).toHaveLength(32);
    expect(parsePairingCode(encode("radium-worker-pair-v1.", pair), now).workerId).toBe("worker");
  });

  it("refuses codes with keys that do not belong to their version or malformed pairing data", () => {
    const { pairingId: _pairingId, secret: _secret, owner: _owner, ...v1Fields } = v2;
    const cases: [string, unknown][] = [
      // v1 code carrying pairing material, v2 code without it, v2 data under the v1 prefix.
      ["radium-worker-v1.", { ...v1Fields, version: 1, secret: pairing.secret }],
      ["radium-worker-v2.", { ...v1Fields, version: 2 }],
      ["radium-worker-v1.", v2],
      ["radium-worker-v2.", { ...v2, extra: true }],
      ["radium-worker-v2.", { ...v2, secret: toBase64Url(randomBytes(16)) }],
      ["radium-worker-v2.", { ...v2, owner: { ...pairing.owner, signingPublicKey: "AA" } }],
      ["radium-worker-v2.", { ...v2, owner: { ...pairing.owner, extra: 1 } }],
      ["radium-worker-v2.", { ...v2, expiresAt: now }],
    ];
    for (const [prefix, value] of cases) {
      expect(() => parseSetupCode(encode(prefix, value), now)).toThrow(WorkerProtocolError);
    }
    for (const value of [
      { ...pair, token: v2.token },
      { ...pair, version: 2 },
      { ...pair, pairingId: "short" },
      { ...pair, expiresAt: now - 1 },
    ]) {
      expect(() => parsePairingCode(encode("radium-worker-pair-v1.", value), now)).toThrow(
        WorkerProtocolError,
      );
    }
    expect(() => parsePairingCode(encode("radium-worker-v2.", v2), now)).toThrow(
      WorkerProtocolError,
    );
  });
});

describe("WorkerTrust", () => {
  const workspaceId = "workspace";
  const workerId = "worker";

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), "radium-trust-"));
    directories.push(directory);
    const signingSeed = randomBytes(32);
    const encryptionPublicKey = randomBytes(1216);
    const signingPublicKey = await signingPublicKeyFromSeed(signingSeed);
    const self: RosterWorker = {
      workerId,
      keyId: toBase64Url(randomBytes(16)),
      fingerprint: await fingerprint({ encryptionPublicKey, signingPublicKey }),
    };
    const state = {
      identity: { workerId, workspaceId, keyId: "machine", identityEpoch: 1 },
      e2ee: {
        keyId: self.keyId,
        suite: 1,
        encryptionPublicKey: toBase64Url(encryptionPublicKey),
        signingPublicKey: toBase64Url(signingPublicKey),
        owner: ownerPin(),
        encryptionSeed: randomBytes(32),
        signingSeed,
      },
    } as WorkerState;
    const served: { state: WorkerTrustState; identities: WorkerTrustIdentity[] } = {
      state: { roster: null, epochs: [] },
      identities: [owner.row],
    };
    const transport = {
      trustState: async () => served.state,
      identities: async (keyIds: string[]) =>
        keyIds.map((keyId) => served.identities.find((row) => row.keyId === keyId) ?? null),
      close: () => undefined,
    };
    const open = async () =>
      (await WorkerTrust.open({ stateDirectory: directory, state, transport: () => transport }))!;
    return { served, self, open };
  }

  async function serve(
    served: { state: WorkerTrustState },
    input: {
      version: number;
      workers: RosterWorker[];
      members?: RosterMember[];
      signer?: Awaited<ReturnType<typeof user>>;
    },
  ) {
    const signer = input.signer ?? owner;
    const signed = await signRoster(
      {
        workspace: workspaceId,
        version: input.version,
        epoch: 1,
        owner: signer.binding,
        archive: { ...EMPTY_ROSTER_ARCHIVE },
        epochs: [
          {
            epoch: 1,
            memberKeyId: toBase64Url(randomBytes(16)),
            memberKeyHash: toBase64Url(randomBytes(32)),
            ownerKeyId: toBase64Url(randomBytes(16)),
            ownerKeyHash: toBase64Url(randomBytes(32)),
          },
        ],
        members: input.members ?? [],
        workers: input.workers,
      },
      signer.seed,
    );
    served.state = {
      roster: {
        version: signed.version,
        body: signed.body.slice().buffer,
        signature: signed.signature.slice().buffer,
        signerKeyId: signed.signerKeyId,
      },
      epochs: [],
    };
  }

  async function reason(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkerTrustError);
    return (error as WorkerTrustError).reason;
  }

  it("refuses rosters signed by another key, rollbacks across restarts, and dropped Workers", async () => {
    const { served, self, open } = await setup();
    const trust = await open();

    await serve(served, { version: 2, workers: [self] });
    expect((await trust.roster()).version).toBe(2);

    // A reset owner (new key) signs a roster naming itself: the pinned owner key no longer matches.
    const usurper = await user("owner");
    await serve(served, { version: 3, workers: [self], signer: usurper });
    expect(await reason(trust.roster())).toBe("owner_changed");

    // Right key ID, wrong signing key.
    await serve(served, {
      version: 3,
      workers: [self],
      signer: { ...usurper, binding: owner.binding },
    });
    expect(await reason(trust.roster())).toBe("invalid");

    await serve(served, { version: 1, workers: [self] });
    expect(await reason(trust.roster())).toBe("rollback");
    expect(await reason((await open()).roster())).toBe("rollback");

    await serve(served, {
      version: 3,
      workers: [{ ...self, keyId: toBase64Url(randomBytes(16)) }],
    });
    expect(await reason(trust.roster())).toBe("not_listed");
    await serve(served, { version: 4, workers: [] });
    expect(await reason(trust.roster())).toBe("not_listed");
    // Seeing a valid revocation must survive restart and prevent replay of an older certification.
    await serve(served, { version: 2, workers: [self] });
    expect(await reason(trust.roster())).toBe("rollback");
    expect(await reason((await open()).roster())).toBe("rollback");
  });

  it("refuses a different owner-signed roster at an already observed version", async () => {
    const { served, self, open } = await setup();
    const trust = await open();
    await serve(served, { version: 1, workers: [self] });
    await trust.roster();
    await serve(served, { version: 1, workers: [] });
    expect(await reason((await open()).roster())).toBe("invalid");
  });

  it("reads the current owner key from a roster whose older epochs left the window", async () => {
    const { served, self, open } = await setup();
    const trust = await open();
    const current = ROSTER_EPOCH_WINDOW + 8;
    const ownerPublicKey = randomBytes(1216);
    const row = {
      epoch: current,
      memberKeyId: toBase64Url(randomBytes(16)),
      memberPublicKey: randomBytes(1216),
      ownerKeyId: toBase64Url(randomBytes(16)),
      ownerPublicKey,
    };
    const epochs = Array.from({ length: current }, (_, index) => ({
      epoch: index + 1,
      memberKeyId: toBase64Url(randomBytes(16)),
      memberKeyHash: toBase64Url(randomBytes(32)),
      ownerKeyId: toBase64Url(randomBytes(16)),
      ownerKeyHash: toBase64Url(randomBytes(32)),
    }));
    epochs[current - 1] = {
      ...epochs[current - 1]!,
      ownerKeyId: row.ownerKeyId,
      ownerKeyHash: toBase64Url(await sha256(ownerPublicKey)),
    };
    const signed = await signRoster(
      {
        workspace: workspaceId,
        version: 5,
        epoch: current,
        owner: owner.binding,
        archive: { ...EMPTY_ROSTER_ARCHIVE },
        epochs,
        members: [],
        workers: [self],
      },
      owner.seed,
    );
    served.state = {
      roster: {
        version: signed.version,
        body: signed.body.slice().buffer,
        signature: signed.signature.slice().buffer,
        signerKeyId: signed.signerKeyId,
      },
      epochs: [
        {
          ...row,
          memberPublicKey: row.memberPublicKey.slice().buffer,
          ownerPublicKey: ownerPublicKey.slice().buffer,
        },
      ],
    };

    const roster = await trust.roster();
    expect(roster.v).toBe(3);
    expect(roster.epochs).toHaveLength(ROSTER_EPOCH_WINDOW);
    expect(roster.archive.through).toBe(current - ROSTER_EPOCH_WINDOW);
    expect(await trust.ownerPublicKey()).toEqual({
      epoch: current,
      keyId: row.ownerKeyId,
      publicKey: ownerPublicKey,
    });
  });

  it("verifies only the pinned owner and roster members as signers", async () => {
    const { served, self, open } = await setup();
    const trust = await open();
    const member = await user("member");
    const stranger = await user("stranger");
    served.identities.push(member.row, stranger.row);
    await serve(served, { version: 1, workers: [self], members: [member.binding] });

    const message = new TextEncoder().encode("command");
    const signedBy = async (signer: Awaited<ReturnType<typeof user>>) => ({
      signerKeyId: signer.binding.keyId,
      message,
      signature: await sign(signer.seed, message),
    });

    expect(await trust.verifyUser(await signedBy(owner))).toEqual({
      userId: "owner",
      role: "owner",
    });
    expect(await trust.verifyUser(await signedBy(member))).toEqual({
      userId: "member",
      role: "member",
    });
    expect(await trust.verifyUser(await signedBy(stranger))).toBeNull();
    // A member key ID with a stranger's signature, and a substituted member identity row.
    expect(
      await trust.verifyUser({ ...(await signedBy(stranger)), signerKeyId: member.binding.keyId }),
    ).toBeNull();
    served.identities[1] = { ...stranger.row, userId: "member", keyId: member.binding.keyId };
    const fresh = await open();
    expect(await fresh.verifyUser(await signedBy(member))).toBeNull();
  });

  it("refuses a replayed one-shot claim after restart until it expires", async () => {
    const { open } = await setup();
    const claim = "tool-call:replay";
    expect(await (await open()).claimOnce(claim, Date.now() + 60_000)).toBe(true);
    const restarted = await open();
    expect(await restarted.claimOnce(claim, Date.now() + 60_000)).toBe(false);
    expect(await restarted.claimOnce("tool-call:expired", Date.now() - 1)).toBe(true);
    // An expired claim no longer blocks and is pruned on the next write.
    expect(await restarted.claimOnce("tool-call:expired", Date.now() + 60_000)).toBe(true);
  });
});
