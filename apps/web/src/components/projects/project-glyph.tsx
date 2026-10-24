import type { FunctionReturnType } from "convex/server";

import { api } from "backend/convex/_generated/api";
import { ProjectTile } from "@/components/harness/project-tile";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";

/** One Project as listed by `api.projects.list`; `folder` is only present for workspace owners. */
export type ProjectSummary = FunctionReturnType<typeof api.projects.list>[number];

/**
 * A Project's tile: its color with its icon. Projects reuse the workspace icon set, so unknown
 * or missing names fall back to the defaults the same way workspace tiles do.
 */
export function ProjectGlyph({
  project,
  className,
}: {
  project: Pick<ProjectSummary, "color" | "icon">;
  className?: string;
}) {
  return (
    <ProjectTile color={project.color} className={className}>
      <WorkspaceIcon name={project.icon} />
    </ProjectTile>
  );
}
