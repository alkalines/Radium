import * as React from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";

import { variants } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type TerminalLine = {
  /** Stable key; lines are appended, so reusing an id re-animates the wrong row. */
  id: string;
  stream: "stdin" | "stdout" | "stderr" | "system";
  text: string;
};

const streamClass: Record<TerminalLine["stream"], string> = {
  stdin: "text-foreground",
  stdout: "text-muted-foreground",
  stderr: "text-destructive",
  system: "text-signal-running",
};

const streamPrefix: Record<TerminalLine["stream"], string> = {
  stdin: "$",
  stdout: " ",
  stderr: "!",
  system: "›",
};

/**
 * Worker output in the Append pattern: lines that exist on mount render statically, and only lines
 * that arrive afterwards reveal. Rendering is presentational; the caller owns buffering and caps.
 */
function TerminalLog({
  lines,
  lineNumbers = false,
  className,
  ...props
}: React.ComponentProps<"ol"> & { lines: TerminalLine[]; lineNumbers?: boolean }) {
  return (
    <ol
      data-slot="terminal-log"
      role="log"
      aria-live="polite"
      className={cn("flex min-w-0 flex-col font-mono text-xs leading-relaxed", className)}
      {...props}
    >
      <AnimatePresence initial={false}>
        {lines.map((line, index) => (
          <m.li
            key={line.id}
            data-stream={line.stream}
            variants={variants.reveal}
            initial="hidden"
            animate="visible"
            className={cn("flex min-w-0 gap-3", streamClass[line.stream])}
          >
            {lineNumbers ? (
              <span className="w-6 shrink-0 text-right text-muted-foreground/50 tabular-nums select-none">
                {index + 1}
              </span>
            ) : null}
            <span className="w-2 shrink-0 select-none" aria-hidden="true">
              {streamPrefix[line.stream]}
            </span>
            <span className="min-w-0 break-all whitespace-pre-wrap">{line.text}</span>
          </m.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

export { TerminalLog };
