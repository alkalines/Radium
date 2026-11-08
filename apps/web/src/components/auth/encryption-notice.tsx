import { useSession } from "@better-auth-ui/react";
import { LockIcon, ShieldOffIcon } from "lucide-react";
import { type SyntheticEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth-client";
import { signInAndUnlock } from "@/lib/auth/opaque-account";
import { keyManager } from "@/lib/crypto/key-manager";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { PasswordInput } from "./encryption/password-input";

/**
 * Window-level key state for the Tab strip (`docs/E2EE/Keys.md` "Locked but signed in"): a quiet
 * `Locked` Chip whose dialog unlocks by re-running OPAQUE sign-in for the current email (the new
 * session replaces the current one), or `Encryption not set up` for classic accounts. Renders
 * nothing while unlocked or signed out.
 */
export function EncryptionNotice() {
  const status = useKeyStatus();

  if (status.state === "no-keys") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex h-6 items-center gap-1.5 px-2 text-muted-foreground text-xs">
            <ShieldOffIcon className="size-3.5" />
            Encryption not set up
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">
          This account was created before encryption. Its chats are not end-to-end encrypted yet.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (status.state !== "locked") return null;
  return <UnlockDialog />;
}

function UnlockDialog() {
  const { data: session } = useSession(authClient);
  const email = session?.user.email;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user.id;
  const [requirePassword, setRequirePassword] = useState(false);
  const refreshAuthSession = useRefreshAuthSession();

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setError(null);
    if (next && userId) setRequirePassword(keyManager.getDevicePolicy(userId).requirePassword);
  };

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");

    setPending(true);
    setError(null);
    const result = await signInAndUnlock({ email, password, requirePassword });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      form.reset();
      return;
    }
    // Unlocking is a new sign-in that replaces the session.
    await refreshAuthSession();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs" className="text-muted-foreground">
          <LockIcon data-icon="inline-start" />
          Locked
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Unlock to read</DialogTitle>
          <DialogDescription>
            Enter your password to read past chats on this device. New chats work while locked.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <FieldGroup>
            {/* Lets password managers match the saved login. */}
            <input type="hidden" name="username" autoComplete="username" value={email ?? ""} />

            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="unlock-password">Password</FieldLabel>
              <PasswordInput
                id="unlock-password"
                name="password"
                autoComplete="current-password"
                disabled={pending}
                invalid={!!error}
              />
              <FieldError>{error}</FieldError>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                id="unlock-require-password"
                checked={requirePassword}
                onCheckedChange={(checked) => setRequirePassword(checked === true)}
                disabled={pending}
              />
              <FieldLabel
                htmlFor="unlock-require-password"
                className="cursor-pointer text-sm font-normal"
              >
                Require my password to read past chats
              </FieldLabel>
            </Field>

            <Button type="submit" disabled={pending || !email}>
              {pending && <Spinner />}
              Unlock
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
