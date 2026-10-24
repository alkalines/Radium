import type { ReactNode } from "react";

import { resolveTileColorName } from "backend/src/workspaces/colors";
import { cn } from "@/lib/utils";

/**
 * Square tile that identifies a Project or workspace in lists, Tabs, and the Session context.
 * Pass an `initial`, or an icon as `children` (workspaces and Projects carry an icon name).
 * `color` is a persisted tile color name; missing or unknown names use the brand color.
 */
export function ProjectTile({
  initial,
  color,
  children,
  className,
}: {
  initial?: string;
  color?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: `var(--tile-${resolveTileColorName(color)})` }}
      className={cn(
        // `!` beats the `[&_svg:not([class*='size-'])]:size-4` rule of menu items and buttons,
        // which would otherwise grow the glyph to the tile's full size, and the focused-item
        // `focus:**:text-accent-foreground` rule, which would tint the glyph off the tile color.
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] text-[10px] leading-none font-semibold text-white! [&_svg]:size-2.5! [&_svg]:text-white!",
        className,
      )}
    >
      {children ?? initial}
    </span>
  );
}
