import { useSession } from "@better-auth-ui/react";
import { LockIcon, ShieldOffIcon } from "lucide-react";
import { type SyntheticEvent, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { PasswordInput } from "./encryption/password-input";
import { SETUP_ENCRYPTION_PATH } from "./setup-encryption";
import { Link } from "@tanstack/react-router";

/**
 * Window-level key state for the Tab strip (`docs/E2EE/Keys.md` "Locked but signed in"): a quiet
 * `Locked` Chip whose dialog unlocks by re-running OPAQUE sign-in for the current email (the new
 * session replaces the current one), or `Set up encryption` for classic accounts, linking to the
 * migration (`/auth/setup-encryption`). Renders nothing while unlocked or signed out.
 */
export function EncryptionNotice() {
  const status = useKeyStatus();

  if (status.state === "no-keys") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground" asChild>
            <Link to="/auth/$path" params={{ path: SETUP_ENCRYPTION_PATH }}>
              <ShieldOffIcon data-icon="inline-start" />
              Set up encryption
            </Link>
          </Button>
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
  const refreshAuthSession = useRefreshAuthSession();

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");

    setPending(true);
    setError(null);
    const result = await signInAndUnlock({ email, password, allowClassic: false });
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
    >
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
