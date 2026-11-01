import type { ComponentProps, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Section heading followed by one Group list (`docs/Interface_Design.md` §2, §5.2): a `bg-card`
 * block shaped like the Composer with Hairline dividers. Children are `Row`s, or any `li` that
 * keeps the Row geometry. `action` sits at the end of the heading (for example an Add button).
 */
export function GroupList({
  title,
  description,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section data-slot="group-list" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {title || action ? (
        // The heading indents to the Row content; bordered actions end on the block's own edge.
        <div className="flex min-h-7 items-end justify-between gap-3 pl-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? <h2 className="text-sm font-medium">{title}</h2> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      <ul className="flex min-w-0 flex-col rounded-2xl border bg-card px-4">{children}</ul>
    </section>
  );
}

/**
 * One entity in a Group list: leading icon · title · optional Tag · optional second-line
 * description · trailing controls. 48px minimum so a description never crowds the controls.
 */
export function Row({
  icon: Icon,
  leading,
  title,
  tag,
  description,
  children,
  className,
  ...props
}: Omit<ComponentProps<"li">, "title"> & {
  icon?: LucideIcon;
  /** Leading visual other than a lucide icon, such as a provider logo or Project tile. */
  leading?: ReactNode;
  title: ReactNode;
  tag?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <li
      data-slot="row"
      className={cn(
        "flex min-h-12 min-w-0 items-center gap-3 border-b py-2.5 last:border-b-0",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : leading}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {tag ? <Tag>{tag}</Tag> : null}
        </div>
        {description ? (
          <div className="truncate text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </li>
  );
}

/** Full-width Row content that is not a title/controls pair, such as a form or an empty note. */
export function RowBlock({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="row"
      className={cn("flex min-w-0 flex-col gap-3 border-b py-3 last:border-b-0", className)}
      {...props}
    />
  );
}

/** Inline 11px label describing a Row (`API key`, `Account`, `Planned`). */
export function Tag({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="tag"
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[2px] border bg-tag px-1 text-[11px] leading-none font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
