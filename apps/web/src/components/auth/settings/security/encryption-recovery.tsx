import { api } from "backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { CryptoError, generateRecoveryKey } from "radium-crypto";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PhraseField, RecoveryKeySetup } from "@/components/auth/encryption/recovery-key";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { buildRecoveryWrapper, sealDeviceRecovery } from "@/lib/crypto/account-keys";
import { keyManager, KeysLockedError } from "@/lib/crypto/key-manager";

type RecoveryDraft = { entropy: Uint8Array; words: string[] };

function discardRecovery(draft: RecoveryDraft | null) {
  if (!draft) return;
  draft.entropy.fill(0);
  draft.words.fill("");
}

/** Recovery-factor management for an unlocked account; generated words live only in a ref. */
export function EncryptionRecoverySettings({
  keyId,
  reason,
}: {
  keyId: string | null;
  reason: string;
}) {
  return (
    <>
      <RecoveryKeyCard keyId={keyId} reason={reason} />
      <DeviceRecoveryCard unlocked={keyId !== null} reason={reason} />
    </>
  );
}

function RecoveryKeyCard({ keyId, reason }: { keyId: string | null; reason: string }) {
  const setRecoveryWrapper = useMutation(api.e2ee.setRecoveryWrapper);
  const draft = useRef<RecoveryDraft | null>(null);
  const submitting = useRef(false);
  const [step, setStep] = useState<"idle" | "setup">("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      discardRecovery(draft.current);
      draft.current = null;
    },
    [],
  );

  function cancel() {
    discardRecovery(draft.current);
    draft.current = null;
    setError(null);
    setStep("idle");
  }

  function generate() {
    if (!keyId || submitting.current) return;
    discardRecovery(draft.current);
    draft.current = generateRecoveryKey();
    setError(null);
    setStep("setup");
  }

  async function save() {
    if (!keyId || !draft.current || submitting.current) return;
    const recovery = draft.current;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const wrapper = await keyManager.useAmk((amk, identity) =>
        buildRecoveryWrapper({ account: { amk, identity }, recoveryEntropy: recovery.entropy }),
      );
      // Do not publish a completed wrap after this form was discarded by a lock/account change.
      if (draft.current !== recovery) return;
      // `v.bytes()` arguments are standalone ArrayBuffers.
      await setRecoveryWrapper({ keyId, recoveryWrapper: wrapper.slice().buffer });
      cancel();
      toast.success(
        "Recovery key saved. The old recovery key no longer works for password resets.",
      );
    } catch (failure) {
      setError(
        failure instanceof KeysLockedError
          ? "Unlock this device before saving a recovery key."
          : "Could not confirm the recovery key was saved. Keep both keys until you save successfully.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="encryption-recovery-heading">
      <h2 id="encryption-recovery-heading" className="mb-3 px-4 text-sm font-medium">
        Recovery key
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Saving a new recovery key replaces the old one. The old key will no longer work for
            password resets.
          </p>
          {!keyId && <p className="text-sm text-muted-foreground">{reason}</p>}
          {step === "setup" && draft.current ? (
            <>
              <RecoveryKeySetup
                words={draft.current.words}
                confirmLabel="Save new recovery key"
                pending={pending}
                error={error}
                onConfirmed={save}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={pending}
                onClick={cancel}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={!keyId}
              onClick={generate}
            >
              Generate a new recovery key
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function DeviceRecoveryCard({ unlocked, reason }: { unlocked: boolean; reason: string }) {
  const offerDeviceRecovery = useMutation(api.e2ee.offerDeviceRecovery);
  const submitting = useRef(false);
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!unlocked || submitting.current) return;
    const form = event.currentTarget;
    const words = String(new FormData(form).get("deviceRecoveryWords") ?? "");
    submitting.current = true;
    setPending(true);
    setError(null);
    setSent(false);
    try {
      const sealed = await keyManager.useAmk((amk, identity) =>
        sealDeviceRecovery({ words, account: { amk, identity } }),
      );
      if (!active.current) return;
      await offerDeviceRecovery({
        slotId: sealed.slotId,
        sealedAmk: sealed.sealedAmk.slice().buffer,
      });
      setSent(true);
    } catch (failure) {
      if (failure instanceof CryptoError && failure.code === "BAD_RECOVERY_PHRASE") {
        setError("These words are not a valid code");
      } else if (failure instanceof KeysLockedError) {
        setError("Unlock this device before helping another device recover.");
      } else {
        setError("Could not send the recovery response. Try again.");
      }
    } finally {
      form.reset();
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="encryption-device-recovery-heading">
      <h2 id="encryption-device-recovery-heading" className="mb-3 px-4 text-sm font-medium">
        Help another device recover
      </h2>
      <Card>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <p className="text-sm text-muted-foreground">
                Only type words shown on your own device's password reset page. Anyone holding them
                gets your encryption keys.
              </p>
              {!unlocked && <p className="text-sm text-muted-foreground">{reason}</p>}
              <PhraseField
                name="deviceRecoveryWords"
                label="Code from your other device"
                wordCount={12}
                disabled={!unlocked || pending}
                error={error}
              />
              {sent && (
                <p role="status" className="text-sm">
                  Sent. The other device can continue within 15 minutes.
                </p>
              )}
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={!unlocked || pending}
              >
                {pending && <Spinner />}
                Send recovery response
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
