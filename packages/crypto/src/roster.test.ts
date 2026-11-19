import { describe, expect, it } from "vitest";
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "./encoding";
import {
  EMPTY_ROSTER_ARCHIVE,
  extendRosterArchive,
  ROSTER_EPOCH_WINDOW,
  signRoster,
  verifyArchivedEpochs,
  verifyRoster,
  windowRosterEpochs,
  type RosterEpoch,
  type RosterOwner,
} from "./roster";
import { generateSigningKeyPair, sign } from "./signatures";
import { rosterStatement, workerKeysStatement, workerPairingMac } from "./statements";

const id = () => toBase64Url(randomBytes(16));
const digest = () => toBase64Url(randomBytes(32));
const entry = (epoch: number): RosterEpoch => ({
  epoch,
  memberKeyId: id(),
  memberKeyHash: digest(),
  ownerKeyId: id(),
  ownerKeyHash: digest(),
});
const entries = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => entry(from + index));

async function owner(): Promise<{ seed: Uint8Array; pin: RosterOwner }> {
  const keys = await generateSigningKeyPair();
  return {
    seed: keys.seed,
    pin: { userId: "owner", keyId: id(), fingerprint: "owner-fp", signingPublicKey: keys.publicKey },
  };
}

function body(pin: RosterOwner, version = 1) {
  return {
    workspace: "ws",
    version,
    epoch: 1,
    owner: { userId: pin.userId, keyId: pin.keyId, fingerprint: pin.fingerprint },
    epochs: [entry(1)],
    archive: { ...EMPTY_ROSTER_ARCHIVE },
    members: [{ userId: "member", keyId: id(), fingerprint: "member-fp" }],
    workers: [{ workerId: "worker", keyId: id(), fingerprint: "worker-fp" }],
  };
}

/** Signs a raw (pre-v3) body as an older client did. */
async function signLegacy(seed: Uint8Array, legacy: object) {
  const encoded = utf8(JSON.stringify(legacy));
  return { encoded, signature: await sign(seed, rosterStatement({ workspaceId: "ws", body: encoded })) };
}

describe("roster", () => {
  it("verifies a signed version-3 roster with its Workers and refuses rollback", async () => {
    const { seed, pin } = await owner();
    const roster = body(pin, 3);
    const signed = await signRoster(roster, seed);
    const input = { ...signed, workspaceId: "ws", owner: pin, highWater: 3 };

    expect(await verifyRoster(input)).toEqual({ v: 3, ...roster });
    await expect(verifyRoster({ ...input, highWater: 4 })).rejects.toThrow();
    await expect(verifyRoster({ ...input, workspaceId: "other" })).rejects.toThrow();

    const tampered = signed.body.slice();
    tampered[tampered.length - 5]! ^= 1;
    await expect(verifyRoster({ ...input, body: tampered })).rejects.toThrow();
  });

  it("refuses a roster signed by anyone but the pinned owner", async () => {
    const { pin } = await owner();
    const other = await owner();
    const signed = await signRoster(body(pin), other.seed);
    await expect(
      verifyRoster({ ...signed, workspaceId: "ws", owner: pin, highWater: 0 }),
    ).rejects.toThrow();
  });

  it("reads version-1 rosters, signed before Workers had keys, as listing no Workers", async () => {
    const { seed, pin } = await owner();
    const { workers: _, archive: __, ...legacy } = body(pin);
    const { encoded, signature } = await signLegacy(seed, { v: 1, ...legacy });
    const verified = await verifyRoster({
      version: 1,
      body: encoded,
      signature,
      signerKeyId: pin.keyId,
      workspaceId: "ws",
      owner: pin,
      highWater: 0,
    });
    expect(verified.workers).toEqual([]);
    expect(verified.archive).toEqual(EMPTY_ROSTER_ARCHIVE);
  });

  it("keeps only the newest epochs and chains older ones into the archive", async () => {
    const { seed, pin } = await owner();
    const all = entries(1, ROSTER_EPOCH_WINDOW + 5);
    const signed = await signRoster(
      { ...body(pin, 2), epoch: all.length, epochs: all },
      seed,
    );
    const verified = await verifyRoster({ ...signed, workspaceId: "ws", owner: pin, highWater: 0 });

    expect(verified.v).toBe(3);
    expect(verified.epochs).toEqual(all.slice(5));
    expect(verified.archive).toEqual(await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 5)));
    // Appending to the window moves exactly one more epoch into the archive.
    const next = await windowRosterEpochs({
      epochs: [...verified.epochs, entry(all.length + 1)],
      archive: verified.archive,
    });
    expect(next.epochs[0]!.epoch).toBe(7);
    expect(next.archive).toEqual(await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 6)));
  });

  it("converts a version-2 roster listing every epoch on the next signature", async () => {
    const { seed, pin } = await owner();
    const all = entries(1, ROSTER_EPOCH_WINDOW + 3);
    const { archive: _, ...rest } = body(pin, 4);
    const { encoded, signature } = await signLegacy(seed, {
      v: 2,
      ...rest,
      epoch: all.length,
      epochs: all,
    });
    const legacy = await verifyRoster({
      version: 4,
      body: encoded,
      signature,
      signerKeyId: pin.keyId,
      workspaceId: "ws",
      owner: pin,
      highWater: 0,
    });
    expect(legacy.epochs).toHaveLength(all.length);

    const signed = await signRoster({ ...legacy, version: 5 }, seed);
    const converted = await verifyRoster({ ...signed, workspaceId: "ws", owner: pin, highWater: 4 });
    expect(converted.epochs).toEqual(all.slice(3));
    await verifyArchivedEpochs({
      archive: converted.archive,
      claimedPrefixHash: new Uint8Array(32),
      entries: all.slice(0, 3),
    });
  });

  it("refuses version-3 bodies whose window or archive is malformed", async () => {
    const { seed, pin } = await owner();
    const all = entries(1, ROSTER_EPOCH_WINDOW + 1);
    const archive = await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 1));
    const base = { v: 3, ...body(pin, 1), epoch: all.length };
    for (const malformed of [
      // Window longer than allowed.
      { ...base, epochs: all, archive: EMPTY_ROSTER_ARCHIVE },
      // Gap between the archive and the window.
      { ...base, epochs: all.slice(1), archive: EMPTY_ROSTER_ARCHIVE },
      // Window not ending at the current epoch.
      { ...base, epoch: all.length + 1, epochs: all.slice(1), archive },
      // Archive of nothing that is not A_0.
      { ...base, epoch: 1, epochs: all.slice(0, 1), archive: { through: 0, hash: digest() } },
      { ...base, epochs: all.slice(1), archive: undefined },
    ]) {
      const { encoded, signature } = await signLegacy(seed, malformed);
      await expect(
        verifyRoster({
          version: 1,
          body: encoded,
          signature,
          signerKeyId: pin.keyId,
          workspaceId: "ws",
          owner: pin,
          highWater: 0,
        }),
      ).rejects.toThrow();
    }
    await expect(
      signRoster({ ...body(pin), epoch: 3, epochs: [entry(2), entry(3)] }, seed),
    ).rejects.toThrow();
  });
});

describe("roster archive", () => {
  it("verifies any archived suffix from its claimed prefix, at the window boundary too", async () => {
    const all = entries(1, 40);
    const archive = await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all);
    const prefix = await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 24));

    await verifyArchivedEpochs({ archive, claimedPrefixHash: new Uint8Array(32), entries: all });
    await verifyArchivedEpochs({
      archive,
      claimedPrefixHash: fromBase64Url(prefix.hash),
      entries: all.slice(24),
    });
    // Only the newest archived epoch (the one right before the window).
    const last = await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 39));
    await verifyArchivedEpochs({
      archive,
      claimedPrefixHash: fromBase64Url(last.hash),
      entries: all.slice(39),
    });
  });

  it("fails on a tampered entry, a wrong prefix, a gap, or entries short of the archive", async () => {
    const all = entries(1, 10);
    const archive = await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all);
    const prefix = fromBase64Url((await extendRosterArchive(EMPTY_ROSTER_ARCHIVE, all.slice(0, 4))).hash);
    const suffix = all.slice(4);

    for (const field of ["memberKeyId", "memberKeyHash", "ownerKeyId", "ownerKeyHash"] as const) {
      const tampered = suffix.map((row, index) =>
        index === 2 ? { ...row, [field]: field.endsWith("Hash") ? digest() : id() } : row,
      );
      await expect(
        verifyArchivedEpochs({ archive, claimedPrefixHash: prefix, entries: tampered }),
      ).rejects.toThrow();
    }
    const wrongPrefix = prefix.slice();
    wrongPrefix[0]! ^= 1;
    for (const input of [
      { claimedPrefixHash: wrongPrefix, entries: suffix },
      { claimedPrefixHash: prefix, entries: suffix.filter((_, index) => index !== 1) },
      { claimedPrefixHash: prefix, entries: suffix.slice(0, -1) },
      { claimedPrefixHash: prefix, entries: [] },
      // Epoch 1 must chain from A_0, never from a claimed value.
      { claimedPrefixHash: prefix, entries: all },
    ]) {
      await expect(verifyArchivedEpochs({ archive, ...input })).rejects.toThrow();
    }
  });
});

describe("worker pairing", () => {
  it("binds Worker keys to the pairing secret", async () => {
    const statement = workerKeysStatement({
      workspaceId: "ws",
      workerId: "worker",
      keyId: id(),
      suite: 1,
      encryptionPublicKey: randomBytes(1216),
      signingPublicKey: randomBytes(32),
    });
    const secret = randomBytes(32);
    const mac = await workerPairingMac(secret, statement);

    expect(await workerPairingMac(secret, statement)).toEqual(mac);
    expect(await workerPairingMac(randomBytes(32), statement)).not.toEqual(mac);
    const swapped = statement.slice();
    swapped[swapped.length - 1]! ^= 1;
    expect(await workerPairingMac(secret, swapped)).not.toEqual(mac);
  });
});
