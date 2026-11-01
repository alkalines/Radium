import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderIcon, MessageSquareDashedIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { isWorkerOnline } from "backend/src/worker/presence";
import { ProjectGlyph, type ProjectSummary } from "@/components/projects/project-glyph";
import { AcpAgentIcon } from "@/components/session/acp/agent-icon";
import { acpActionError } from "@/components/session/acp/use-acp-session";
import type {
  SessionAgentDefinition,
  SessionAgentRow,
  SessionWorker,
} from "@/components/session/agents";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { formatRelativeTime, groupByRecency } from "./recency";

type AgentSession = Pick<
  FunctionReturnType<typeof api.acp.SearchAgentSessionIndex>[number],
  "_id" | "worker" | "agentId" | "sessionId" | "chat"
>;

/**
 * Opens an indexed agent session: its chat when Radium has one, otherwise a chat bound to it
 * (`acp.OpenAgentSession`). `pending` holds the rows being opened so repeated clicks are ignored.
 */
export function useOpenAgentSession() {
  const open = useMutation(api.acp.OpenAgentSession);
  const navigate = useNavigate();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  async function openRow(workspace: Id<"workspaces">, row: AgentSession) {
    if (pending.has(row._id)) return;
    setPending((current) => new Set(current).add(row._id));
    try {
      const chatId =
        row.chat ??
        (await open({
          workspace,
          worker: row.worker,
          agentId: row.agentId,
          sessionId: row.sessionId,
        }));
      await navigate({ to: "/chat/$chatId", params: { chatId } });
    } catch (error) {
      const message = acpActionError(error);
      if (message) toast.error(message);
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(row._id);
        return next;
      });
    }
  }

  return { pending, openRow };
}

export function AgentSessions({
  workspace,
  agent,
  reports,
  workers,
  workersLoaded,
  projects,
  query,
  now,
  presenceNow,
}: {
  workspace: Id<"workspaces">;
  agent: SessionAgentDefinition;
  reports: SessionAgentRow[];
  workers: SessionWorker[];
  workersLoaded: boolean;
  projects: ProjectSummary[];
  query: string;
  now: number;
  presenceNow: number;
}) {
  const sync = useMutation(api.acp.SyncAgentSessions);
  const { pending, openRow } = useOpenAgentSession();
  const search = query.trim();
  const { results, status, loadMore } = usePaginatedQuery(
    api.acp.ListAgentSessionIndex,
    search ? "skip" : { workspace, agentId: agent.agentId },
    { initialNumItems: 30 },
  );
  const searchResults = useQuery(
    api.acp.SearchAgentSessionIndex,
    search ? { workspace, agentId: agent.agentId, query: search } : "skip",
  );
  useEffect(() => {
    void sync({ workspace, agentId: agent.agentId }).catch((error) => {
      const message = acpActionError(error);
      if (message) toast.error(message);
    });
  }, [agent.agentId, sync, workspace]);

  const states = reports.flatMap((report) => (report.sessionsSync ? [report.sessionsSync] : []));
  const syncing = states.some((state) => state.status === "running");
  const failed = states.filter((state) => state.status === "failed").sort((a, b) => b.at - a.at)[0];
  const latest = states.filter((state) => state.status === "done").sort((a, b) => b.at - a.at)[0];
  const rows = search ? searchResults : results;
  const loading = search ? searchResults === undefined : status === "LoadingFirstPage";
  const groups = groupByRecency(rows ?? [], now, (row) => row.updatedAt);
  const multipleWorkers = new Set(reports.map((report) => report.worker)).size > 1;

  return (
    <>
      <header className="flex h-10 items-center gap-2.5 pr-1.5 pl-3">
        <AcpAgentIcon icon={agent.icon} name={agent.name} className="size-4" />
        <h1 className="min-w-0 flex-1 truncate text-base font-medium" title={agent.name}>
          {agent.name}
        </h1>
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={failed?.error}
        >
          {syncing ? (
            <>
              <Spinner /> Syncing…
            </>
          ) : failed ? (
            `Sync failed${failed.error ? `: ${failed.error}` : ""}`
          ) : latest ? (
            `Synced ${formatRelativeTime(latest.at, now)}`
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Refresh ${agent.name} sessions`}
          onClick={() => {
            void sync({ workspace, agentId: agent.agentId }).catch((error) => {
              const message = acpActionError(error);
              if (message) toast.error(message);
            });
          }}
        >
          <RefreshCwIcon />
        </Button>
      </header>
      {loading ? (
        <div
          className="flex flex-col gap-4 px-3"
          aria-busy="true"
          aria-label="Loading agent sessions"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {syncing ? <Spinner /> : <MessageSquareDashedIcon />}
            </EmptyMedia>
            <EmptyTitle>
              {syncing
                ? "Syncing sessions…"
                : search
                  ? "No matching sessions"
                  : "No agent sessions yet"}
            </EmptyTitle>
            <EmptyDescription>
              {search
                ? `No sessions match “${query}”.`
                : `Sessions from ${agent.name} appear here.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <h2 className="flex h-8 items-center px-3 text-sm font-normal text-subtle-foreground">
              {group.label}
            </h2>
            <ul className="flex flex-col">
              {group.sessions.map((row) => {
                const project = projects.find((item) => item._id === row.project);
                const worker = workers.find((item) => item.workerId === row.worker);
                const offline =
                  workersLoaded &&
                  presenceNow > 0 &&
                  (!worker || !isWorkerOnline(worker.lastSeenAt, presenceNow));
                const directory =
                  project?.name ??
                  (row.cwd
                    .replace(/[\\/]+$/, "")
                    .split(/[\\/]/)
                    .pop() ||
                    row.cwd);
                return (
                  <li key={row._id}>
                    <button
                      type="button"
                      onClick={() => void openRow(workspace, row)}
                      disabled={pending.has(row._id)}
                      className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
                    >
                      {pending.has(row._id) ? (
                        <Spinner />
                      ) : project ? (
                        <ProjectGlyph project={project} />
                      ) : (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span
                        className={`min-w-0 flex-1 truncate ${row.title?.trim() ? "" : "text-muted-foreground"}`}
                      >
                        {row.title?.trim() || "Untitled session"}
                      </span>
                      <span
                        className="max-w-32 truncate text-xs text-muted-foreground"
                        title={row.cwd}
                      >
                        {directory}
                      </span>
                      {multipleWorkers ? (
                        <span
                          className="max-w-24 truncate text-xs text-muted-foreground"
                          title={worker?.name ?? row.worker}
                        >
                          {worker?.name ?? row.worker}
                        </span>
                      ) : null}
                      {offline ? (
                        <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                      ) : null}
                      <time
                        dateTime={new Date(row.updatedAt).toISOString()}
                        title={new Date(row.updatedAt).toLocaleString()}
                        className="shrink-0 text-xs text-subtle-foreground tabular-nums"
                      >
                        {formatRelativeTime(row.updatedAt, now)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      {!search && status === "CanLoadMore" ? (
        <Button variant="outline" size="sm" className="self-center" onClick={() => loadMore(30)}>
          Load more
        </Button>
      ) : null}
      {!search && status === "LoadingMore" ? (
        <Spinner className="self-center text-muted-foreground" />
      ) : null}
    </>
  );
}
