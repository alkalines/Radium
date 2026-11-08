import { useAuth } from "@better-auth-ui/react";
import { type SyntheticEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { signInAndUnlock } from "@/lib/auth/opaque-account";
import { getRequirePasswordDefault, setRequirePasswordDefault } from "@/lib/crypto/key-manager";
import { cn } from "@/lib/utils";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { PasswordInput } from "./encryption/password-input";
import { LEGACY_SIGN_IN_PATH } from "./legacy-sign-in";
import type { SocialLayout } from "./provider-buttons";

export type SignInProps = {
  className?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
};

/**
 * OPAQUE sign-in: proves the password without sending it, opens the account key bundle with the
 * export key and unlocks this device. Classic (pre-encryption) accounts use the separate legacy
 * form; there is no silent fallback to it (shared E2EE contract, decision 4).
 */
export function SignIn({ className }: SignInProps) {
  const { basePaths, localization, viewPaths, navigate, redirectTo, Link } = useAuth();
  const refreshAuthSession = useRefreshAuthSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requirePassword, setRequirePassword] = useState(false);

  // The device default lives in localStorage, so read it after hydration.
  useEffect(() => setRequirePassword(getRequirePasswordDefault()), []);

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    setPending(true);
    setError(null);
    const result = await signInAndUnlock({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      requirePassword,
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      const passwordInput = form.elements.namedItem("password");
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
      return;
    }
    setRequirePasswordDefault(requirePassword);
    await refreshAuthSession();
    navigate({ to: redirectTo });
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
                placeholder={localization.auth.emailPlaceholder}
                required
                disabled={pending}
              />
            </Field>

            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="password">{localization.auth.password}</FieldLabel>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="current-password"
                disabled={pending}
                invalid={!!error}
              />
              <FieldError>{error}</FieldError>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                id="requirePassword"
                checked={requirePassword}
                onCheckedChange={(checked) => setRequirePassword(checked === true)}
                disabled={pending}
              />
              <FieldLabel htmlFor="requirePassword" className="cursor-pointer text-sm font-normal">
                Require my password to read past chats
              </FieldLabel>
            </Field>

            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {localization.auth.signIn}
            </Button>
          </FieldGroup>
        </form>

        <div className="mt-4 flex w-full flex-col items-center gap-3">
          <Link
            href={`${basePaths.auth}/${viewPaths.auth.forgotPassword}`}
            className="text-sm underline-offset-4 hover:underline"
          >
            {localization.auth.forgotPasswordLink}
          </Link>

          <FieldDescription className="text-center">
            {localization.auth.needToCreateAnAccount}{" "}
            <Link
              href={`${basePaths.auth}/${viewPaths.auth.signUp}`}
              className="underline underline-offset-4"
            >
              {localization.auth.signUp}
            </Link>
          </FieldDescription>

          <Link
            href={`${basePaths.auth}/${LEGACY_SIGN_IN_PATH}`}
            className="text-muted-foreground text-xs underline-offset-4 hover:underline"
          >
            Legacy account (before encryption)
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
