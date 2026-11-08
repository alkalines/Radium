"use client";

import { createQrCodeSvgData, type QrCodeSvgData } from "@better-auth-ui/core";
import { useAuth } from "@better-auth-ui/react";
import { useConvex } from "convex/react";
import { CryptoError, createAccountKeys, generateShortSecret } from "radium-crypto";
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type FlowResult, resetPassword, verifyResetToken } from "@/lib/auth/opaque-account";
import { useRefreshAuthSession } from "@/lib/auth/use-refresh-auth-session";
import {
  deviceRecoverySlotId,
  openDeviceRecovery,
  openWithRecoveryKey,
  wipeAccount,
  type ParsedResetPayload,
  type UnlockedAccount,
} from "@/lib/crypto/account-keys";
import { api } from "backend/convex/_generated/api";
import { cn } from "@/lib/utils";
import { NewPasswordFields, readNewPassword } from "./encryption/new-password-fields";
import { PhraseField, PhraseWords, RecoveryKeySetup } from "./encryption/recovery-key";

/** Layout options for the bare password-reset page. */
export type ResetPasswordProps = { className?: string };

type Step =
  | "verify"
  | "choice"
  | "recovery"
  | "device"
  | "expired"
  | "new-keys"
  | "save-key"
  | "password"
  | "failed";
type DeviceCode = {
  entropy: Uint8Array;
  words: string[];
  slotId: string;
  expiresAt: number;
  qr: QrCodeSvgData;
};

const DEVICE_CODE_LIFETIME = 15 * 60 * 1000;
const NEW_LINK_MESSAGE = "Ask the operator of this Radium deployment for a new reset link.";

/**
 * Recovers existing encryption keys or explicitly creates new ones before an OPAQUE reset.
 * The fragment token and all opened/generated secrets live only in transient refs. Resetting
 * consumes the token and creates no session; success returns the user to sign-in.
 */
export function ResetPassword({ className }: ResetPasswordProps) {
  const { basePaths, viewPaths, navigate } = useAuth();
  const refreshAuthSession = useRefreshAuthSession();
  const convex = useConvex();
  const [step, setStep] = useState<Step>("verify");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const resetRef = useRef<ParsedResetPayload | null>(null);
  const accountRef = useRef<UnlockedAccount | null>(null);
  const recoveryRef = useRef<{ entropy: Uint8Array; words: string[] } | null>(null);
  const deviceRef = useRef<DeviceCode | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  // One verification per token: React's development effect replay would otherwise verify twice and
  // spend the reset paths' small rate-limit budget (5 per minute).
  const verificationRef = useRef<{
    token: string;
    result: Promise<FlowResult<ParsedResetPayload>>;
  } | null>(null);

  const clearDevice = useCallback(() => {
    deviceRef.current?.entropy.fill(0);
    deviceRef.current?.words.fill("");
    deviceRef.current = null;
  }, []);

  const clearSecrets = useCallback(() => {
    if (accountRef.current) wipeAccount(accountRef.current);
    accountRef.current = null;
    recoveryRef.current?.entropy.fill(0);
    recoveryRef.current?.words.fill("");
    recoveryRef.current = null;
    clearDevice();
    tokenRef.current = null;
    resetRef.current = null;
  }, [clearDevice]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++generationRef.current;
    tokenRef.current ??= new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const token = tokenRef.current;

    if (!token) {
      setError(NEW_LINK_MESSAGE);
      setStep("failed");
    } else {
      void (async () => {
        try {
          if (verificationRef.current?.token !== token) {
            verificationRef.current = { token, result: verifyResetToken(token) };
          }
          const result = await verificationRef.current.result;
          if (!mountedRef.current || generation !== generationRef.current) return;
          if (!result.ok) {
            setError(`${result.message} ${NEW_LINK_MESSAGE}`);
            setStep("failed");
            tokenRef.current = null;
            return;
          }
          resetRef.current = result.data;
          setStep(result.data.hasKeys ? "choice" : "new-keys");
        } catch {
          if (!mountedRef.current || generation !== generationRef.current) return;
          setError(`Could not verify this reset link. ${NEW_LINK_MESSAGE}`);
          setStep("failed");
          tokenRef.current = null;
        }
      })();
    }

    return () => {
      mountedRef.current = false;
      ++generationRef.current;
      // React's development effect replay must not lose the already-removed fragment token.
      queueMicrotask(() => {
        if (!mountedRef.current) clearSecrets();
      });
    };
  }, [clearSecrets]);

  useEffect(() => {
    const code = deviceRef.current;
    const reset = resetRef.current;
    if (step !== "device" || !code || !reset?.hasKeys) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const active = () => !cancelled && mountedRef.current && deviceRef.current === code;
    const expire = () => {
      if (!active()) return;
      cancelled = true;
      clearTimeout(pollTimer);
      clearDevice();
      setError("This recovery code expired. Create a new code to continue.");
      setStep("expired");
    };
    const expiryTimer = setTimeout(expire, Math.max(0, code.expiresAt - Date.now()));

    const poll = async () => {
      if (!active()) return;
      if (Date.now() >= code.expiresAt) {
        expire();
        return;
      }
      try {
        const result = await convex.mutation(api.e2ee.takeDeviceRecovery, { slotId: code.slotId });
        if (!active()) return;
        if (Date.now() >= code.expiresAt) {
          expire();
          return;
        }
        if (result) {
          let account: UnlockedAccount;
          try {
            account = await openDeviceRecovery({
              secret: code.entropy,
              sealedAmk: new Uint8Array(result.sealedAmk),
              reset,
            });
          } catch {
            if (!active()) return;
            cancelled = true;
            clearTimeout(expiryTimer);
            clearDevice();
            setError("The other device sent keys that do not open this account");
            setStep("expired");
            return;
          }
          if (!active()) {
            wipeAccount(account);
            return;
          }
          cancelled = true;
          clearTimeout(expiryTimer);
          accountRef.current = account;
          clearDevice();
          setError(null);
          setStep("password");
          return;
        }
        setError(null);
      } catch {
        if (!active()) return;
        setError("Could not check the other device. Waiting to reconnect…");
      }
      if (active()) pollTimer = setTimeout(() => void poll(), 3000);
    };
    pollTimer = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      clearTimeout(expiryTimer);
    };
  }, [clearDevice, convex, step]);

  async function recoverWithWords(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const reset = resetRef.current;
    if (busyRef.current || !reset?.hasKeys) return;
    const form = event.currentTarget;
    const words = String(new FormData(form).get("recoveryWords") ?? "");
    busyRef.current = true;
    setPending(true);
    setError(null);
    try {
      const account = await openWithRecoveryKey({ words, reset });
      if (!mountedRef.current) {
        wipeAccount(account);
        return;
      }
      accountRef.current = account;
      form.reset();
      setStep("password");
    } catch (cause) {
      if (!mountedRef.current) return;
      setError(
        cause instanceof CryptoError && cause.code === "BAD_RECOVERY_PHRASE"
          ? "These words are not a valid recovery key"
          : "This recovery key does not belong to this account",
      );
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function startDeviceRecovery() {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setError(null);
    clearDevice();
    const secret = generateShortSecret();
    try {
      const slotId = await deviceRecoverySlotId(secret.entropy);
      const qr = createQrCodeSvgData(secret.words.join(" "));
      if (!mountedRef.current) return;
      deviceRef.current = { ...secret, slotId, qr, expiresAt: Date.now() + DEVICE_CODE_LIFETIME };
      setStep("device");
    } catch {
      if (mountedRef.current) setError("Could not create a recovery code. Try again.");
    } finally {
      if (deviceRef.current?.entropy !== secret.entropy) {
        secret.entropy.fill(0);
        secret.words.fill("");
      }
      busyRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function createNewKeys(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const form = event.currentTarget;
    if (resetRef.current?.hasKeys && new FormData(form).get("confirmation") !== "create new keys") {
      setError('Type "create new keys" exactly to continue.');
      return;
    }
    busyRef.current = true;
    setPending(true);
    setError(null);
    try {
      const keys = await createAccountKeys();
      if (!mountedRef.current) {
        wipeAccount(keys);
        keys.recovery.entropy.fill(0);
        keys.recovery.words.fill("");
        return;
      }
      accountRef.current = { amk: keys.amk, identity: keys.identity };
      recoveryRef.current = keys.recovery;
      form.reset();
      setStep("save-key");
    } catch {
      if (mountedRef.current) setError("Could not create encryption keys. Try again.");
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  async function submitPassword(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || !tokenRef.current || !accountRef.current) return;
    const form = event.currentTarget;
    const password = readNewPassword(form);
    if (password.problem !== null) {
      setError(password.problem);
      return;
    }
    busyRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await resetPassword({
        token: tokenRef.current,
        newPassword: password.password,
        account: accountRef.current,
        newRecoveryEntropy: recoveryRef.current?.entropy ?? null,
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(`The password reset could not be completed. ${NEW_LINK_MESSAGE}`);
        setStep("failed");
      } else {
        succeeded = true;
      }
    } catch {
      if (mountedRef.current) {
        setError(`The password reset could not be completed. ${NEW_LINK_MESSAGE}`);
        setStep("failed");
      }
    } finally {
      form.reset();
      clearSecrets();
      busyRef.current = false;
      if (mountedRef.current) setPending(false);
    }
    if (succeeded) {
      // The reset revoked every session; drop any cached one before showing sign-in.
      await refreshAuthSession();
      toast.success("Password reset. Sign in with your new password.");
      navigate({ to: `${basePaths.auth}/${viewPaths.auth.signIn}` });
    }
  }

  function returnToChoices() {
    clearDevice();
    setError(null);
    setStep("choice");
  }

  return (
    <Card className={cn("w-full max-w-md", className)}>
      <CardHeader>
        <CardTitle className="text-base font-medium">Reset password</CardTitle>
        <CardDescription>
          {step === "choice"
            ? "Choose how to recover your encrypted data."
            : "Your password and recovery keys stay on this device."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === "verify" && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Checking reset link…
          </p>
        )}
        {step === "failed" && (
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        {step === "choice" && (
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setStep("recovery");
              }}
            >
              Use my recovery key
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void startDeviceRecovery()}
            >
              Use another unlocked device
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setStep("new-keys");
              }}
            >
              Neither — create new keys
            </Button>
            <FieldError>{error}</FieldError>
          </div>
        )}
        {step === "recovery" && (
          <form onSubmit={recoverWithWords}>
            <FieldGroup>
              <PhraseField
                name="recoveryWords"
                label="Recovery key"
                wordCount={24}
                disabled={pending}
                error={error}
              />
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}Recover keys
              </Button>
            </FieldGroup>
          </form>
        )}
        {step === "device" && deviceRef.current && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              On a device where you are signed in and unlocked, open Settings → Security → “Help
              another device recover” and type these words. This code expires in 15 minutes. Keep it
              private.
            </p>
            <PhraseWords words={deviceRef.current.words} />
            <svg
              aria-label="Device recovery words QR code"
              role="img"
              className="size-44 self-center rounded-md border"
              viewBox={`0 0 ${deviceRef.current.qr.size} ${deviceRef.current.qr.size}`}
            >
              <path
                fill="white"
                d={`M0 0h${deviceRef.current.qr.size}v${deviceRef.current.qr.size}H0z`}
              />
              <path fill="black" d={deviceRef.current.qr.path} shapeRendering="crispEdges" />
            </svg>
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner />
              Waiting for your other device…
            </p>
            <FieldError>{error}</FieldError>
          </div>
        )}
        {step === "expired" && (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-muted-foreground">
              {error}
            </p>
            <Button type="button" disabled={pending} onClick={() => void startDeviceRecovery()}>
              {pending && <Spinner />}New code
            </Button>
          </div>
        )}
        {step === "new-keys" && (
          <form onSubmit={createNewKeys}>
            <FieldGroup>
              {resetRef.current?.hasKeys ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Personal chats and notifications stay encrypted to your old keys and become
                    unreadable. They are kept, not deleted: finding your old recovery key later can
                    restore them.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Workspace chats become readable again once a workspace member or owner re-grants
                    access. Your contacts will see that your encryption key changed. No content is
                    re-encrypted by this reset.
                  </p>
                  <Field data-invalid={!!error}>
                    <FieldLabel htmlFor="confirmation">Type create new keys to continue</FieldLabel>
                    <Input
                      id="confirmation"
                      name="confirmation"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={pending}
                      aria-invalid={!!error}
                    />
                  </Field>
                </>
              ) : (
                <FieldDescription>
                  This account has no encryption keys yet. Create your keys and save a recovery key
                  before choosing a new password.
                </FieldDescription>
              )}
              <FieldError>{error}</FieldError>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}Create new keys
              </Button>
            </FieldGroup>
          </form>
        )}
        {step === "save-key" && recoveryRef.current && (
          <RecoveryKeySetup
            words={recoveryRef.current.words}
            confirmLabel="Continue"
            pending={pending}
            onConfirmed={() => {
              recoveryRef.current?.words.fill("");
              setError(null);
              setStep("password");
            }}
          />
        )}
        {step === "password" && (
          <form onSubmit={submitPassword}>
            <FieldGroup>
              <NewPasswordFields label="New password" disabled={pending} error={error} />
              <Button type="submit" disabled={pending}>
                {pending && <Spinner />}Reset password
              </Button>
              <FieldDescription>
                You will need to sign in with the new password afterwards.
              </FieldDescription>
            </FieldGroup>
          </form>
        )}
      </CardContent>
      <CardFooter>
        {step === "recovery" ||
        step === "device" ||
        step === "expired" ||
        (step === "new-keys" && resetRef.current?.hasKeys) ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={returnToChoices}>
            Choose another way
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => navigate({ to: `${basePaths.auth}/${viewPaths.auth.signIn}` })}
          >
            Back to sign in
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
