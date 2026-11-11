import { useAuth, useSession } from "@better-auth-ui/react";
import { createAccountKeys } from "radium-crypto";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { attachWithKeys } from "@/lib/auth/opaque-account";
import { forgetClassicPassword, peekClassicPassword } from "@/lib/auth/classic-migration";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { wipeAccount, type UnlockedAccount } from "@/lib/crypto/account-keys";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { cn } from "@/lib/utils";
import { NewPasswordFields, readNewPassword } from "./encryption/new-password-fields";
import { PasswordInput } from "./encryption/password-input";
import { RecoveryKeySetup } from "./encryption/recovery-key";

/** Auth path segment of {@link SetupEncryption} (`/auth/setup-encryption`). */
export const SETUP_ENCRYPTION_PATH = "setup-encryption";

/** Secrets of a migration in progress. Held in a ref, never in React state. */
type PendingSetup = {
  currentPassword: string;
  newPassword: string;
  account: UnlockedAccount;
  recovery: { entropy: Uint8Array; words: string[] };
};

/**
 * Migration of a classic (pre-encryption) account to OPAQUE (Authentication.md "Migrating
 * Existing Accounts"): the current classic password proves the account, a new password replaces
 * it, and the new account keys' recovery key must be confirmed before anything is sent. The new
 * password must differ from the classic one: the server has seen the classic password, so it
 * could derive the export key from it (the plugin refuses reuse too).
 *
 * Arriving from the sign-in form, the classic password just typed is reused (held in memory by
 * `classic-migration.ts`), so only the new password is asked. Arriving later (the Window's chip,
 * a reload) asks for the current password too.
 *
 * Only classic sessions (key status `no-keys`) can use it; signed-out visitors and accounts that
 * already have keys see a short notice with a link instead of the form.
 */
export function SetupEncryption({ className }: { className?: string }) {
  const { authClient, basePaths, viewPaths, navigate, Link } = useAuth();
  const { data: session } = useSession(authClient);
  const status = useKeyStatus();
  const refreshAuthSession = useRefreshAuthSession();
  const [step, setStep] = useState<"passwords" | "recovery">("passwords");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null);
  const pendingSetup = useRef<PendingSetup | null>(null);

  function discardSecrets() {
    const current = pendingSetup.current;
    if (!current) return;
    wipeAccount(current.account);
    current.recovery.entropy.fill(0);
    pendingSetup.current = null;
  }

  useEffect(() => discardSecrets, []);

  const userId = session?.user.id;
  const email = session?.user.email;
  const heldPassword = userId ? peekClassicPassword(userId) : null;
  // Decided only from settled states; no automatic redirect, which would race the session
  // refetch that follows a classic sign-in.
  const alreadyEncrypted =
    step === "passwords" && (status.state === "locked" || status.state === "unlocked");

  const handlePasswords = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = heldPassword ?? String(new FormData(form).get("currentPassword") ?? "");
    const next = readNewPassword(form);
    setNewPasswordError(next.problem);
    if (next.problem !== null) return;
    if (next.password === currentPassword) {
      setNewPasswordError(
        "Choose a new password. The server has seen your current one, so it cannot protect your keys.",
      );
      return;
    }

    setPending(true);
    setError(null);
    const { amk, identity, recovery } = await createAccountKeys();
    discardSecrets();
    pendingSetup.current = {
      currentPassword,
      newPassword: next.password,
      account: { amk, identity },
      recovery,
    };
    form.reset();
    setPending(false);
    setStep("recovery");
  };

  const handleConfirmed = async () => {
    const current = pendingSetup.current;
    if (!current || !userId || !email) {
      setStep("passwords");
      return;
    }

    setPending(true);
    setError(null);
    const result = await attachWithKeys({
      userId,
      email,
      currentPassword: current.currentPassword,
      newPassword: current.newPassword,
      account: current.account,
      recoveryEntropy: current.recovery.entropy,
    });
    setPending(false);
    discardSecrets();
    // Success or not, the held password is done: a retry asks for it again.
    forgetClassicPassword();

    if (!result.ok) {
      // The attempt used up these keys' payload; a retry starts with fresh keys.
      setError(result.message);
      setStep("passwords");
      return;
    }
    await refreshAuthSession();
    toast.success("Encryption is set up. Other devices were signed out.");
    navigate({ to: "/" });
  };

  return (
    <Card className={cn("w-full", step === "recovery" ? "max-w-md" : "max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          {step === "recovery" ? "Save your recovery key" : "Set up encryption"}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {!session ? (
          <FieldDescription>
            Sign in with your current password first.{" "}
            <Link
              href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
              className="underline underline-offset-4"
            >
              Sign in
            </Link>
          </FieldDescription>
        ) : alreadyEncrypted ? (
          <FieldDescription>Encryption is already set up for this account.</FieldDescription>
        ) : step === "recovery" && pendingSetup.current ? (
          <div className="flex flex-col gap-4">
            <RecoveryKeySetup
              words={pendingSetup.current.recovery.words}
              confirmLabel="Set up encryption"
              pending={pending}
              error={error}
              onConfirmed={handleConfirmed}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                discardSecrets();
                setError(null);
                setStep("passwords");
              }}
            >
              Start over
            </Button>
          </div>
        ) : (
          <form onSubmit={handlePasswords}>
            <FieldGroup>
              <FieldDescription>
                This account was created before encryption. Choose a new password: it will encrypt
                your keys, and your current password stops working. Other devices are signed out.
              </FieldDescription>

              {/* Lets password managers match the saved login. */}
              <input
                type="hidden"
                name="username"
                autoComplete="username"
                value={session?.user.email ?? ""}
              />

              {heldPassword === null ? (
                <Field data-invalid={!!error}>
                  <FieldLabel htmlFor="currentPassword">Current password</FieldLabel>
                  <PasswordInput
                    id="currentPassword"
                    name="currentPassword"
                    autoComplete="current-password"
                    disabled={pending || !session}
                    invalid={!!error}
                  />
                  <FieldError>{error}</FieldError>
                </Field>
              ) : (
                <FieldError>{error}</FieldError>
              )}

              <NewPasswordFields
                label="New password"
                disabled={pending || !session}
                error={newPasswordError}
              />

              <Button type="submit" disabled={pending || !session}>
                {pending && <Spinner />}
                Continue
              </Button>
            </FieldGroup>
          </form>
        )}

        <div className="mt-4 flex justify-center">
          <Link
            href="/"
            className="text-sm underline-offset-4 hover:underline"
            onClick={forgetClassicPassword}
          >
            Not now
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
