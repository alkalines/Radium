import { BoxesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { WorkspacePageHeader, ownerOnlyNotice } from "@/components/settings/workspace-page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/**
 * Shared states for workspace Settings routes: Skeleton rows while the workspace loads, an
 * `Empty` notice without a current workspace, and the owner-only notice for members on pages the
 * backend serves only to owners (`docs/Radium_Gateway/Ownership.md`). Renders `children` once the
 * page may show its content.
 *
 * @param title - Page title for the member notice header.
 * @param ownerOnlyDetail - Muted line saying what stays with the owner; when omitted members see
 * the page itself (it handles its own member mode).
 */
export function WorkspaceSettingsGate({
  title,
  ownerOnlyDetail,
  children,
}: {
  title: string;
  ownerOnlyDetail?: string;
  children: ReactNode;
}) {
  const { workspace, isLoading } = useWorkspace();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="mx-4 h-5 w-48" />
        <Skeleton className="h-12 rounded-2xl" />
        <Skeleton className="h-12 rounded-2xl" />
        <Skeleton className="h-12 rounded-2xl" />
      </div>
    );
  }

  if (!workspace) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxesIcon />
          </EmptyMedia>
          <EmptyTitle>No workspace selected</EmptyTitle>
          <EmptyDescription>
            Choose a workspace from the sidebar heading to see its settings.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // The backend returns these pages' data to owners only, so members get the notice instead of a
  // read-only copy of the page.
  if (workspace.role === "member" && ownerOnlyDetail) {
    return (
      <>
        <WorkspacePageHeader title={title} description={ownerOnlyNotice} />
        <p className="px-4 text-sm text-muted-foreground">{ownerOnlyDetail}</p>
      </>
    );
  }

  return children;
}
