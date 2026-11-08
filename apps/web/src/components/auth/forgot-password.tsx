import { useAuth } from "@better-auth-ui/react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type ForgotPasswordProps = {
  className?: string;
};

/**
 * Explains how to get a reset link. Radium has no email delivery yet, so the operator issues
 * links from the Convex CLI (Authentication.md "Forgot password"); this view sends no request,
 * which also avoids revealing whether an email has an account.
 */
export function ForgotPassword({ className }: ForgotPasswordProps) {
  const { basePaths, localization, viewPaths, Link } = useAuth();

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">{localization.auth.forgotPassword}</CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 text-sm">
        <p>
          Ask the operator of this Radium deployment for a password reset link. Radium does not send
          reset emails yet.
        </p>
        <p className="text-muted-foreground">
          The link lets you set a new password. Your chats stay readable if you have your recovery
          key or another device where you are still signed in and unlocked.
        </p>

        <FieldDescription className="mt-2 text-center">
          <Link
            href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
            className="underline underline-offset-4"
          >
            Back to sign-in
          </Link>
        </FieldDescription>
      </CardContent>
    </Card>
  );
}
