import { describe, expect, it } from "vitest";
import { randomBytes, toBase64Url, utf8 } from "./encoding";
import { signRoster, verifyRoster, type RosterOwner } from "./roster";
import { generateSigningKeyPair, sign } from "./signatures";
import { rosterStatement, workerKeysStatement, workerPairingMac } from "./statements";

const id = () => toBase64Url(randomBytes(16));
const digest = () => toBase64Url(randomBytes(32));

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
    epochs: [
      { epoch: 1, memberKeyId: id(), memberKeyHash: digest(), ownerKeyId: id(), ownerKeyHash: digest() },
    ],
    members: [{ userId: "member", keyId: id(), fingerprint: "member-fp" }],
    workers: [{ workerId: "worker", keyId: id(), fingerprint: "worker-fp" }],
  };
}

describe("roster", () => {
  it("verifies a signed version-2 roster with its Workers and refuses rollback", async () => {
    const { seed, pin } = await owner();
    const roster = body(pin, 3);
    const signed = await signRoster(roster, seed);
    const input = { ...signed, workspaceId: "ws", owner: pin, highWater: 3 };

    expect(await verifyRoster(input)).toEqual({ v: 2, ...roster });
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
    const { workers: _, ...legacy } = body(pin);
    const encoded = utf8(JSON.stringify({ v: 1, ...legacy }));
    const signature = await sign(seed, rosterStatement({ workspaceId: "ws", body: encoded }));
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
