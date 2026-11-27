import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { eq, lower, materialize, useLiveQuery } from "@tanstack/react-db";

import type { ProjectSummary } from "@/components/projects/project-glyph";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { authClient } from "@/lib/auth-client";
import { useTrpc } from "@/lib/trpc";
import { useCollection, type CollectionSource } from "./factory";
import { plainRow, type FolderRow, type ProjectRow } from "./shapes";

/** The query source's two collections share one `projects.list` read; see `useProjectList`. */
const LIST_REUSE = { staleTime: 1_000 };

/**
 * Workspace `workspace`'s Projects in `projects.list`'s shape and order (by lowercased name, then
 * age, then id), `undefined` until loaded. Worker folders and the default Worker are the owner's
 * only (host paths); `canManage` is the creator's or the owner's. Two collections, the Projects and
 * (owners only) their folders, joined in one live query.
 */
export function useProjectList(workspace: string | undefined): {
  data: ProjectSummary[] | undefined;
  isError: boolean;
} {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { workspaces } = useWorkspace();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const role = workspaces.find((candidate) => candidate.id === workspace)?.role;
  const isOwner = role === "owner";

  const projectSource = useMemo(
    (): CollectionSource<"projects", ProjectSummary[]> | undefined =>
      workspace && role
        ? {
            shape: "projects",
            selector: { workspace },
            queryKey: trpc.projects.list.queryKey({ workspace }),
            // Both collections read the plain `projects.list` entry, so one fetch serves them (a
            // second read within a second of the first reuses its answer).
            queryFn: () =>
              queryClient.fetchQuery(trpc.projects.list.queryOptions({ workspace }, LIST_REUSE)),
            select: (projects) =>
              projects.map(
                ({ folders: _folders, defaultWorkerId: _default, ...project }, order) => ({
                  ...project,
                  creator: null,
                  order,
                }),
              ),
          }
        : undefined,
    [queryClient, role, trpc, workspace],
  );
  const folderSource = useMemo(
    (): CollectionSource<"projectFolders", FolderRow[]> | undefined =>
      workspace && isOwner
        ? {
            shape: "projectFolders",
            selector: { workspace },
            // Read from the `projects.list` entry the Projects collection reads too.
            queryKey: [["projects", "folders"], { input: { workspace }, type: "query" }],
            queryFn: async () => {
              const projects = await queryClient.fetchQuery(
                trpc.projects.list.queryOptions({ workspace }, LIST_REUSE),
              );
              return projects.flatMap((project) =>
                (project.folders ?? []).map((folder, position) => ({
                  id: `${project.id}:${folder.workerId}`,
                  project: project.id,
                  workerId: folder.workerId,
                  directory: folder.directory,
                  position,
                  isDefault: folder.workerId === project.defaultWorkerId,
                })),
              );
            },
            select: (folders) => folders,
          }
        : undefined,
    [isOwner, queryClient, trpc, workspace],
  );
  const projects = useCollection(projectSource);
  const folders = useCollection(folderSource);
  const needsFolders = isOwner;

  const { data, isReady, isLoadingError } = useLiveQuery((q) => {
    if (!projects || (needsFolders && !folders)) return undefined;
    const sorted = q
      .from({ project: projects })
      .orderBy(({ project }) => lower(project.name))
      .orderBy(({ project }) => project.order)
      .orderBy(({ project }) => project.id);
    if (!folders) return sorted;
    return sorted.select(({ project }) => ({
      ...project,
      folders: materialize(
        q
          .from({ folder: folders })
          .where(({ folder }) => eq(folder.project, project.id))
          .orderBy(({ folder }) => folder.position),
      ),
    }));
  });

  const list = useMemo(() => {
    if (!projects || (needsFolders && !folders) || !isReady) return undefined;
    // Without the folder join (members) rows have no `folders`.
    const rows = data as (ProjectRow & { folders?: FolderRow[] })[];
    return rows.map((row): ProjectSummary => {
      const { order: _order, creator, folders: own = [], ...project } = plainRow(row);
      const defaultFolder = own.find((folder) => folder.isDefault);
      return {
        ...project,
        // Shape rows name the creator; `projects.list` rows already decided.
        canManage: project.canManage || isOwner || (creator !== null && creator === userId),
        ...(own.length > 0
          ? { folders: own.map(({ workerId, directory }) => ({ workerId, directory })) }
          : {}),
        ...(defaultFolder ? { defaultWorkerId: defaultFolder.workerId } : {}),
      };
    });
  }, [data, folders, isOwner, isReady, needsFolders, projects, userId]);
  return { data: list, isError: isLoadingError };
}
