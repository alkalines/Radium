"use client";

import { useAuth, useSession, useSignOut } from "@better-auth-ui/react";
import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { forgetClassicPassword } from "@/lib/auth/classic-migration";
import { keyManager } from "@/lib/crypto/key-manager";
import { cn } from "@/lib/utils";

export type SignOutProps = {
  className?: string;
};

/**
 * Signs the current user out on mount and renders a centered spinner while the operation completes.
 * The user's keys are forgotten on this device first (every tab locks and the device key is
 * deleted), so they never outlive the session even if the sign-out request fails.
 *
 * @param className - Optional additional class names appended to the root element
 * @returns The spinner shown during sign-out
 */
export function SignOut({ className }: SignOutProps) {
  const { authClient, basePaths, navigate, viewPaths } = useAuth();
  const { data: session, isPending: isSessionPending } = useSession(authClient);
  const userId = session?.user.id;

  const { mutate: signOut } = useSignOut(authClient, {
    onError: () => {
      navigate({
        to: `${basePaths.auth}/${viewPaths.auth.signIn}`,
        replace: true,
      });
    },
    onSuccess: () =>
      navigate({
        to: `${basePaths.auth}/${viewPaths.auth.signIn}`,
        replace: true,
      }),
  });

  const hasSignedOut = useRef(false);

  useEffect(() => {
    if (isSessionPending || hasSignedOut.current) return;
    hasSignedOut.current = true;

    forgetClassicPassword();
    const forgetKeys = userId ? keyManager.forget(userId) : Promise.resolve();
    void forgetKeys.finally(() => signOut());
  }, [isSessionPending, signOut, userId]);

  return <Spinner className={cn("mx-auto my-auto", className)} />;
}
