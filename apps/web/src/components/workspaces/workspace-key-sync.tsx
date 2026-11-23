import { useEffect, useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvex } from "convex/react";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { useTrpc } from "@/lib/trpc";
import { configureCryptoClient } from "@/lib/crypto/runtime";
import { refreshOwnPublicKey } from "@/lib/crypto/public-keys";
import { signUnsignedChatKeys } from "@/lib/crypto/chat-keys";
import { syncWorkspaceKeys, TrustRequiredError } from "@/lib/crypto/workspace-keys";
import { syncWorkerCertificates } from "@/lib/crypto/workers";
import { trust } from "@/lib/crypto/trust-store";
import {
  IdentityTrustSurface,
  TrustPrompt,
  TrustRollbackDialog,
} from "@/components/trust/trust-prompt";
import { useWorkspace } from "./workspace-provider";

/**
 * Mounted once under WorkspaceProvider. Keys go through tRPC; the one Convex client it shares with
 * crypto serves what has no tRPC route yet (ACP, Worker enrollment, historical reads).
 */
export function WorkspaceKeySync() {
  configureCryptoClient(useConvex());
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
            <WorkspaceSync key={workspace.id} workspaceId={workspace.id} />
          ))
        : null}
    </>
  );
}
function WorkspaceSync({ workspaceId }: { workspaceId: string }) {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { data: state } = useQuery(trpc.e2ee.workspaceKeyState.queryOptions({ workspace: workspaceId }));
  // Owners certify newly published Worker keys and drop revoked Workers from the roster.
  const { data: workerKeys } = useQuery(
    trpc.e2ee.workerKeys.queryOptions(
      state?.role === "owner" && state.keyEpoch ? { workspace: workspaceId } : skipToken,
    ),
  );
  const [prompt, setPrompt] = useState<TrustRequiredError | null>(null);
  const [revision, setRevision] = useState(0);
  const denied = useRef(false);
  useEffect(() => {
    if (!state || denied.current) return;
    let active = true;
    syncWorkspaceKeys(workspaceId)
      .then(async (keysChanged) => {
        const rosterChanged =
          state.role === "owner" && state.keyEpoch
            ? await syncWorkerCertificates(workspaceId)
            : false;
        // The sync wrote keys, grants or a roster; refetch instead of waiting for a push.
        if ((keysChanged || rosterChanged) && active) {
          await queryClient.invalidateQueries({ queryKey: trpc.e2ee.pathKey() });
        }
      })
      .then(
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
  }, [workspaceId, state, workerKeys, revision, queryClient, trpc]);
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
