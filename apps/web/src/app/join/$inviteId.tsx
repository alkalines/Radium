import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { fromBase64Url } from "radium-crypto";
import { Button } from "@/components/ui/button";
import { GroupList, RowBlock } from "@/components/harness/group-list";
import { TrustPrompt } from "@/components/trust/trust-prompt";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { acceptAccessLink, TrustRequiredError } from "@/lib/crypto/workspace-keys";
import { keyManager } from "@/lib/crypto/key-manager";

export const Route = createFileRoute("/join/$inviteId")({
  staticData: { pageTitle: "Workspace access" },
  component: JoinWorkspace,
});
function JoinWorkspace() {
  const { inviteId } = Route.useParams();
  const status = useKeyStatus();
  const secret = useRef<Uint8Array | null>(null);
  const captured = useRef(false);
  const generation = useRef(0);
  const [result, setResult] = useState<"ready" | "busy" | "accepted" | "failed">("ready");
  const [prompt, setPrompt] = useState<TrustRequiredError | null>(null);
  useEffect(() => {
    const mounted = ++generation.current;
    if (!captured.current) {
      captured.current = true;
      const fragment = window.location.hash.slice(1);
      // Strip the capability before asynchronous work; it must never enter a request/history URL.
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
      try {
        const decoded = fromBase64Url(fragment);
        if (decoded.length !== 32) throw new Error("Invalid link");
        secret.current = decoded;
      } catch {
        setResult("failed");
      }
    }
    const unsubscribe = keyManager.subscribe(() => {
      if (keyManager.getSnapshot().state !== "unlocked") {
        secret.current?.fill(0);
        secret.current = null;
      }
    });
    return () => {
      unsubscribe();
      // React StrictMode immediately remounts effects; a real unmount must still zero the secret.
      queueMicrotask(() => {
        if (generation.current === mounted) {
          secret.current?.fill(0);
          secret.current = null;
        }
      });
    };
  }, []);
  async function accept() {
    if (!secret.current || status.state !== "unlocked") return;
    setResult("busy");
    try {
      await acceptAccessLink(inviteId, secret.current);
      secret.current?.fill(0);
      secret.current = null;
      setResult("accepted");
    } catch (error) {
      if (error instanceof TrustRequiredError) {
        setPrompt(error);
        setResult("ready");
      } else {
        secret.current?.fill(0);
        secret.current = null;
        setResult("failed");
      }
    }
  }
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 p-6">
      <h1 className="text-base font-medium">Workspace access</h1>
      <GroupList>
        <RowBlock>
          <p className="mb-4 text-sm text-muted-foreground">
            {result === "accepted"
              ? "Workspace keys accepted. The owner's device will verify your join proof."
              : result === "failed"
                ? "The link is invalid, expired, or could not be verified. Request a new access link."
                : status.state !== "unlocked"
                  ? "Sign in and unlock encryption before accepting this access link. If you lock this page, reopen the original link."
                  : "Accept the workspace key after verifying the owner's identity."}
          </p>
          {result !== "accepted" && result !== "failed" ? (
            <Button
              size="sm"
              disabled={status.state !== "unlocked" || result === "busy"}
              onClick={() => void accept()}
            >
              Accept workspace keys
            </Button>
          ) : null}
        </RowBlock>
      </GroupList>
      {prompt ? (
        <TrustPrompt
          error={prompt}
          onApproved={() => {
            setPrompt(null);
            void accept();
          }}
          onDenied={() => {
            secret.current?.fill(0);
            secret.current = null;
            setPrompt(null);
            setResult("failed");
          }}
        />
      ) : null}
    </main>
  );
}
