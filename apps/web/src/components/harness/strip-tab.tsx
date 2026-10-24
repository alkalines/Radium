import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shape shared by everything that can own the Panel (Home, session Tabs). The active one takes the
 * Panel's surface and rounded top, so it reads as the Panel growing up into the Tab strip
 * (Connected tab, `docs/Interface_Design.md` §2).
 */
export function stripTabClassName(isActive: boolean) {
  return cn(
    "relative flex h-9 shrink-0 items-center rounded-t-[10px] transition-colors",
    isActive ? "bg-background text-foreground" : "text-subtle-foreground",
  );
}

/** A Tab strip item that is not a session Tab, such as Home. */
export function StripTab({
  isActive,
  flushStart = false,
  className,
  children,
}: {
  isActive: boolean;
  /** The item sits on the Panel's left edge: no left ear, and the Panel squares that corner. */
  flushStart?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(stripTabClassName(isActive), !isActive && "text-muted-foreground", className)}
    >
      {isActive ? <TabEars hideStart={flushStart} /> : null}
      {children}
    </div>
  );
}

/**
 * Concave corners at the active Tab's base that curve into the Panel's top edge. The mask cuts a
 * quarter circle out of a Panel-colored square; it shapes the surface and paints no gradient.
 */
export function TabEars({ hideStart = false }: { hideStart?: boolean }) {
  return (
    <>
      {hideStart ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 -left-2 size-2 bg-background mask-[radial-gradient(circle_at_0_0,transparent_8px,black_8.5px)]"
        />
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-2 bottom-0 size-2 bg-background mask-[radial-gradient(circle_at_100%_0,transparent_8px,black_8.5px)]"
      />
    </>
  );
}
