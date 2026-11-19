import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "backend/convex/_generated/api";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { Button } from "@/components/ui/button";

/** Cutover is global, not an optional per-workspace encryption mode. */
export function EncryptionCutoverGate({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const state = useQuery(api.e2ee_legacy.cutoverState, isAuthenticated ? {} : "skip");
  const keys = useKeyStatus();
  if (!state?.frozen && !(state?.requiresEncryption && keys.state === "no-keys")) return children;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3">
        <h1 className="text-base font-medium">{state.frozen ? "Encryption migration in progress" : "Set up encryption"}</h1>
        <p className="text-sm text-muted-foreground">
          {state.frozen
            ? "Writes are temporarily paused while existing content is encrypted and verified. Your history is preserved."
            : "Set up your encryption keys to continue. Historical content held in custody will be released to your keys when its audience is ready."}
        </p>
        {!state.frozen && <Button asChild variant="outline"><Link to="/auth/$path" params={{ path: "setup-encryption" }}>Set up encryption</Link></Button>}
      </div>
    </div>
  );
}
