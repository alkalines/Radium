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
import { KEY_STRETCHING_REJECTED } from "./opaque-guard";

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
      return "Invalid email or password.";
    case "INVALID_PASSWORD":
      return "The current password is incorrect.";
    case KEY_STRETCHING_REJECTED:
    case "KEY_STRETCHING_MISMATCH":
      return "The server asked for an unsupported password hashing profile. Nothing was sent.";
    case "INVALID_PAYLOAD":
      return "The server rejected the encryption keys. Nothing was changed.";
    case "INVALID_STATE":
      return "This step expired. Start again.";
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

/**
 * Signs in with OPAQUE and unlocks: opens the returned bundle with the export key, stores the
 * device policy chosen at sign-in, then unlocks. Also used by "Unlock" while locked (the new
 * session replaces the current one). A second-factor redirect is reported as an error: the
 * server runs no 2FA plugin in this release.
 */
export async function signInAndUnlock(input: {
  email: string;
  password: string;
  requirePassword: boolean;
}): Promise<FlowResult<{ userId: string }>> {
  const result = await authClient.signIn.opaque({ email: input.email, password: input.password });
  if (result.error) return { ok: false, message: errorMessage(result.error) };

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
    const policy = keyManager.getDevicePolicy(userId);
    await keyManager.setDevicePolicy(userId, { ...policy, requirePassword: input.requirePassword });
    await keyManager.unlock({ userId, amk: account.amk, identity: account.identity });
  } finally {
    wipeAccount(account);
  }
  return { ok: true, data: { userId } };
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
