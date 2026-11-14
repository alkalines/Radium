import { useEffect, useSyncExternalStore } from "react";
import type { Id } from "backend/convex/_generated/dataModel";
import { EncryptionNotice } from "@/components/auth/encryption-notice";
import { hasSealedTelemetry, openTelemetryData, telemetryContent } from "@/lib/crypto/telemetry";
import { useKeyStatus } from "@/lib/crypto/use-key-status";

/** Keeps decrypted views out of React/query state and invalidates them synchronously on lock. */
export function useTelemetryContent<T extends object>(source: T | undefined, workspace?: Id<"workspaces">) {
  const status = useKeyStatus();
  const revision = useSyncExternalStore(telemetryContent.subscribe, telemetryContent.getSnapshot, () => 0);
  const sealed = hasSealedTelemetry(source);
  useEffect(() => {
    if (source && workspace && sealed && status.state === "unlocked") {
      void openTelemetryData(source, workspace);
    }
  }, [source, workspace, sealed, status, revision]);
  if (!source || !sealed) return { data: source, state: "ready" as const };
  if (status.state !== "unlocked") return { data: undefined, state: "locked" as const };
  const opened = workspace ? telemetryContent.get(source, workspace) : undefined;
  return {
    data: opened?.data,
    state: opened?.failed ? "failed" as const : opened?.data ? "ready" as const : "opening" as const,
  };
}

/** Fixed failure text never exposes raw crypto, storage or upstream error details. */
export function TelemetryContentNotice({ state }: { state: "locked" | "opening" | "failed" | "ready" }) {
  return (
    <div className="flex flex-wrap items-center gap-3 py-2 text-sm text-muted-foreground" role="status">
      <span>{state === "locked" ? "Unlock to read telemetry content."
        : state === "failed" ? "Could not verify or decrypt telemetry content. No plaintext fallback was used."
        : "Decrypting telemetry content…"}</span>
      {state === "locked" && <EncryptionNotice />}
    </div>
  );
}
