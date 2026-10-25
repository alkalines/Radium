import type { ReactNode } from "react";

/**
 * Screen title and description for Settings pages (`docs/Interface_Design.md` §5.2). Workspace
 * pages pass `scope` (tile + workspace name) so the title reads `<scope> / Page` and the
 * workspace a change applies to is never ambiguous. `action` sits at the trailing end.
 */
export function PageHeader({
  title,
  description,
  scope,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  scope?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header data-slot="page-header" className="flex items-start justify-between gap-4 px-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="flex min-w-0 items-center gap-1.5 text-base font-medium">
          {scope ? (
            <>
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                {scope}
              </span>
              <span className="text-subtle-foreground">/</span>
            </>
          ) : null}
          <span className="truncate">{title}</span>
        </h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}
