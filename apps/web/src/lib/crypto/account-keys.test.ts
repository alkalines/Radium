import { describe, expect, test } from "bun:test";
import {
  createAccountKeys,
  equalBytes,
  generateShortSecret,
  randomBytes,
  toBase64Url,
} from "radium-crypto";

import {
  buildNewKeysPayload,
  buildRecoveryWrapper,
  buildRewrapPayload,
  KeyBundleError,
  openDeviceRecovery,
  openSignInPayload,
  openWithRecoveryKey,
  parseResetPayload,
  sealDeviceRecovery,
} from "./account-keys";

const exportKey = () => toBase64Url(randomBytes(64));

async function newAccount() {
  const { amk, identity, recovery } = await createAccountKeys();
  return { account: { amk, identity }, recovery };
}

describe("account key bundles", () => {
  test("a sign-up bundle opens with the same export key and yields the same keys", async () => {
    const { account, recovery } = await newAccount();
    const key = exportKey();
    const bundle = await buildNewKeysPayload({
      exportKey: key,
      account,
      recoveryEntropy: recovery.entropy,
    });

    // The server returns the password wrapper and identity of the current credential.
    const opened = await openSignInPayload({
      exportKey: key,
      payload: { v: 1, passwordWrapper: bundle.passwordWrapper, identity: bundle.identity },
    });

    expect(equalBytes(opened.amk, account.amk)).toBe(true);
    expect(equalBytes(opened.identity.encryption.seed, account.identity.encryption.seed)).toBe(
      true,
    );
    expect(equalBytes(opened.identity.signing.seed, account.identity.signing.seed)).toBe(true);
  });

  test("a bundle never contains the export key, AMK or seeds", async () => {
    const { account, recovery } = await newAccount();
    const key = exportKey();
    const serialized = JSON.stringify(
      await buildNewKeysPayload({ exportKey: key, account, recoveryEntropy: recovery.entropy }),
    );

    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain(toBase64Url(account.amk));
    expect(serialized).not.toContain(toBase64Url(account.identity.encryption.seed));
    expect(serialized).not.toContain(toBase64Url(account.identity.signing.seed));
    expect(serialized).not.toContain(toBase64Url(recovery.entropy));
  });

  test("a wrong export key does not open the bundle", async () => {
    const { account, recovery } = await newAccount();
    const bundle = await buildNewKeysPayload({
      exportKey: exportKey(),
      account,
      recoveryEntropy: recovery.entropy,
    });

    await expect(
      openSignInPayload({
        exportKey: exportKey(),
        payload: { v: 1, passwordWrapper: bundle.passwordWrapper, identity: bundle.identity },
      }),
    ).rejects.toThrow();
  });

  test("a password change rewraps the same AMK for the new export key only", async () => {
    const { account, recovery } = await newAccount();
    const original = await buildNewKeysPayload({
      exportKey: exportKey(),
      account,
      recoveryEntropy: recovery.entropy,
    });
    const newKey = exportKey();
    const rewrap = await buildRewrapPayload({ exportKey: newKey, account });

    expect(rewrap.keyId).toBe(original.identity.keyId);
    const opened = await openSignInPayload({
      exportKey: newKey,
      payload: { v: 1, passwordWrapper: rewrap.passwordWrapper, identity: original.identity },
    });
    expect(equalBytes(opened.amk, account.amk)).toBe(true);
  });

  test("a substituted identity record fails to open", async () => {
    const victim = await newAccount();
    const attacker = await newAccount();
    const key = exportKey();
    const victimBundle = await buildNewKeysPayload({
      exportKey: key,
      account: victim.account,
      recoveryEntropy: victim.recovery.entropy,
    });
    const attackerBundle = await buildNewKeysPayload({
      exportKey: exportKey(),
      account: attacker.account,
      recoveryEntropy: attacker.recovery.entropy,
    });

    await expect(
      openSignInPayload({
        exportKey: key,
        payload: {
          v: 1,
          passwordWrapper: victimBundle.passwordWrapper,
          identity: attackerBundle.identity,
        },
      }),
    ).rejects.toThrow();
  });

  test("malformed bundles are rejected before decryption", async () => {
    const { account, recovery } = await newAccount();
    const key = exportKey();
    const bundle = await buildNewKeysPayload({
      exportKey: key,
      account,
      recoveryEntropy: recovery.entropy,
    });
    const valid = { v: 1, passwordWrapper: bundle.passwordWrapper, identity: bundle.identity };

    const extraField = { ...valid, exportKey: key };
    const shortWrapper = { ...valid, passwordWrapper: bundle.passwordWrapper.slice(0, 40) };
    const otherSuite = { ...valid, identity: { ...bundle.identity, suite: 2 } };

    for (const payload of [null, {}, extraField, shortWrapper, otherSuite]) {
      await expect(openSignInPayload({ exportKey: key, payload })).rejects.toBeInstanceOf(
        KeyBundleError,
      );
    }
  });
});

describe("recovery", () => {
  test("the recovery key opens the reset bundle; other words do not", async () => {
    const { account, recovery } = await newAccount();
    const bundle = await buildNewKeysPayload({
      exportKey: exportKey(),
      account,
      recoveryEntropy: recovery.entropy,
    });
    const reset = parseResetPayload({
      v: 1,
      recoveryWrapper: bundle.recoveryWrapper,
      identity: bundle.identity,
    });
    if (!reset.hasKeys) throw new Error("expected keys");

    const opened = await openWithRecoveryKey({ words: recovery.words.join(" "), reset });
    expect(equalBytes(opened.amk, account.amk)).toBe(true);

    const other = await newAccount();
    await expect(
      openWithRecoveryKey({ words: other.recovery.words.join(" "), reset }),
    ).rejects.toThrow();
  });

  test("a regenerated recovery wrapper opens with the new words", async () => {
    const { account, recovery } = await newAccount();
    const bundle = await buildNewKeysPayload({
      exportKey: exportKey(),
      account,
      recoveryEntropy: recovery.entropy,
    });
    const replacement = await newAccount();
    const wrapper = await buildRecoveryWrapper({
      account,
      recoveryEntropy: replacement.recovery.entropy,
    });
    const reset = parseResetPayload({
      v: 1,
      recoveryWrapper: toBase64Url(wrapper),
      identity: bundle.identity,
    });
    if (!reset.hasKeys) throw new Error("expected keys");

    const opened = await openWithRecoveryKey({
      words: replacement.recovery.words.join(" "),
      reset,
    });
    expect(equalBytes(opened.amk, account.amk)).toBe(true);
  });

  test("device recovery hands over the AMK only to the holder of the 12 words", async () => {
    const { account, recovery } = await newAccount();
    const bundle = await buildNewKeysPayload({
      exportKey: exportKey(),
      account,
      recoveryEntropy: recovery.entropy,
    });
    const reset = parseResetPayload({
      v: 1,
      recoveryWrapper: bundle.recoveryWrapper,
      identity: bundle.identity,
    });
    if (!reset.hasKeys) throw new Error("expected keys");

    const secret = generateShortSecret();
    const offer = await sealDeviceRecovery({ words: secret.words.join(" "), account });
    const opened = await openDeviceRecovery({
      secret: secret.entropy,
      sealedAmk: offer.sealedAmk,
      reset,
    });
    expect(equalBytes(opened.amk, account.amk)).toBe(true);

    const wrongSecret = generateShortSecret();
    await expect(
      openDeviceRecovery({ secret: wrongSecret.entropy, sealedAmk: offer.sealedAmk, reset }),
    ).rejects.toThrow();
  });

  test("a reset bundle without keys parses as such", () => {
    expect(parseResetPayload({ v: 1, identity: null })).toEqual({ hasKeys: false });
    expect(() => parseResetPayload({ v: 1, identity: null, extra: true })).toThrow(KeyBundleError);
  });
});
