import { useAuth } from "@better-auth-ui/react";
import { type SyntheticEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { signInAndUnlock } from "@/lib/auth/opaque-account";
import { cn } from "@/lib/utils";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { PasswordInput } from "./encryption/password-input";
import type { SocialLayout } from "./provider-buttons";
import { SETUP_ENCRYPTION_PATH } from "./setup-encryption";

export type SignInProps = {
  className?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
};

/**
 * OPAQUE sign-in: proves the password without sending it, opens the account key bundle with the
 * export key and unlocks this device under its Settings → Security policy. An account created
 * before encryption is recognized from the server's answer and continues to "Set up encryption"
 * (`signInAndUnlock`).
 */
export function SignIn({ className }: SignInProps) {
  const { basePaths, localization, viewPaths, navigate, redirectTo, Link } = useAuth();
  const refreshAuthSession = useRefreshAuthSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    setPending(true);
    setError(null);
    const result = await signInAndUnlock({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      allowClassic: true,
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      const passwordInput = form.elements.namedItem("password");
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
      return;
    }
    await refreshAuthSession();
    navigate({
      to: result.data.needsEncryptionSetup
        ? `${basePaths.auth}/${SETUP_ENCRYPTION_PATH}`
        : redirectTo,
    });
  };

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">{localization.auth.signIn}</CardTitle>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                placeholder="Enter your email"
                required
                disabled={pending}
              />
            </Field>

            <Field data-invalid={!!error}>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="password">{localization.auth.password}</FieldLabel>
                <Link
                  href={`${basePaths.auth}/${viewPaths.auth.forgotPassword}`}
                  className="text-sm text-foreground underline-offset-4 hover:underline"
                >
                  {localization.auth.forgotPasswordLink}
                </Link>
              </div>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="current-password"
                disabled={pending}
                placeholder="Enter your password"
                invalid={!!error}
              />
              <FieldError>{error}</FieldError>
            </Field>

            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {localization.auth.signIn}
            </Button>
          </FieldGroup>
        </form>

        <div className="mt-4">
          <FieldDescription className="text-center">
            {localization.auth.needToCreateAnAccount}{" "}
            <Link
              href={`${basePaths.auth}/${viewPaths.auth.signUp}`}
              className="underline underline-offset-4"
            >
              {localization.auth.signUp}
            </Link>
          </FieldDescription>
        </div>
      </CardContent>
    </Card>
  );
}
