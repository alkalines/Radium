import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Text that grows while a Run streams. Pass the full accumulated string on every update; only the
 * caret is animated so appended text never re-lays-out existing content. The caret disappears as
 * soon as `streaming` is false.
 */
function StreamingText({
  text,
  streaming,
  className,
  ...props
}: React.ComponentProps<"p"> & { text: string; streaming: boolean }) {
  return (
    <p
      data-slot="streaming-text"
      data-state={streaming ? "streaming" : "idle"}
      aria-busy={streaming}
      className={cn("leading-relaxed text-pretty whitespace-pre-wrap", className)}
      {...props}
    >
      {text}
      {streaming ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-[1.1em] w-[0.55ch] translate-y-[0.2em] bg-foreground animate-caret motion-reduce:animate-none"
        />
      ) : null}
    </p>
  );
}

export { StreamingText };
