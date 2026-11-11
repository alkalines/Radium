/**
 * OPAQUE account flows of the web app: each calls one `@alkalines/better-auth-opaque` client
 * action with a key bundle from `lib/crypto/account-keys.ts` and hands opened keys to the key
 * manager. Forms call these functions instead of Better Auth UI's email/password mutations.
 *
 * Secrets stay local: passwords and export keys only flow into the plugin and the bundle
 * builders; requests carry explicitly listed fields only (audit I1: never spread form objects).
 * Opened AMKs go to {@link keyManager} and are wiped here afterwards. Results carry only
 * user-facing messages, never secret material.
 */
import { evaluatePasswordStrength, type PasswordStrength } from "@better-auth-ui/core";

import { authClient } from "@/lib/auth-client";
import {
  buildNewKeysPayload,
  buildRewrapPayload,
  KeyBundleError,
  openSignInPayload,
  parseResetPayload,
  wipeAccount,
  type ParsedResetPayload,
  type UnlockedAccount,
} from "@/lib/crypto/account-keys";
import { keyManager } from "@/lib/crypto/key-manager";
import {
  CLASSIC_CREDENTIAL,
  holdClassicPassword,
  isKnownEncryptedAccount,
  rememberEncryptedAccount,
} from "./classic-migration";

/** Outcome of a flow: success data, or a message safe to show. */
export type FlowResult<T = undefined> = { ok: true; data: T } | { ok: false; message: string };

/** Minimum length of a new password; the server never sees the password, so this is the policy. */
export const MIN_PASSWORD_LENGTH = 12;

/** Lowest acceptable strength-meter score for a new password (`fair`). */
const MIN_PASSWORD_SCORE = 2;

/** Scores a new password with the shared strength meter rules under Radium's minimum length. */
export function passwordStrength(password: string): PasswordStrength {
  return evaluatePasswordStrength(password, { minLength: MIN_PASSWORD_LENGTH });
}

/**
 * Client-side password policy for sign-up, change and reset (Authentication.md: OPAQUE leaves
 * offline guessing by a compromised server possible, so length and strength are the defense).
 * Returns a message when the password is not acceptable.
 */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (passwordStrength(password).score < MIN_PASSWORD_SCORE) {
    return "This password is too easy to guess. Make it longer or mix in other characters.";
  }
  return null;
}

type PluginError = { code?: string; message?: string; status: number };

/** Maps plugin and HTTP errors to short messages; never echoes request data. */
function errorMessage(error: PluginError): string {
  switch (error.code) {
    case "INVALID_CREDENTIALS":
    case "INVALID_EMAIL_OR_PASSWORD":
      return "Invalid email or password.";
    case "INVALID_PASSWORD":
      return "The current password is incorrect.";
    case "KEY_STRETCHING_MISMATCH":
    case "INVALID_SERVER_RESPONSE":
      return "The server sent an unexpected or unsupported password challenge. Nothing was sent.";
    case "INVALID_PAYLOAD":
      return "The server rejected the encryption keys. Nothing was changed.";
    case "INVALID_STATE":
      return "This step expired. Start again.";
    case "PASSWORD_REUSED":
      return "Choose a new password. The server has seen your old one, so it cannot protect your keys.";
    case "CREDENTIAL_CHANGED":
      return "Your password was changed elsewhere in the meantime. Sign in again.";
    case "OPAQUE_ACCOUNT_EXISTS":
      return "Encryption is already set up for this account. Sign in again.";
    case "SIGN_UP_DISABLED":
      return "Sign-up is closed on this Radium deployment.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many password attempts for this account. Try again later.";
  }
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  return error.message || "Something went wrong. Try again.";
}

/** Message for a key bundle that does not open after a successful plugin step. */
function bundleFailureMessage(error: unknown): string {
  if (error instanceof KeyBundleError) {
    return "Signed in, but the encryption keys from the server are malformed.";
  }
  return "Signed in, but the encryption keys could not be opened.";
}

/** Shown when the server claims "classic account" for an account this device knows is encrypted. */
const UNEXPECTED_CLASSIC_MESSAGE =
  "The server answered as if this account had no encryption, but it has. Your password was not sent.";

/**
 * Signs in from the password form. OPAQUE first: it opens the returned bundle with the export key
 * and unlocks under the device policy the user set in Settings → Security. A second-factor
 * redirect is reported as an error: the server runs no 2FA plugin in this release.
 *
 * When the server answers `CLASSIC_CREDENTIAL` (an account created before encryption) and
 * `allowClassic` is set, the same password signs in through Better Auth's classic endpoint and is
 * held for "Set up encryption" (`needsEncryptionSetup`). That sends the password to the server,
 * which already stores its hash; it is refused for accounts this device has used with OPAQUE,
 * because a compromised server could send the code to harvest an encrypted account's password.
 *
 * "Unlock" while locked passes `allowClassic: false`: a locked account has keys, so a classic
 * answer can only be a lie. The new session replaces the current one.
 */
export async function signInAndUnlock(input: {
  email: string;
  password: string;
  allowClassic: boolean;
}): Promise<FlowResult<{ userId: string; needsEncryptionSetup: boolean }>> {
  const result = await authClient.signIn.opaque({ email: input.email, password: input.password });
  if (result.error) {
    if (result.error.code !== CLASSIC_CREDENTIAL) {
      return { ok: false, message: errorMessage(result.error) };
    }
    if (!input.allowClassic || (await isKnownEncryptedAccount(input.email))) {
      return { ok: false, message: UNEXPECTED_CLASSIC_MESSAGE };
    }
    return signInClassic(input);
  }

  const data = result.data;
  if (data.twoFactorRedirect) {
    return { ok: false, message: "Two-factor sign-in is not supported with encryption yet." };
  }

  let account: UnlockedAccount;
  try {
    account = await openSignInPayload({ exportKey: data.exportKey, payload: data.payload });
  } catch (error) {
    return { ok: false, message: bundleFailureMessage(error) };
  }

  const userId = data.user.id;
  try {
    await keyManager.unlock({ userId, amk: account.amk, identity: account.identity });
  } finally {
    wipeAccount(account);
  }
  await rememberEncryptedAccount(input.email);
  return { ok: true, data: { userId, needsEncryptionSetup: false } };
}

/** Classic sign-in of an account created before encryption; keeps the password for attach. */
async function signInClassic(input: {
  email: string;
  password: string;
}): Promise<FlowResult<{ userId: string; needsEncryptionSetup: boolean }>> {
  const result = await authClient.signIn.email({ email: input.email, password: input.password });
  if (result.error) {
    return {
      ok: false,
      message: errorMessage({ ...result.error, status: result.error.status ?? 0 }),
    };
  }
  const userId = result.data.user.id;
  holdClassicPassword(userId, input.password);
  return { ok: true, data: { userId, needsEncryptionSetup: true } };
}

/**
 * Creates an OPAQUE account with a fresh key bundle. `account` and `recoveryEntropy` come from
 * `createAccountKeys()` after the user confirmed the recovery key. Keys are unlocked only after
 * the plugin committed the account.
 */
export async function signUpWithKeys(input: {
  email: string;
  password: string;
  name: string;
  account: UnlockedAccount;
  recoveryEntropy: Uint8Array;
}): Promise<FlowResult<{ userId: string; signedIn: boolean }>> {
  const result = await authClient.signUp.opaque({
    email: input.email,
    password: input.password,
    name: input.name,
    payload: (exportKey: string) =>
      buildNewKeysPayload({
        exportKey,
        account: input.account,
        recoveryEntropy: input.recoveryEntropy,
      }),
  });
  if (result.error) return { ok: false, message: errorMessage(result.error) };

  const userId = result.data.user.id;
  const signedIn = result.data.token !== null;
  await rememberEncryptedAccount(input.email);
  if (signedIn) {
    await keyManager.unlock({ userId, amk: input.account.amk, identity: input.account.identity });
  }
  return { ok: true, data: { userId, signedIn } };
}

/**
 * Changes the password of the signed-in, unlocked user and wraps the same AMK under the new
 * password. Throws `KeysLockedError` when locked. An error can arrive after the server already
 * switched the credential (audit I2: revocation and activation errors are reported late), so the
 * UI must not promise that a failure rolled anything back.
 */
export async function changePasswordRewrap(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<FlowResult> {
  const result = await keyManager.useAmk((amk, identity) =>
    authClient.opaque.changePassword({
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      payload: (exportKey: string) => buildRewrapPayload({ exportKey, account: { amk, identity } }),
    }),
  );
  if (result.error) return { ok: false, message: errorMessage(result.error) };
  return { ok: true, data: undefined };
}

/**
 * Migrates the signed-in classic (pre-encryption) account to OPAQUE with a fresh key bundle
 * (Authentication.md "Migrating Existing Accounts"). The classic password proves the account and
 * is sent to the server, which already knows it; the plugin refuses a new password equal to it,
 * because the server could then derive the export key. On success the classic password is gone,
 * every other session is revoked and this tab holds a new session; keys are unlocked only then.
 *
 * A 401 means another tab finished the migration first and revoked this session.
 */
export async function attachWithKeys(input: {
  userId: string;
  email: string;
  currentPassword: string;
  newPassword: string;
  account: UnlockedAccount;
  recoveryEntropy: Uint8Array;
}): Promise<FlowResult> {
  const result = await authClient.opaque.attachCredential({
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    payload: (exportKey: string) =>
      buildNewKeysPayload({
        exportKey,
        account: input.account,
        recoveryEntropy: input.recoveryEntropy,
      }),
  });
  if (result.error) {
    if (result.error.status === 401) {
      return { ok: false, message: "Encryption was set up in another tab. Sign in again." };
    }
    return { ok: false, message: errorMessage(result.error) };
  }
  await rememberEncryptedAccount(input.email);
  await keyManager.unlock({
    userId: input.userId,
    amk: input.account.amk,
    identity: input.account.identity,
  });
  return { ok: true, data: undefined };
}

/** Checks a reset token (without consuming it) and parses the current key bundle. */
export async function verifyResetToken(token: string): Promise<FlowResult<ParsedResetPayload>> {
  const result = await authClient.opaque.verifyResetToken({ token });
  if (result.error) {
    if (result.error.status === 429) return { ok: false, message: errorMessage(result.error) };
    return { ok: false, message: "This reset link is invalid or expired." };
  }
  try {
    return { ok: true, data: parseResetPayload(result.data.payload) };
  } catch {
    return { ok: false, message: "The encryption keys from the server are malformed." };
  }
}

/**
 * Finishes a reset with keys the user recovered (`rewrap`) or with new keys (`new-keys`, which
 * needs the new recovery key's entropy). The token is consumed by the challenge, so a failure
 * needs a new link. Reset creates no session; the caller sends the user to sign in.
 */
export async function resetPassword(input: {
  token: string;
  newPassword: string;
  account: UnlockedAccount;
  newRecoveryEntropy: Uint8Array | null;
}): Promise<FlowResult> {
  const { account, newRecoveryEntropy } = input;
  const result = await authClient.opaque.resetPassword({
    token: input.token,
    newPassword: input.newPassword,
    payload: (exportKey: string) =>
      newRecoveryEntropy
        ? buildNewKeysPayload({ exportKey, account, recoveryEntropy: newRecoveryEntropy })
        : buildRewrapPayload({ exportKey, account }),
  });
  if (result.error) return { ok: false, message: errorMessage(result.error) };
  return { ok: true, data: undefined };
}
