import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Square brand tile that identifies a Project or workspace in lists, Tabs, and the Session context.
 * Pass an `initial` for Projects, or an icon as `children` (workspaces carry an icon name).
 */
export function ProjectTile({
  initial,
  children,
  className,
}: {
  initial?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-brand text-[10px] leading-none font-semibold text-white [&_svg]:size-2.5",
        className,
      )}
    >
      {children ?? initial}
    </span>
  );
}
