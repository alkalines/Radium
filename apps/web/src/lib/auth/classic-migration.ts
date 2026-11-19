/**
 * Client state for moving a classic (pre-encryption) account to OPAQUE from the normal sign-in
 * form (Authentication.md "Migrating Existing Accounts").
 *
 * The server's `CLASSIC_CREDENTIAL` answer is a hint, not proof: a compromised backend could send
 * it for an encrypted account to get the plaintext password through `/sign-in/email`. So this
 * device remembers which emails it has used with OPAQUE and never takes the classic path for them.
 *
 * The classic password the user just typed is held in memory for the "Set up encryption" screen,
 * which needs it once more for attach, so the user does not type it twice. It is never stored.
 */

/** Plugin error code for an account that has only a classic password (plugin opt-in). */
export const CLASSIC_CREDENTIAL = "CLASSIC_CREDENTIAL";

const ENCRYPTED_ACCOUNTS_KEY = "radium.auth.encrypted-accounts.v1";
/** Bound on remembered accounts; the most recent ones are kept. */
const MAX_ENCRYPTED_ACCOUNTS = 32;
/** How long the held classic password stays available to "Set up encryption". */
const HELD_PASSWORD_TTL_MS = 10 * 60_000;

async function accountMarker(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    `radium/encrypted-account/v1/${email.trim().toLowerCase()}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readMarkers(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ENCRYPTED_ACCOUNTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Records that this device used `email` with an OPAQUE credential (sign-in, sign-up, attach). */
export async function rememberEncryptedAccount(email: string): Promise<void> {
  const marker = await accountMarker(email);
  const markers = [marker, ...readMarkers().filter((item) => item !== marker)];
  try {
    localStorage.setItem(
      ENCRYPTED_ACCOUNTS_KEY,
      JSON.stringify(markers.slice(0, MAX_ENCRYPTED_ACCOUNTS)),
    );
  } catch {
    // Not remembered; the classic path stays guarded only by the server's answer.
  }
}

/** Whether this device has used `email` with an OPAQUE credential before. */
export async function isKnownEncryptedAccount(email: string): Promise<boolean> {
  return readMarkers().includes(await accountMarker(email));
}

let heldPassword: { userId: string; password: string; expiresAt: number } | null = null;

/** Keeps the classic password just proven by sign-in for this user's "Set up encryption". */
export function holdClassicPassword(userId: string, password: string): void {
  heldPassword = { userId, password, expiresAt: Date.now() + HELD_PASSWORD_TTL_MS };
}

/** The held classic password of `userId`, or null when none, another user's, or expired. */
export function peekClassicPassword(userId: string): string | null {
  if (!heldPassword) return null;
  if (heldPassword.userId !== userId || Date.now() > heldPassword.expiresAt) {
    heldPassword = null;
    return null;
  }
  return heldPassword.password;
}

/** Drops the held classic password (attach done or failed, "Not now", sign-out). */
export function forgetClassicPassword(): void {
  heldPassword = null;
}
