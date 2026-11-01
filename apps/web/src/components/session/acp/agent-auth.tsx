import { useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpAuthMethod } from "backend/src/acp/contract";
import { Button } from "@/components/ui/button";

/** Agent authentication stays on the Worker; only the issuing owner follows the command. */
export function AcpAgentAuth({
  workspace,
  worker,
  agentId,
  name,
  authMethods,
  logout = false,
}: {
  workspace: Id<"workspaces">;
  worker: string;
  agentId: string;
  name: string;
  authMethods: AcpAuthMethod[];
  logout?: boolean;
}) {
  const convex = useConvex();
  const authenticate = useMutation(api.acp.Authenticate);
  const signOut = useMutation(api.acp.Logout);
  const [busy, setBusy] = useState(false);

  async function follow(command: Id<"acp_commands">) {
    const watch = convex.watchQuery(api.acp.GetCommand, { command });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let unsubscribe: (() => void) | undefined;
    function update() {
      try {
        const result = watch.localQueryResult();
        if (result === undefined || result?.status === "pending" || result?.status === "claimed")
          return;
        unsubscribe?.();
        if (result?.status === "done") resolve();
        else
          reject(
            new Error(result?.error ?? "Agent authentication command is no longer available."),
          );
      } catch (error) {
        unsubscribe?.();
        reject(error);
      }
    }
    unsubscribe = watch.onUpdate(update);
    update();
    await promise;
  }

  async function start(methodId?: string) {
    if (busy || (!logout && methodId === undefined)) return;
    setBusy(true);
    try {
      const args = { workspace, worker, agentId, clientId: crypto.randomUUID() };
      const command = logout
        ? await signOut(args)
        : await authenticate({ ...args, methodId: methodId! });
      // Keep following after the picker closes, and dispose immediately on a terminal result.
      await follow(command);
      toast.success(`${name}: ${logout ? "signed out" : "signed in"}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not authenticate the agent.");
    } finally {
      setBusy(false);
    }
  }

  if (logout)
    return (
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void start()}>
        {busy ? "Signing out…" : "Sign out"}
      </Button>
    );
  const methods = authMethods.filter((method) => method.type === "agent");
  return (
    <div className="flex flex-col items-start gap-1.5">
      {methods.map((method) => (
        <Button
          key={method.id}
          size="xs"
          variant="outline"
          disabled={busy}
          title={method.description}
          onClick={() => void start(method.id)}
        >
          {busy ? "Signing in…" : methods.length === 1 ? "Sign in" : `Sign in · ${method.name}`}
        </Button>
      ))}
      {authMethods.some((method) => method.type === "terminal") || methods.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Sign in on the Worker machine with the agent's own CLI
        </p>
      ) : null}
    </div>
  );
}
