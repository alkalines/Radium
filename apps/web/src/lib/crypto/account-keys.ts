/**
 * Account key bundles exchanged with the OPAQUE plugin (`docs/E2EE/Keys.md` "Account").
 *
 * Everything here runs only in the browser. Builders turn the export key (base64url, from the
 * plugin's payload callback or sign-in result) into ciphertext-only bundles; openers validate a
 * bundle the server returned and decrypt it locally. Nothing in this module may log, return or
 * serialize the export key, the AMK, private seeds or recovery words: callers pass the AMK to
 * {@link keyManager} and drop every other secret.
 *
 * Wire format: the shared E2EE contract ("Key bundle wire format"); byte strings are unpadded
 * base64url. Every value received from the server is parsed strictly (exact keys, exact decoded
 * lengths) because a compromised backend must not be able to steer the client with odd shapes.
 */
import {
  AMK_WRAPPER_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  LABELS,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  deriveKek,
  fromBase64Url,
  hkdf,
  identitySelfSignature,
  openIdentitySecrets,
  phraseToEntropy,
  sealIdentitySecrets,
  toBase64Url,
  unwrapAmk,
  verifyIdentitySelfSignature,
  wrapAmk,
  type IdentityKeys,
} from "radium-crypto";

/** Public identity plus its AMK-encrypted private seeds, as stored per identity row. */
export type IdentityRecord = {
  keyId: string;
  suite: 1;
  encryptionPublicKey: string;
  signingPublicKey: string;
  secrets: string;
  selfSignature: string;
};

/** Sign-up and reset "new keys": a fresh AMK, identity and recovery wrapper. */
export type NewKeysPayload = {
  v: 1;
  kind: "new-keys";
  passwordWrapper: string;
  recoveryWrapper: string;
  identity: IdentityRecord;
};

/** Password change and reset with an existing AMK: only the password wrapper changes. */
export type RewrapPayload = { v: 1; kind: "rewrap"; passwordWrapper: string; keyId: string };

/** Returned by sign-in for exactly the credential just proven. */
export type SignInPayload = { v: 1; passwordWrapper: string; identity: IdentityRecord };

/** Returned by reset verify: the current identity and its recovery wrapper, or no keys at all. */
export type ResetPayload =
  | { v: 1; recoveryWrapper: string; identity: IdentityRecord }
  | { v: 1; identity: null };

/** An opened account: the AMK and identity keys {@link keyManager.unlock} takes. */
export type UnlockedAccount = { amk: Uint8Array; identity: IdentityKeys };

/**
 * Zeroes the secret bytes of an account a flow no longer needs (the key manager keeps its own
 * copies). Best effort: JavaScript cannot guarantee no other copy exists.
 */
export function wipeAccount(account: UnlockedAccount) {
  account.amk.fill(0);
  account.identity.encryption.seed.fill(0);
  account.identity.signing.seed.fill(0);
}

/** Thrown when a server-supplied bundle does not have the exact contract shape. */
export class KeyBundleError extends Error {
  constructor() {
    super("The account key bundle from the server is malformed");
    this.name = "KeyBundleError";
  }
}

// ---------------------------------------------------------------------------------------------
// Building bundles (ciphertext only)

/** Encrypts the identity under the AMK and self-signs it, producing the public identity record. */
async function buildIdentityRecord(account: UnlockedAccount): Promise<IdentityRecord> {
  const { amk, identity } = account;
  const secrets = await sealIdentitySecrets({ amk, identity });
  const selfSignature = await identitySelfSignature(identity);

  return {
    keyId: toBase64Url(identity.keyId),
    suite: SUITE_1,
    encryptionPublicKey: toBase64Url(identity.encryption.publicKey),
    signingPublicKey: toBase64Url(identity.signing.publicKey),
    secrets: toBase64Url(secrets),
    selfSignature: toBase64Url(selfSignature),
  };
}

/**
 * Derives the KEK for `label` from `secret`, runs `fn` with it and zeroes the KEK afterwards, so
 * no derived key outlives the wrap or unwrap that needed it.
 */
async function withKek<T>(
  secret: Uint8Array,
  label: "accountKek" | "recoveryKek" | "deviceRecovery",
  fn: (kek: Uint8Array) => Promise<T>,
): Promise<T> {
  const kek = await deriveKek(secret, label);
  try {
    return await fn(kek);
  } finally {
    kek.fill(0);
  }
}

/** Wraps the AMK under the password KEK derived from an OPAQUE export key (base64url). */
async function passwordWrapper(exportKey: string, account: UnlockedAccount): Promise<string> {
  const exportKeyBytes = fromBase64Url(exportKey);
  try {
    const envelope = await withKek(exportKeyBytes, "accountKek", (kek) =>
      wrapAmk({ kek, amk: account.amk, keyId: account.identity.keyId, purpose: "password" }),
    );
    return toBase64Url(envelope);
  } finally {
    exportKeyBytes.fill(0);
  }
}

/**
 * Wraps the AMK under the recovery KEK of a 24-word recovery key (its 32 bytes of entropy). Used
 * for new bundles and for regenerating the recovery key from Settings.
 */
export async function buildRecoveryWrapper(input: {
  account: UnlockedAccount;
  recoveryEntropy: Uint8Array;
}): Promise<Uint8Array> {
  const { account } = input;
  return withKek(input.recoveryEntropy, "recoveryKek", (kek) =>
    wrapAmk({ kek, amk: account.amk, keyId: account.identity.keyId, purpose: "recovery" }),
  );
}

/**
 * Builds the sign-up / reset "new keys" bundle. Called inside the plugin's payload callback, so
 * it runs before the credential is committed: the caller must not unlock or persist anything
 * until the plugin call itself succeeds (audit I1).
 */
export async function buildNewKeysPayload(input: {
  exportKey: string;
  account: UnlockedAccount;
  recoveryEntropy: Uint8Array;
}): Promise<NewKeysPayload> {
  const recoveryWrapper = await buildRecoveryWrapper({
    account: input.account,
    recoveryEntropy: input.recoveryEntropy,
  });

  return {
    v: 1,
    kind: "new-keys",
    passwordWrapper: await passwordWrapper(input.exportKey, input.account),
    recoveryWrapper: toBase64Url(recoveryWrapper),
    identity: await buildIdentityRecord(input.account),
  };
}

/** Builds the password change / reset-with-existing-AMK bundle: the same AMK under a new password. */
export async function buildRewrapPayload(input: {
  exportKey: string;
  account: UnlockedAccount;
}): Promise<RewrapPayload> {
  return {
    v: 1,
    kind: "rewrap",
    passwordWrapper: await passwordWrapper(input.exportKey, input.account),
    keyId: toBase64Url(input.account.identity.keyId),
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing server bundles

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Requires exactly these keys, so unknown fields from the server are rejected, not ignored. */
function requireExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new KeyBundleError();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new KeyBundleError();
  }
  return value;
}

/** Decodes one base64url field and checks its exact decoded length. */
function bytesField(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string") throw new KeyBundleError();
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new KeyBundleError();
  }
  if (bytes.length !== length) throw new KeyBundleError();
  return bytes;
}

/** Decoded public identity record; `secrets` is still AMK ciphertext. */
type ParsedIdentity = {
  keyId: Uint8Array;
  suite: number;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  secrets: Uint8Array;
  selfSignature: Uint8Array;
};

const IDENTITY_KEYS = [
  "keyId",
  "suite",
  "encryptionPublicKey",
  "signingPublicKey",
  "secrets",
  "selfSignature",
] as const;

function parseIdentityRecord(value: unknown): ParsedIdentity {
  const record = requireExactKeys(value, IDENTITY_KEYS);
  if (record.suite !== SUITE_1) throw new KeyBundleError();

  return {
    keyId: bytesField(record.keyId, KEY_ID_BYTES),
    suite: SUITE_1,
    encryptionPublicKey: bytesField(record.encryptionPublicKey, ENCRYPTION_PUBLIC_KEY_BYTES),
    signingPublicKey: bytesField(record.signingPublicKey, SIGNING_PUBLIC_KEY_BYTES),
    secrets: bytesField(record.secrets, IDENTITY_SECRETS_BYTES),
    selfSignature: bytesField(record.selfSignature, SIGNATURE_BYTES),
  };
}

/** Parsed reset-verify bundle; keep it in memory only for the reset page's lifetime. */
export type ParsedResetPayload =
  | { hasKeys: true; recoveryWrapper: Uint8Array; identity: ParsedIdentity }
  | { hasKeys: false };

/** Strictly parses the `verifyResetToken` payload. Throws {@link KeyBundleError}. */
export function parseResetPayload(payload: unknown): ParsedResetPayload {
  if (isPlainObject(payload) && payload.identity === null) {
    requireExactKeys(payload, ["v", "identity"]);
    if (payload.v !== 1) throw new KeyBundleError();
    return { hasKeys: false };
  }

  const bundle = requireExactKeys(payload, ["v", "recoveryWrapper", "identity"]);
  if (bundle.v !== 1) throw new KeyBundleError();

  return {
    hasKeys: true,
    recoveryWrapper: bytesField(bundle.recoveryWrapper, AMK_WRAPPER_BYTES),
    identity: parseIdentityRecord(bundle.identity),
  };
}

// ---------------------------------------------------------------------------------------------
// Opening bundles

/**
 * Completes an account from an unwrapped AMK. `openIdentitySecrets` authenticates the ciphertext
 * and re-derives both public keys from the seeds, so a wrong AMK or substituted public keys fail
 * here; the self-signature check additionally binds keyId and suite. On failure the AMK and any
 * opened seeds are zeroed before the error propagates.
 */
async function openAccount(amk: Uint8Array, identity: ParsedIdentity): Promise<UnlockedAccount> {
  let opened: IdentityKeys | null = null;
  try {
    opened = await openIdentitySecrets({
      amk,
      keyId: identity.keyId,
      suite: identity.suite,
      envelope: identity.secrets,
      encryptionPublicKey: identity.encryptionPublicKey,
      signingPublicKey: identity.signingPublicKey,
    });

    const selfSigned = await verifyIdentitySelfSignature({
      keyId: identity.keyId,
      suite: identity.suite,
      encryptionPublicKey: identity.encryptionPublicKey,
      signingPublicKey: identity.signingPublicKey,
      signature: identity.selfSignature,
    });
    // A valid AEAD with a bad self-signature means the record was assembled inconsistently.
    if (!selfSigned) throw new KeyBundleError();

    return { amk, identity: opened };
  } catch (error) {
    amk.fill(0);
    if (opened) wipeAccount({ amk, identity: opened });
    throw error;
  }
}

/**
 * Opens the bundle returned by OPAQUE sign-in with that sign-in's export key. Throws
 * {@link KeyBundleError} for a malformed bundle and `CryptoError` when it does not decrypt (wrong
 * export key or tampered data).
 */
export async function openSignInPayload(input: {
  exportKey: string;
  payload: unknown;
}): Promise<UnlockedAccount> {
  const bundle = requireExactKeys(input.payload, ["v", "passwordWrapper", "identity"]);
  if (bundle.v !== 1) throw new KeyBundleError();
  const wrapper = bytesField(bundle.passwordWrapper, AMK_WRAPPER_BYTES);
  const identity = parseIdentityRecord(bundle.identity);

  const exportKeyBytes = fromBase64Url(input.exportKey);
  let amk: Uint8Array;
  try {
    amk = await withKek(exportKeyBytes, "accountKek", (kek) =>
      unwrapAmk({ kek, envelope: wrapper, keyId: identity.keyId, purpose: "password" }),
    );
  } finally {
    exportKeyBytes.fill(0);
  }
  return openAccount(amk, identity);
}

/**
 * Opens a reset bundle with the 24-word recovery key. Throws `CryptoError` with
 * `BAD_RECOVERY_PHRASE` for words that are not a valid recovery key, `DECRYPT_FAILED` when they
 * belong to another key.
 */
export async function openWithRecoveryKey(input: {
  words: string;
  reset: Extract<ParsedResetPayload, { hasKeys: true }>;
}): Promise<UnlockedAccount> {
  const entropy = phraseToEntropy(input.words, 24);
  const { reset } = input;
  let amk: Uint8Array;
  try {
    amk = await withKek(entropy, "recoveryKek", (kek) =>
      unwrapAmk({
        kek,
        envelope: reset.recoveryWrapper,
        keyId: reset.identity.keyId,
        purpose: "recovery",
      }),
    );
  } finally {
    entropy.fill(0);
  }
  return openAccount(amk, reset.identity);
}

// ---------------------------------------------------------------------------------------------
// Device recovery (Authentication.md "Another device where I'm still unlocked")

/** Slot id both devices derive from the 12-word secret; the secret itself never leaves them. */
export async function deviceRecoverySlotId(secret: Uint8Array): Promise<string> {
  return toBase64Url(await hkdf(secret, LABELS.deviceRecoveryId, 32));
}

/**
 * Run on the unlocked device after the user typed the 12 words shown by the resetting device:
 * returns the slot id and the AMK wrapped under the secret's KEK, ready for
 * `offerDeviceRecovery`. Throws `BAD_RECOVERY_PHRASE` for mistyped words.
 */
export async function sealDeviceRecovery(input: {
  words: string;
  account: UnlockedAccount;
}): Promise<{ slotId: string; sealedAmk: Uint8Array }> {
  const secret = phraseToEntropy(input.words, 12);
  const { account } = input;
  try {
    const sealedAmk = await withKek(secret, "deviceRecovery", (kek) =>
      wrapAmk({ kek, amk: account.amk, keyId: account.identity.keyId, purpose: "device-recovery" }),
    );
    return { slotId: await deviceRecoverySlotId(secret), sealedAmk };
  } finally {
    secret.fill(0);
  }
}

/**
 * Run on the resetting device once its slot is filled: unwraps the handed-over AMK with the
 * secret it generated and checks it against the identity from reset verify, so a substituted
 * AMK fails before anything is committed.
 */
export async function openDeviceRecovery(input: {
  secret: Uint8Array;
  sealedAmk: Uint8Array;
  reset: Extract<ParsedResetPayload, { hasKeys: true }>;
}): Promise<UnlockedAccount> {
  if (input.sealedAmk.length !== AMK_WRAPPER_BYTES) throw new KeyBundleError();
  const { reset, sealedAmk } = input;
  const amk = await withKek(input.secret, "deviceRecovery", (kek) =>
    unwrapAmk({
      kek,
      envelope: sealedAmk,
      keyId: reset.identity.keyId,
      purpose: "device-recovery",
    }),
  );
  return openAccount(amk, reset.identity);
}
