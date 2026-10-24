import type { ComponentProps, ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import { Slot } from "radix-ui";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/**
 * Home and Settings layout (`docs/Interface_Design.md` §3.4): a 240px side column and the content,
 * centered in the Panel (max 1040px) with 48px top padding. The Panel owns the scroll.
 */
export function SideColumnLayout({
  side,
  sideLabel,
  children,
  contentClassName,
}: {
  side: ReactNode;
  /** Accessible name; when set the side column renders as a `nav` landmark. */
  sideLabel?: string;
  children: ReactNode;
  contentClassName?: string;
}) {
  const Side = sideLabel ? "nav" : "aside";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-260 gap-8 px-4 pt-12 pb-8 md:grid-cols-[240px_minmax(0,1fr)] md:px-10">
        <Side aria-label={sideLabel} className="flex min-w-0 flex-col gap-4">
          {side}
        </Side>
        <div className={cn("flex min-w-0 flex-col gap-8", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}

/**
 * 32px `rounded-xl` side-column entry. Renders a button, or its child with `asChild` (a router
 * `Link`). `isActive` marks the current page with `bg-accent` and `aria-current`.
 */
export function SideColumnItem({
  asChild = false,
  isActive = false,
  className,
  ...props
}: ComponentProps<"button"> & { asChild?: boolean; isActive?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="side-column-item"
      data-active={isActive || undefined}
      aria-current={isActive ? "page" : undefined}
      type={asChild ? undefined : "button"}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-xl px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        isActive && "bg-accent text-foreground hover:bg-accent",
        className,
      )}
      {...props}
    />
  );
}

/** Small (32px) search field for a side column; never a large one. */
export function SideColumnSearch({ className, ...props }: ComponentProps<typeof InputGroupInput>) {
  return (
    <InputGroup className={cn("h-8 rounded-xl border-border bg-card", className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput type="search" {...props} />
    </InputGroup>
  );
}

/** Group heading (`text-subtle-foreground`) over side-column items; `action` sits at its end. */
export function SideColumnSection({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex h-8 min-w-0 items-center justify-between gap-2 pr-1 pl-3 text-sm text-subtle-foreground">
        {title}
        {action}
      </div>
      {children}
    </div>
  );
}
