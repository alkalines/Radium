import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The empty-Session ambient layer: a brand-tinted glow behind a masked dot field, drifting slowly.
 * It is the only decorative element in the product (`docs/Interface_Design.md` §5.3); unmount it as
 * soon as the Session has a message. The drift is CSS so it stays off the main thread, and it stops
 * under reduced motion.
 */
function SessionAmbient({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="session-ambient"
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      {...props}
    >
      <div className="absolute inset-[-10%] animate-ambient-drift opacity-60 motion-reduce:animate-none dark:opacity-45">
        <div className="absolute top-[28%] left-[30%] size-[38%] rounded-full bg-brand/40 blur-[90px]" />
        <div className="absolute top-[36%] left-[46%] size-[30%] rounded-full bg-signal-running/30 blur-[90px]" />
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(var(--subtle-foreground)_1px,transparent_1px)] bg-size-[14px_14px] opacity-25 mask-[radial-gradient(ellipse_45%_40%_at_50%_45%,black,transparent)]" />
    </div>
  );
}

export { SessionAmbient };
