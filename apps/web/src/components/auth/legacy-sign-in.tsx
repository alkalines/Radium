import { useAuth, useSignInEmail } from "@better-auth-ui/react";
import { type SyntheticEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useSignInContinuation } from "@/lib/auth/use-sign-in-continuation";
import { cn } from "@/lib/utils";
import { PasswordInput } from "./encryption/password-input";

/** Auth path segment of {@link LegacySignIn} (`/auth/legacy-sign-in`). */
export const LEGACY_SIGN_IN_PATH = "legacy-sign-in";

/**
 * Classic Better Auth email/password sign-in for accounts created before encryption. Reached only
 * through its explicit link on the sign-in screen (shared E2EE contract, decision 4). These
 * sessions run with key status `no-keys`; migrating the account is not implemented yet.
 */
export function LegacySignIn({ className }: { className?: string }) {
  const { authClient, basePaths, localization, viewPaths, Link } = useAuth();
  const continueSignIn = useSignInContinuation();
  const [pending, setPending] = useState(false);

  const { mutate: signInEmail } = useSignInEmail(authClient, {
    onSettled: () => setPending(false),
    onSuccess: (data) => continueSignIn(data),
  });

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setPending(true);
    signInEmail({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
    });
  };

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">Legacy account sign-in</CardTitle>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <FieldDescription>
              For accounts created before encryption. This sends your password to the server, and
              the account stays unencrypted.
            </FieldDescription>

            <Field>
              <FieldLabel htmlFor="email">{localization.auth.email}</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                disabled={pending}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">{localization.auth.password}</FieldLabel>
              <PasswordInput
                id="password"
                name="password"
                autoComplete="current-password"
                disabled={pending}
              />
            </Field>

            <Button type="submit" variant="outline" disabled={pending}>
              {pending && <Spinner />}
              {localization.auth.signIn}
            </Button>
          </FieldGroup>
        </form>

        <div className="mt-4 flex justify-center">
          <Link
            href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
            className="text-sm underline-offset-4 hover:underline"
          >
            Back to sign-in
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
