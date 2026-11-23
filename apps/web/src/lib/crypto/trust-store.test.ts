import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createAccountKeys, fingerprint, toBase64Url } from "radium-crypto";
import { keyManager } from "./key-manager";
import { installFakeTrpc } from "./test-trpc";
import { sealTrustStore, trust, type PublicIdentity } from "./trust-store";

afterEach(() => mock.restore());

/** What the tRPC client throws for a refusal: an `Error` carrying the procedure's error code. */
const refusal = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

async function unlockedAccount() {
  const me = await createAccountKeys();
  const keyId = toBase64Url(me.identity.keyId);
  spyOn(keyManager, "getSnapshot").mockImplementation(() => ({
    state: "unlocked",
    userId: "me",
    keyId,
    fingerprint: "unused",
  }));
  spyOn(keyManager, "useAmk").mockImplementation(async (fn) => fn(me.amk, me.identity));
  return { me, keyId };
}

async function friend(): Promise<PublicIdentity> {
  const keys = await createAccountKeys();
  const publicKeys = {
    encryptionPublicKey: keys.identity.encryption.publicKey,
    signingPublicKey: keys.identity.signing.publicKey,
  };
  return {
    userId: "friend",
    keyId: toBase64Url(keys.identity.keyId),
    suite: keys.identity.suite,
    ...publicKeys,
    fingerprint: await fingerprint(publicKeys),
  };
}

describe("trust store writes", () => {
  test("a stale writer reloads the winner's store and retries on the next version", async () => {
    const { me, keyId } = await unlockedAccount();
    const winner = await sealTrustStore({
      amk: me.amk,
      keyId,
      userId: "me",
      store: { v: 1, version: 1, pins: {} },
    });
    let loads = 0;
    const saves: Array<{ expectedVersion: number | null; version: number }> = [];
    installFakeTrpc({
      "e2ee.getTrustStore": () => (++loads === 1 ? null : { version: 1, envelope: toBase64Url(winner) }),
      "e2ee.saveTrustStore": (input: { expectedVersion: number | null; version: number }) => {
        saves.push(input);
        if (saves.length === 1) throw refusal("CONFLICT", "TRUST_STORE_CONFLICT");
        return null;
      },
    });

    await trust.pin("friend", await friend(), "tofu");

    expect(saves.map((save) => [save.expectedVersion, save.version])).toEqual([
      [null, 1],
      [1, 2],
    ]);
  });

  test("any other refusal surfaces instead of retrying", async () => {
    await unlockedAccount();
    let saves = 0;
    installFakeTrpc({
      "e2ee.getTrustStore": () => null,
      "e2ee.saveTrustStore": () => {
        saves++;
        throw refusal("FORBIDDEN", "Too many attempts. Try again shortly.");
      },
    });

    await expect(trust.pin("friend", await friend(), "tofu")).rejects.toThrow("Too many attempts");
    expect(saves).toBe(1);
  });
});
