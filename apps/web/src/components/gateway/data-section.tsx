import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Section heading followed by a Group-list-shaped container (`rounded-2xl border bg-card`) for
 * data-dense content such as tables and charts that cannot be `Row`s. Mirrors `GroupList`'s
 * heading so every Settings section reads the same (`docs/Interface_Design.md` §5.2).
 */
export function DataSection({
  title,
  description,
  action,
  className,
  contentClassName,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Classes for the section root, for example a grid `col-span`. */
  className?: string;
  /** Classes for the `bg-card` container, for example padding. */
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", className)}>
      {title || action ? (
        <div className="flex min-h-7 items-end justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? <h2 className="text-sm font-medium">{title}</h2> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      <div
        className={cn(
          "min-w-0 flex-1 overflow-hidden rounded-2xl border bg-card",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
