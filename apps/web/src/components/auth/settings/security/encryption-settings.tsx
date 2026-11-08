import { useAuth, useSession } from "@better-auth-ui/react";
import { type SyntheticEvent, useRef, useState } from "react";
import { toast } from "sonner";

import {
  NewPasswordFields,
  readNewPassword,
} from "@/components/auth/encryption/new-password-fields";
import { PasswordInput } from "@/components/auth/encryption/password-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { changePasswordRewrap } from "@/lib/auth/opaque-account";
import { keyManager, KeysLockedError, type DevicePolicy } from "@/lib/crypto/key-manager";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { EncryptionRecoverySettings } from "./encryption-recovery";

/** Security controls for OPAQUE accounts; only public key status and device policy enter state. */
export function EncryptionSettings() {
  const { authClient } = useAuth();
  const { data: session } = useSession(authClient);
  const status = useKeyStatus();
  const userId = session?.user.id;
  const unlocked = status.state === "unlocked" && status.userId === userId;
  const [locking, setLocking] = useState(false);
  const reason =
    status.state === "no-keys"
      ? "Encryption is not set up for this account."
      : "Unlock this device using the Unlock button in the window notice.";
  // Remount secret-bearing forms when keys lock or the account changes.
  const actionKey = unlocked ? `${userId}:${status.keyId}` : `${userId}:locked`;

  async function lockDevice() {
    setLocking(true);
    try {
      await keyManager.lock();
    } catch {
      toast.error("Could not finish locking this device. Try again.");
    } finally {
      setLocking(false);
    }
  }

  return (
    <>
      <section aria-labelledby="encryption-status-heading">
        <h2 id="encryption-status-heading" className="mb-3 px-4 text-sm font-medium">
          Encryption status
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex flex-col gap-1">
              {unlocked ? (
                <>
                  <p className="break-words font-mono text-[13px]">{status.fingerprint}</p>
                  <p className="text-sm text-muted-foreground">
                    Contacts can compare this identity fingerprint to verify it is you.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">
                    {status.state === "no-keys" ? "Encryption not set up" : "Locked on this device"}
                  </p>
                  <p className="text-sm text-muted-foreground">{reason}</p>
                </>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!unlocked || locking}
              onClick={lockDevice}
            >
              {locking && <Spinner />}
              Lock this device
            </Button>
          </CardContent>
        </Card>
      </section>
      {userId && <DeviceSettings key={userId} userId={userId} />}
      <EncryptedPasswordChange key={`password:${actionKey}`} unlocked={unlocked} reason={reason} />
      <EncryptionRecoverySettings
        key={`recovery:${actionKey}`}
        keyId={unlocked ? status.keyId : null}
        reason={reason}
      />
    </>
  );
}

function DeviceSettings({ userId }: { userId: string }) {
  const [policy, setPolicy] = useState(() => keyManager.getDevicePolicy(userId));
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function savePolicy(next: DevicePolicy) {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      await keyManager.setDevicePolicy(userId, next);
      setPolicy(keyManager.getDevicePolicy(userId));
    } catch {
      setPolicy(keyManager.getDevicePolicy(userId));
      setError("Could not save this device's settings. Try again.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="encryption-device-heading">
      <h2 id="encryption-device-heading" className="mb-3 px-4 text-sm font-medium">
        This device
      </h2>
      <Card>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={pending}>
              <div className="flex items-center justify-between gap-4">
                <FieldLabel htmlFor="encryption-require-password">
                  Require my password to read past chats
                </FieldLabel>
                <Switch
                  id="encryption-require-password"
                  checked={policy.requirePassword}
                  disabled={pending}
                  onCheckedChange={(requirePassword) => savePolicy({ ...policy, requirePassword })}
                />
              </div>
              <FieldDescription>
                When on, keys are forgotten after the last Radium browser tab closes. When off, this
                browser remembers them until you sign out or lock it. Reloading keeps unlocked tabs
                unlocked in either mode.
              </FieldDescription>
            </Field>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="encryption-auto-lock">Auto-lock after inactivity</FieldLabel>
              <Select
                value={policy.autoLockMinutes === null ? "never" : String(policy.autoLockMinutes)}
                disabled={pending}
                onValueChange={(value) =>
                  savePolicy({
                    ...policy,
                    autoLockMinutes: value === "never" ? null : Number(value),
                  })
                }
              >
                <SelectTrigger id="encryption-auto-lock">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="never">Never</SelectItem>
                    {[5, 15, 30, 60].map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {minutes} minutes
                      </SelectItem>
                    ))}
                    <SelectItem value="240">4 hours</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Applies across this browser's Radium tabs, in either mode.
              </FieldDescription>
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
}

function EncryptedPasswordChange({ unlocked, reason }: { unlocked: boolean; reason: string }) {
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!unlocked || submitting.current) return;
    const form = event.currentTarget;
    const next = readNewPassword(form);
    setPasswordError(next.problem);
    setError(null);
    if (next.problem !== null) return;
    const currentPassword = String(new FormData(form).get("currentPassword") ?? "");
    submitting.current = true;
    setPending(true);
    try {
      const result = await changePasswordRewrap({ currentPassword, newPassword: next.password });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      form.reset();
      toast.success("Password changed. Other devices were signed out.");
    } catch (failure) {
      setError(
        failure instanceof KeysLockedError
          ? "Unlock this device before changing your password."
          : "Could not finish changing your password.",
      );
    } finally {
      // Clear DOM-held passwords after every submitted attempt, including ambiguous failures.
      form.reset();
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="encryption-password-heading">
      <h2 id="encryption-password-heading" className="mb-3 px-4 text-sm font-medium">
        Change password
      </h2>
      <Card>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              {!unlocked && <p className="text-sm text-muted-foreground">{reason}</p>}
              <Field data-disabled={!unlocked || pending}>
                <FieldLabel htmlFor="currentPassword">Current password</FieldLabel>
                <PasswordInput
                  id="currentPassword"
                  name="currentPassword"
                  autoComplete="current-password"
                  disabled={!unlocked || pending}
                />
              </Field>
              <NewPasswordFields
                label="New password"
                disabled={!unlocked || pending}
                error={passwordError}
              />
              {error && (
                <div role="alert" className="flex flex-col gap-1">
                  <FieldError>{error}</FieldError>
                  <p className="text-sm text-muted-foreground">
                    The change may already have gone through. If the new password works on your next
                    sign-in, it succeeded.
                  </p>
                </div>
              )}
              <Button
                type="submit"
                size="sm"
                className="self-start"
                disabled={!unlocked || pending}
              >
                {pending && <Spinner />}
                Change password
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
