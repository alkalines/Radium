import { useAuth, useListAccounts } from "@better-auth-ui/react";
import { cn } from "@/lib/utils";
import { ActiveSessions } from "./active-sessions";
import { ChangePassword } from "./change-password";
import { EncryptionSettings } from "./encryption-settings";
import { LinkedAccounts } from "./linked-accounts";

export type SecuritySettingsProps = {
  className?: string;
};

/**
 * Renders the security settings layout including password management, linked accounts, and active sessions.
 *
 * OPAQUE accounts use encryption-aware password management; classic accounts retain ChangePassword.
 * Each registered auth plugin may contribute `securityCards` (for example passkeys, delete-user).
 *
 * @param className - Optional additional CSS class names for the outer container.
 * @returns The security settings container as a JSX element.
 */
export function SecuritySettings({ className }: SecuritySettingsProps) {
  const { authClient, emailAndPassword, plugins, socialProviders } = useAuth();
  const { data: accounts, isPending: isAccountsPending } = useListAccounts(authClient);
  const hasOpaqueAccount = accounts?.some((account) => account.providerId === "opaque");

  return (
    <div className={cn("flex w-full flex-col gap-8", className)}>
      {!isAccountsPending &&
        accounts &&
        (hasOpaqueAccount ? (
          <EncryptionSettings />
        ) : (
          emailAndPassword?.enabled && <ChangePassword />
        ))}
      {!!socialProviders?.length && <LinkedAccounts />}
      <ActiveSessions />
      {plugins.flatMap(
        (plugin) =>
          plugin.securityCards?.map((Card, index) => (
            <Card key={`${plugin.id}-${index.toString()}`} />
          )) ?? [],
      )}
    </div>
  );
}
