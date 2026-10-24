import type { ReactNode } from "react";

import { PageHeader } from "@/components/harness/page-header";
import { ProjectTile } from "@/components/harness/project-tile";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/**
 * `PageHeader` for workspace Settings pages: prefixes the title with the current workspace
 * (`<tile> workspace / Page`, `docs/Interface_Design.md` §5.2) so the scope of every change is
 * explicit. Reads the workspace from `WorkspaceProvider`.
 */
export function WorkspacePageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const { workspace } = useWorkspace();

  return (
    <PageHeader
      title={title}
      description={description}
      action={action}
      scope={
        workspace ? (
          <>
            <ProjectTile>
              <WorkspaceIcon name={workspace.icon} />
            </ProjectTile>
            <span className="truncate">{workspace.name}</span>
          </>
        ) : undefined
      }
    />
  );
}

/**
 * Description for workspace pages a member can open but not change: members use what owners
 * configure (`docs/Radium_Gateway/Ownership.md`), so the page says who can edit it.
 */
export const ownerOnlyNotice =
  "Only workspace owners can change this. You can use what they configure.";
