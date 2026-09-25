export type WorkspaceSelectionItem = {
  _id: string;
};

/**
 * Resolve the active workspace without treating two absent IDs as a pending
 * selection. A pending ID is only held while a create/restore result catches
 * up with the reactive workspace list.
 */
export function selectWorkspace<T extends WorkspaceSelectionItem>(
  workspaces: readonly T[],
  preferredId: string | undefined,
  pendingId: string | undefined,
): T | undefined {
  const selected = workspaces.find((item) => item._id === preferredId);
  if (selected) return selected;

  if (pendingId !== undefined && pendingId === preferredId) return undefined;
  return workspaces[0];
}
