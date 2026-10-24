import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lifecycle of a Run or Step. This is the only input for status color and status motion; map
 * backend status to it once at the data boundary (`docs/Interface_Design.md` §4).
 */
export type RunState =
  | "idle"
  | "queued"
  | "thinking"
  | "streaming"
  | "executing"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export const runStateLabel: Record<RunState, string> = {
  idle: "idle",
  queued: "queued",
  thinking: "thinking",
  streaming: "streaming",
  executing: "executing",
  awaiting: "awaiting approval",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

const signalClass: Record<RunState, string> = {
  idle: "bg-signal-idle",
  queued: "bg-signal-idle",
  thinking: "bg-signal-thinking",
  streaming: "bg-signal-running",
  executing: "bg-signal-running",
  awaiting: "bg-signal-awaiting",
  succeeded: "bg-signal-success",
  failed: "bg-destructive",
  cancelled: "bg-signal-idle",
};

/** States that show an Ambient pulse. Terminal states never pulse. */
const pulsingStates = new Set<RunState>(["thinking", "streaming", "executing", "awaiting"]);

/**
 * Signal dot for a `RunState`, optionally followed by its Machine text label. The dot alone is not
 * accessible status; pass `label` (or keep the default) unless an adjacent element names the state.
 */
function AgentStatus({
  state,
  label = runStateLabel[state],
  hideLabel = false,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  state: RunState;
  label?: React.ReactNode;
  hideLabel?: boolean;
}) {
  const isPulsing = pulsingStates.has(state);

  return (
    <span
      data-slot="agent-status"
      data-state={state}
      className={cn("inline-flex items-center gap-2 text-xs text-muted-foreground", className)}
      {...props}
    >
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        {isPulsing ? (
          <span
            className={cn(
              "absolute inset-0 rounded-full animate-signal-pulse motion-reduce:animate-none",
              signalClass[state],
            )}
          />
        ) : null}
        <span className={cn("relative size-2 rounded-full", signalClass[state])} />
      </span>
      <span className={cn(hideLabel && "sr-only")}>{label}</span>
    </span>
  );
}

export { AgentStatus };
