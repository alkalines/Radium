import { useAuth } from "@better-auth-ui/react";
import { createAccountKeys } from "radium-crypto";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { signUpWithKeys } from "@/lib/auth/opaque-account";
import { wipeAccount, type UnlockedAccount } from "@/lib/crypto/account-keys";
import { cn } from "@/lib/utils";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { NewPasswordFields, readNewPassword } from "./encryption/new-password-fields";
import { RecoveryKeySetup } from "./encryption/recovery-key";
import type { SocialLayout } from "./provider-buttons";

export type SignUpProps = {
  className?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
  /**
   * Runs instead of the post-sign-up redirect, but only when the sign-up
   * created an immediately usable session.
   */
  onSignUpSuccess?: () => void;
};

/** Secrets of a sign-up in progress. Held in a ref, never in React state. */
type PendingSignUp = {
  email: string;
  name: string;
  password: string;
  account: UnlockedAccount;
  recovery: { entropy: Uint8Array; words: string[] };
};

/**
 * OPAQUE sign-up (Authentication.md "Sign-up"): name, email and a new password, then the new
 * account keys' 24-word recovery key, which must be confirmed before the account is created.
 * The request carries only email, password-derived OPAQUE messages, name and the ciphertext key
 * bundle; the password and keys never leave the browser.
 */
export function SignUp({ className, onSignUpSuccess }: SignUpProps) {
  const { basePaths, localization, viewPaths, navigate, redirectTo, Link } = useAuth();
  const refreshAuthSession = useRefreshAuthSession();
  const [step, setStep] = useState<"details" | "recovery">("details");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingSignUp = useRef<PendingSignUp | null>(null);

  function discardSecrets() {
    const current = pendingSignUp.current;
    if (!current) return;
    wipeAccount(current.account);
    current.recovery.entropy.fill(0);
    pendingSignUp.current = null;
  }

  useEffect(() => discardSecrets, []);

  const handleDetails = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { password, problem } = readNewPassword(form);
    if (problem !== null) {
      setError(problem);
      return;
    }

    const formData = new FormData(form);
    setPending(true);
    setError(null);
    const { amk, identity, recovery } = await createAccountKeys();
    discardSecrets();
    pendingSignUp.current = {
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      password,
      account: { amk, identity },
      recovery,
    };
    setPending(false);
    setStep("recovery");
  };

  const handleConfirmed = async () => {
    const current = pendingSignUp.current;
    if (!current) {
      setStep("details");
      return;
    }

    setPending(true);
    setError(null);
    const result = await signUpWithKeys({
      email: current.email,
      password: current.password,
      name: current.name,
      account: current.account,
      recoveryEntropy: current.recovery.entropy,
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }
    discardSecrets();
    await refreshAuthSession();

    if (!result.data.signedIn) {
      toast.success("Account created. Sign in to continue.");
      navigate({ to: `${basePaths.auth}/${viewPaths.auth.signIn}` });
    } else if (onSignUpSuccess) {
      onSignUpSuccess();
    } else {
      navigate({ to: redirectTo });
    }
  };

  return (
    <Card className={cn("w-full", step === "recovery" ? "max-w-md" : "max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          {step === "recovery" ? "Save your recovery key" : localization.auth.signUp}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {step === "recovery" && pendingSignUp.current ? (
          <div className="flex flex-col gap-4">
            <RecoveryKeySetup
              words={pendingSignUp.current.recovery.words}
              confirmLabel="Create account"
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
                setStep("details");
              }}
            >
              Start over
            </Button>
          </div>
        ) : (
          <form onSubmit={handleDetails}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="name">{localization.auth.name}</FieldLabel>
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  placeholder={localization.auth.namePlaceholder}
                  required
                  disabled={pending}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={localization.auth.emailPlaceholder}
                  required
                  disabled={pending}
                />
              </Field>

              <NewPasswordFields label={localization.auth.password} disabled={pending} />
              <FieldError>{error}</FieldError>

              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}
                Continue
              </Button>
            </FieldGroup>
          </form>
        )}

        <FieldDescription className="mt-4 text-center">
          {localization.auth.alreadyHaveAnAccount}{" "}
          <Link
            href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
            className="underline underline-offset-4"
          >
            {localization.auth.signIn}
          </Link>
        </FieldDescription>
      </CardContent>
    </Card>
  );
}
