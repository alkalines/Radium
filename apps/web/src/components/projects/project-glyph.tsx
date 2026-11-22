import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "server/router";
import { ProjectTile } from "@/components/harness/project-tile";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";

/** One Project as listed by `projects.list`; `folders` are only present for workspace owners. */
export type ProjectSummary = inferRouterOutputs<AppRouter>["projects"]["list"][number];

/**
 * A Project's tile: its color with its icon. Projects reuse the workspace icon set, so unknown
 * or missing names fall back to the defaults the same way workspace tiles do.
 */
export function ProjectGlyph({
  project,
  className,
}: {
  project: { color?: string | null; icon?: string | null };
  className?: string;
}) {
  return (
    <ProjectTile color={project.color} className={className}>
      <WorkspaceIcon name={project.icon} />
    </ProjectTile>
  );
}
