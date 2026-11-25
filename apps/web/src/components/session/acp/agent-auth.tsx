import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { LogInIcon, LogOutIcon } from "lucide-react";

import type { AcpAuthMethod } from "contracts/acp/contract";
import { isKeyedWorkspace, signAcpCommand } from "./acp-crypto";
import { acpActionError } from "./use-acp-session";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";

/** The Worker's answer is polled this often, and for at most this long. */
const AUTH_POLL_MS = 5_000;
const AUTH_WAIT_MS = 10 * 60_000;

/** Agent authentication stays on the Worker; only the issuing owner follows the command. */
export function AcpAgentAuth({
  workspace,
  worker,
  agentId,
  name,
  authMethods,
  logout = false,
  menuLabel,
}: {
  workspace: string;
  worker: string;
  agentId: string;
  name: string;
  authMethods: AcpAuthMethod[];
  logout?: boolean;
  /** Settings renders the same authentication flow inside the agent's actions menu. */
  menuLabel?: string;
}) {
  const trpc = useTrpc();
  const authenticate = useMutation(trpc.acp.authenticate.mutationOptions());
  const signOut = useMutation(trpc.acp.logout.mutationOptions());
  const [busy, setBusy] = useState(false);

  /** Polls the command's result every few seconds while it is pending; this is the only wait. */
  async function follow(command: string) {
    const deadline = Date.now() + AUTH_WAIT_MS;
    while (Date.now() < deadline) {
      const result = await trpcClient().acp.getCommand.query({ command });
      if (result?.status === "done") return;
      if (!result || (result.status !== "pending" && result.status !== "claimed"))
        throw new Error(result?.error ?? "Agent authentication command is no longer available.");
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, AUTH_POLL_MS);
      await promise;
    }
    throw new Error("The Worker did not finish authenticating in time.");
  }

  async function start(methodId?: string) {
    if (busy || (!logout && methodId === undefined)) return;
    setBusy(true);
    try {
      const clientId = crypto.randomUUID();
      // Every agent command is sealed to the Worker and signed by the owner.
      if (!(await isKeyedWorkspace(workspace))) throw new Error("ACP_E2EE_REQUIRED");
      const signed = await signAcpCommand({
        workspaceId: workspace,
        workerId: worker,
        chatId: "",
        clientId,
        command: logout
          ? { kind: "logout", agentId }
          : { kind: "authenticate", agentId, methodId: methodId! },
      });
      const args = { workspace, worker, agentId, clientId, signed };
      const command = logout
        ? await signOut.mutateAsync(args)
        : await authenticate.mutateAsync({ ...args, methodId: methodId! });
      // Keep following after the picker closes, and dispose immediately on a terminal result.
      await follow(command);
      toast.success(`${name}: ${logout ? "signed out" : "signed in"}.`);
    } catch (error) {
      toast.error(acpActionError(error) ?? "Could not authenticate the agent.");
    } finally {
      setBusy(false);
    }
  }

  const methods = authMethods.filter((method) => method.type === "agent");
  if (menuLabel) {
    if (logout) {
      return (
        <DropdownMenuItem
          disabled={busy}
          onSelect={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <LogOutIcon />
          {busy ? "Signing out…" : menuLabel}
        </DropdownMenuItem>
      );
    }
    return (
      <>
        {methods.map((method) => (
          <DropdownMenuItem
            key={method.id}
            disabled={busy}
            title={method.description}
            onSelect={(event) => {
              event.preventDefault();
              void start(method.id);
            }}
          >
            <LogInIcon />
            {busy
              ? "Signing in…"
              : methods.length === 1
                ? menuLabel
                : `${menuLabel} · ${method.name}`}
          </DropdownMenuItem>
        ))}
        {authMethods.some((method) => method.type === "terminal") || methods.length === 0 ? (
          <DropdownMenuItem disabled title="Use the agent's own CLI on the Worker machine.">
            <LogInIcon />
            {menuLabel} · use CLI
          </DropdownMenuItem>
        ) : null}
      </>
    );
  }

  if (logout)
    return (
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void start()}>
        {busy ? "Signing out…" : "Sign out"}
      </Button>
    );
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
