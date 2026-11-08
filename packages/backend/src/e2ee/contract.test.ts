import { toBase64Url } from "radium-crypto";
import { expect, test } from "vitest";
import { InvalidKeyBundleError, parseRegistrationPayload } from "./contract";

function b64(length: number, fill = 7) {
  return toBase64Url(new Uint8Array(length).fill(fill));
}

function newKeys() {
  return {
    v: 1,
    kind: "new-keys",
    passwordWrapper: b64(79),
    recoveryWrapper: b64(79),
    identity: {
      keyId: b64(16),
      suite: 1,
      encryptionPublicKey: b64(1216),
      signingPublicKey: b64(32),
      secrets: b64(111),
      selfSignature: b64(64),
    },
  };
}

function rewrap() {
  return { v: 1, kind: "rewrap", passwordWrapper: b64(79), keyId: b64(16) };
}

test("each flow accepts only its payload kinds and never an absent payload", () => {
  expect(parseRegistrationPayload(newKeys(), "sign-up").kind).toBe("new-keys");
  expect(parseRegistrationPayload(rewrap(), "change-password").kind).toBe("rewrap");
  expect(parseRegistrationPayload(newKeys(), "reset-password").kind).toBe("new-keys");
  expect(parseRegistrationPayload(rewrap(), "reset-password").kind).toBe("rewrap");

  expect(() => parseRegistrationPayload(rewrap(), "sign-up")).toThrow(InvalidKeyBundleError);
  expect(() => parseRegistrationPayload(newKeys(), "change-password")).toThrow(
    InvalidKeyBundleError,
  );
  for (const flow of ["sign-up", "change-password", "reset-password"] as const) {
    expect(() => parseRegistrationPayload(undefined, flow)).toThrow(InvalidKeyBundleError);
    expect(() => parseRegistrationPayload(null, flow)).toThrow(InvalidKeyBundleError);
  }
});

test("byte fields must decode to their exact length in canonical base64url", () => {
  const cases: Array<(payload: ReturnType<typeof newKeys>) => void> = [
    (payload) => (payload.passwordWrapper = b64(78)),
    (payload) => (payload.recoveryWrapper = b64(80)),
    (payload) => (payload.identity.keyId = b64(15)),
    (payload) => (payload.identity.encryptionPublicKey = b64(1215)),
    (payload) => (payload.identity.signingPublicKey = b64(33)),
    (payload) => (payload.identity.secrets = b64(112)),
    (payload) => (payload.identity.selfSignature = b64(63)),
    // Padding and the standard alphabet are not the wire format.
    (payload) => (payload.identity.signingPublicKey = `${b64(32)}=`),
    (payload) => (payload.passwordWrapper = b64(79).replace(/^./, "+")),
    // Same length, but unused trailing bits set: a second spelling of the same bytes.
    (payload) => (payload.identity.keyId = `${b64(16).slice(0, -1)}B`),
  ];

  for (const mutate of cases) {
    const payload = newKeys();
    mutate(payload);
    expect(() => parseRegistrationPayload(payload, "sign-up")).toThrow(InvalidKeyBundleError);
  }
});

test("unknown keys, other versions and other suites are rejected", () => {
  expect(() => parseRegistrationPayload({ ...newKeys(), exportKey: b64(64) }, "sign-up")).toThrow(
    InvalidKeyBundleError,
  );
  expect(() =>
    parseRegistrationPayload(
      { ...newKeys(), identity: { ...newKeys().identity, amk: b64(32) } },
      "sign-up",
    ),
  ).toThrow(InvalidKeyBundleError);
  expect(() => parseRegistrationPayload({ ...rewrap(), v: 2 }, "change-password")).toThrow(
    InvalidKeyBundleError,
  );
  expect(() =>
    parseRegistrationPayload(
      { ...newKeys(), identity: { ...newKeys().identity, suite: 2 } },
      "sign-up",
    ),
  ).toThrow(InvalidKeyBundleError);
});

test("rejections never echo payload content", () => {
  const secretLooking = "x".repeat(40);
  try {
    parseRegistrationPayload({ ...rewrap(), keyId: secretLooking }, "change-password");
    expect.unreachable();
  } catch (error) {
    expect(String(error)).not.toContain(secretLooking);
  }
});
