import { describe, expect, it } from "vitest";
import { randomBytes, toHex, utf8 } from "./encoding";
import {
  ed25519Implementations,
  generateSigningKeyPair,
  getEd25519,
  sign,
  signingMessage,
  signingPublicKeyFromSeed,
  verify,
} from "./signatures";
import { SIGNATURE_BYTES, SIGNING_PUBLIC_KEY_BYTES } from "./suite";
import { fromHex } from "./test-helpers";

// RFC 8032 §7.1 TEST 1–3.
const RFC8032_VECTORS = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    publicKey: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    signature:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

async function nativeEd25519Works(): Promise<boolean> {
  try {
    const key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return "privateKey" in key;
  } catch {
    return false;
  }
}

const nativeAvailable = await nativeEd25519Works();
const { native, noble } = ed25519Implementations;
const implementations = nativeAvailable ? [native, noble] : [noble];

describe("Ed25519 implementation selection", () => {
  it("prefers WebCrypto exactly when the runtime supports Ed25519", async () => {
    expect((await getEd25519()).name).toBe(nativeAvailable ? "native" : "noble");
  });
});

describe.each(implementations)("RFC 8032 vectors ($name)", (implementation) => {
  it.each(RFC8032_VECTORS)(
    "reproduces public key and signature for message '$message'",
    async (vector) => {
      const seed = fromHex(vector.seed);
      const message = fromHex(vector.message);

      expect(toHex(await implementation.publicKeyFromSeed(seed))).toBe(vector.publicKey);
      expect(toHex(await implementation.sign(seed, message))).toBe(vector.signature);
      expect(
        await implementation.verify(fromHex(vector.publicKey), message, fromHex(vector.signature)),
      ).toBe(true);
    },
  );

  it("rejects a modified message, signature or key", async () => {
    const vector = RFC8032_VECTORS[2]!;
    const publicKey = fromHex(vector.publicKey);
    const signature = fromHex(vector.signature);

    expect(await implementation.verify(publicKey, fromHex("af83"), signature)).toBe(false);
    const flipped = signature.slice();
    flipped[0]! ^= 1;
    expect(await implementation.verify(publicKey, fromHex(vector.message), flipped)).toBe(false);
    expect(
      await implementation.verify(
        fromHex(RFC8032_VECTORS[0]!.publicKey),
        fromHex(vector.message),
        signature,
      ),
    ).toBe(false);
  });
});

describe.skipIf(!nativeAvailable)("native and noble Ed25519 interoperate", () => {
  it("produce identical keys and signatures and verify each other", async () => {
    const seed = randomBytes(32);
    const message = randomBytes(100);

    const nativeKey = await native.publicKeyFromSeed(seed);
    const nativeSignature = await native.sign(seed, message);
    expect(await noble.publicKeyFromSeed(seed)).toEqual(nativeKey);
    expect(await noble.sign(seed, message)).toEqual(nativeSignature);
    expect(await noble.verify(nativeKey, message, nativeSignature)).toBe(true);
    expect(await native.verify(nativeKey, message, await noble.sign(seed, message))).toBe(true);
  });
});

describe("signing API", () => {
  it("generates key pairs of the documented sizes that sign and verify", async () => {
    const keyPair = await generateSigningKeyPair();
    expect(keyPair.publicKey.length).toBe(SIGNING_PUBLIC_KEY_BYTES);
    expect(keyPair.seed.length).toBe(32);
    expect(await signingPublicKeyFromSeed(keyPair.seed)).toEqual(keyPair.publicKey);

    const message = signingMessage("radium/v1/test", utf8("a"), utf8("b"));
    const signature = await sign(keyPair.seed, message);
    expect(signature.length).toBe(SIGNATURE_BYTES);
    expect(await verify(keyPair.publicKey, message, signature)).toBe(true);
    expect(
      await verify(keyPair.publicKey, signingMessage("radium/v1/test", utf8("ab")), signature),
    ).toBe(false);
  });

  it("returns false instead of throwing for malformed keys and signatures", async () => {
    const keyPair = await generateSigningKeyPair();
    const signature = await sign(keyPair.seed, utf8("m"));
    expect(await verify(keyPair.publicKey.slice(1), utf8("m"), signature)).toBe(false);
    expect(await verify(keyPair.publicKey, utf8("m"), signature.slice(1))).toBe(false);
    expect(await verify(new Uint8Array(32).fill(0xff), utf8("m"), signature)).toBe(false);
  });

  it("puts the label first and length-prefixes every part", () => {
    expect(signingMessage("L", Uint8Array.of(7))).toEqual(
      Uint8Array.of(0, 0, 0, 1, 0x4c, 0, 0, 0, 1, 7),
    );
    expect(signingMessage("radium/v1/a", utf8("b"))).not.toEqual(signingMessage("radium/v1/ab"));
  });
});
