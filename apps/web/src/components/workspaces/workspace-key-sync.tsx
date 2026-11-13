import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { configureCryptoClient } from "@/lib/crypto/runtime";
import { refreshOwnPublicKey } from "@/lib/crypto/public-keys";
import { signUnsignedChatKeys } from "@/lib/crypto/chat-keys";
import { syncWorkspaceKeys, TrustRequiredError } from "@/lib/crypto/workspace-keys";
import { trust } from "@/lib/crypto/trust-store";
import {
  IdentityTrustSurface,
  TrustPrompt,
  TrustRollbackDialog,
} from "@/components/trust/trust-prompt";
import { useWorkspace } from "./workspace-provider";

/** Mounted once under WorkspaceProvider; shares the existing authenticated client with crypto. */
export function WorkspaceKeySync() {
  const client = useConvex();
  configureCryptoClient(client);
  const status = useKeyStatus();
  const { workspaces } = useWorkspace();
  useEffect(() => {
    if (status.state !== "unlocked") return;
    let cancelled = false;
    void (async () => {
      await trust.load(true);
      if (cancelled) return;
      await refreshOwnPublicKey();
      await signUnsignedChatKeys();
    })().catch(() => {
      /* Workspace surfaces report trust/locked failures without logging key data. */
    });
    return () => {
      cancelled = true;
    };
  }, [status]);
  return (
    <>
      <TrustRollbackDialog />
      <IdentityTrustSurface />
      {status.state === "unlocked"
        ? workspaces.map((workspace) => (
            <WorkspaceSync key={workspace._id} workspaceId={workspace._id} />
          ))
        : null}
    </>
  );
}
function WorkspaceSync({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const state = useQuery(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  const [prompt, setPrompt] = useState<TrustRequiredError | null>(null);
  const [revision, setRevision] = useState(0);
  const denied = useRef(false);
  useEffect(() => {
    if (!state || denied.current) return;
    let active = true;
    syncWorkspaceKeys(workspaceId).then(
      () => {
        // A pin made elsewhere (an access link, another prompt) resolves this one too.
        if (active) setPrompt(null);
      },
      (error: unknown) => {
        if (active && error instanceof TrustRequiredError) setPrompt(error);
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId, state, revision]);
  if (!prompt) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 max-h-[80svh] w-[min(420px,calc(100vw-2rem))] overflow-auto">
      <TrustPrompt
        error={prompt}
        onApproved={() => {
          setPrompt(null);
          setRevision((value) => value + 1);
        }}
        onDenied={() => {
          denied.current = true;
          setPrompt(null);
        }}
      />
    </div>
  );
}
