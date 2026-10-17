import { convexQuery } from "@convex-dev/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useConvexAuth } from "convex/react";
import { selectWorkspace } from "backend/src/workspaces/selection";

type WorkspaceList = Exclude<FunctionReturnType<typeof api.workspaces.list>, string>;
/** Workspace summary exposed to the active workspace context and its consumers. */
export type WorkspaceSummary = WorkspaceList[number];

type WorkspaceContextValue = {
  workspaces: WorkspaceSummary[];
  workspace?: WorkspaceSummary;
  workspaceId?: Id<"workspaces">;
  isLoading: boolean;
  error: Error | null;
  isProvisioning: boolean;
  provisionError: Error | null;
  retryProvisioning: () => void;
  setWorkspace: (workspaceId: Id<"workspaces">) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const STORAGE_KEY = "radium.workspace";

/**
 * Loads the signed-in user's workspaces, provisions a personal workspace when
 * the list is empty, and persists the active selection in browser storage.
 * Query and provisioning failures are exposed separately so callers can show
 * the appropriate state and retry provisioning without changing selection.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { data, isPending, error } = useQuery(
    convexQuery(api.workspaces.list, isAuthenticated ? {} : "skip"),
  );
  const ensurePersonalWorkspace = useMutation(api.workspaces.ensurePersonalWorkspace);
  const provisioned = useRef(false);
  const pendingSelection = useRef<string | undefined>(undefined);
  const [preferredId, setPreferredId] = useState<string>();
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<Error | null>(null);

  const provisionPersonalWorkspace = useCallback(() => {
    if (!isAuthenticated || provisioned.current) return;
    provisioned.current = true;
    setIsProvisioning(true);
    setProvisionError(null);
    void ensurePersonalWorkspace({})
      .catch((error: unknown) => {
        provisioned.current = false;
        setProvisionError(
          error instanceof Error ? error : new Error("Failed to prepare a personal workspace."),
        );
      })
      .finally(() => setIsProvisioning(false));
  }, [ensurePersonalWorkspace, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      provisioned.current = false;
      setProvisionError(null);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setPreferredId(stored);
  }, []);

  const workspaces = Array.isArray(data) ? data : [];
  // A create/restore mutation can resolve before the list subscription includes its result.
  // Keep the selection pending instead of immediately falling back to the old workspace.
  const workspace = selectWorkspace(workspaces, preferredId, pendingSelection.current);

  useEffect(() => {
    if (
      !isAuthenticated ||
      isPending ||
      !Array.isArray(data) ||
      data.length > 0 ||
      provisioned.current
    ) {
      return;
    }
    provisionPersonalWorkspace();
  }, [data, isAuthenticated, isPending, provisionPersonalWorkspace]);

  useEffect(() => {
    if (
      pendingSelection.current &&
      workspaces.some((item) => item._id === pendingSelection.current)
    ) {
      pendingSelection.current = undefined;
    }
  }, [workspaces]);

  useEffect(() => {
    if (!workspace) return;
    setPreferredId((current) => (current === workspace._id ? current : workspace._id));
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, workspace._id);
    }
  }, [workspace]);

  function setWorkspace(workspaceId: Id<"workspaces">) {
    pendingSelection.current = workspaces.some((item) => item._id === workspaceId)
      ? undefined
      : workspaceId;
    setPreferredId(workspaceId);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, workspaceId);
  }

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        workspace,
        workspaceId: workspace?._id,
        isLoading: authLoading || (isAuthenticated && isPending),
        error,
        isProvisioning,
        provisionError,
        retryProvisioning: provisionPersonalWorkspace,
        setWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

/**
 * Read the accessible workspace list, current selection, loading/errors, and
 * selection/provisioning callbacks; throws outside `WorkspaceProvider`.
 */
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  return context;
}
