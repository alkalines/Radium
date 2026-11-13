import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex/react";
import { api } from "backend/convex/_generated/api";
import { safetyNumber } from "radium-crypto";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GroupList, RowBlock } from "@/components/harness/group-list";
import { keyManager } from "@/lib/crypto/key-manager";
import { trust } from "@/lib/crypto/trust-store";
import { trustRequests, type IdentityTrustRequest } from "@/lib/crypto/trust-requests";

/** Explicit first-contact/changed approval; the compared safety number is derived on this device. */
export function TrustPrompt({
  error,
  onApproved,
  onDenied,
}: {
  error: IdentityTrustRequest;
  onApproved: () => void;
  onDenied: () => void;
}) {
  const [number, setNumber] = useState("");
  const names = useQuery(api.e2ee.identityNames, { userIds: [error.identity.userId] });
  const person = names?.[0]?.name ?? "this person";
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    let active = true;
    void keyManager
      .useAmk(async (_, own) =>
        safetyNumber(
          {
            encryptionPublicKey: own.encryption.publicKey,
            signingPublicKey: own.signing.publicKey,
          },
          error.identity,
        ),
      )
      .then((value) => {
        if (active) setNumber(value);
      })
      .catch(() => {
        if (active) setFailure(true);
      });
    return () => {
      active = false;
    };
  }, [error]);
  async function approve(state: "tofu" | "verified") {
    setBusy(true);
    try {
      await trust.pin(error.identity.userId, error.identity, state);
      onApproved();
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }
  const content = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Compare this safety number through a channel you trust before marking it verified.
      </p>
      <p className="break-words text-sm tabular-nums" aria-label="Safety number">
        {number || "Calculating safety number…"}
      </p>
      {error.trustState === "changed" ? (
        <p className="break-words text-sm text-muted-foreground">
          Previous fingerprint: {trust.pinnedFingerprint(error.identity.userId) ?? "Unavailable"}
        </p>
      ) : null}
      <p className="break-words text-sm text-muted-foreground">
        New fingerprint: {error.identity.fingerprint}
      </p>
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          Trust verification failed. No keys were exchanged.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !number || failure}
          onClick={() => void approve("tofu")}
        >
          Approve unverified
        </Button>
        <Button
          size="sm"
          disabled={busy || !number || failure}
          onClick={() => void approve("verified")}
        >
          Numbers match
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDenied}>
          Deny
        </Button>
      </div>
    </div>
  );
  if (error.trustState === "changed")
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Identity key changed</DialogTitle>
            <DialogDescription>
              Key exchange with {person} is blocked. A reset or an untrusted server may have changed
              their identity. The existing pin is retained unless you approve.
            </DialogDescription>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
    );
  return (
    <GroupList title="Approve identity">
      <RowBlock>
        <p className="mb-3 text-sm">First contact with {person}</p>
        {content}
      </RowBlock>
    </GroupList>
  );
}
/** Blocking rollback notice; no repin action can silently lower the device's trusted version. */
export function TrustRollbackDialog() {
  const state = useSyncExternalStore(trust.subscribe, trust.getSnapshot, () => "locked" as const);
  return (
    <Dialog open={state === "rollback"} onOpenChange={() => {}}>
      <DialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Trust store rollback detected</DialogTitle>
          <DialogDescription>
            This server returned an older trust store than this device has already accepted.
            Encryption operations are blocked. Restore the current store before continuing.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => void keyManager.lock()}>
            Lock encryption
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Single Window surface for key exchanges awaiting explicit first-contact/changed approval. */
export function IdentityTrustSurface() {
  const request = useSyncExternalStore(
    trustRequests.subscribe,
    trustRequests.getSnapshot,
    () => null,
  );
  if (!request) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 max-h-[80svh] w-[min(420px,calc(100vw-2rem))] overflow-auto">
      <TrustPrompt
        error={request}
        onApproved={trustRequests.approve}
        onDenied={trustRequests.deny}
      />
    </div>
  );
}
