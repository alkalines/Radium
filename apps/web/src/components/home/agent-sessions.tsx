import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderIcon, MessageSquareDashedIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { isWorkerOnline } from "backend/src/worker/presence";
import { ProjectGlyph, type ProjectSummary } from "@/components/projects/project-glyph";
import { AcpAgentIcon } from "@/components/session/acp/agent-icon";
import { acpActionError } from "@/components/session/acp/use-acp-session";
import {
  isKeyedWorkspace,
  openAgentIndexTitle,
  publishAcpBinding,
  signAgentCommands,
  signImportProof,
} from "@/components/session/acp/acp-crypto";
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
import { sealTitle } from "@/lib/crypto/chat-content";
import { createChatKeys, rememberChatSeed } from "@/lib/crypto/chat-keys";
import { KeysLockedError } from "@/lib/crypto/key-manager";
import { cryptoClient } from "@/lib/crypto/runtime";
import { openHistoricalAgentTitle } from "@/lib/crypto/legacy-relay";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { formatRelativeTime, groupByRecency } from "./recency";

/** One agent session index row, as `acp.ListAgentSessionIndex` and `ListUnopenedAgentSessions` return it. */
export type IndexedAgentSession = Pick<
  FunctionReturnType<typeof api.acp.ListAgentSessionIndex>["page"][number],
  "_id" | "worker" | "agentId" | "sessionId" | "chat" | "title" | "sealedTitle" | "legacyContent"
>;

/** Searching keeps loading older pages until this many rows match (or the index is exhausted). */
const SEARCH_MIN_MATCHES = 10;

function showSyncError(error: unknown) {
  const message = acpActionError(error);
  if (message) toast.error(message);
}

/**
 * Requests an index refresh for one agent. A keyed workspace takes one signed `sync_sessions`
 * command per Worker that reports the agent (agent-level commands are owner-only and the Worker
 * ignores unsigned ones); Workers outside the roster are skipped. Throws `KeysLockedError` when a
 * keyed workspace's identity is locked.
 */
export function useSyncAgentSessions() {
  const sync = useMutation(api.acp.SyncAgentSessions);
  return useCallback(
    async (workspace: Id<"workspaces">, agentId: string, workers: readonly string[]) => {
      if (!(await isKeyedWorkspace(workspace))) {
        await sync({ workspace, agentId });
        return;
      }
      const signed = await signAgentCommands({
        workspaceId: workspace,
        workers,
        command: { kind: "sync_sessions", agentId },
      });
      if (signed.length > 0) await sync({ workspace, agentId, signed });
    },
    [sync],
  );
}

/** The sealed box a row's title comes from; a Worker-sealed title supersedes a migrated one. */
function indexTitleBox(row: IndexedAgentSession): ArrayBuffer | undefined {
  if (row.sealedTitle) return row.sealedTitle.box;
  return row.title ? undefined : row.legacyContent?.box;
}

/** Opens a row's title from its Worker-sealed box or, for migrated rows, its historical sidecar. */
async function openIndexTitle(workspace: Id<"workspaces">, row: IndexedAgentSession) {
  if (row.sealedTitle) {
    return openAgentIndexTitle({
      workspaceId: workspace,
      workerId: row.worker,
      agentId: row.agentId,
      sessionId: row.sessionId,
      sealedTitle: row.sealedTitle,
    });
  }
  if (row.legacyContent) {
    const title = await openHistoricalAgentTitle(
      { _id: row._id, legacyContent: row.legacyContent },
      workspace,
    );
    return title ?? "";
  }
  return row.title?.trim() ?? "";
}

/**
 * Titles of agent session index rows. Keyed workspaces store them sealed to the owner key, so
 * they open here (owner only) and only while unlocked; the result maps a row to its text, or
 * `undefined` for an untitled session.
 */
export function useAgentSessionTitles(
  workspace: Id<"workspaces">,
  rows: readonly IndexedAgentSession[],
) {
  const keyStatus = useKeyStatus();
  const unlocked = keyStatus.state === "unlocked";
  const [opened, setOpened] = useState<Record<string, { box: ArrayBuffer; title: string }>>({});
  useEffect(() => {
    if (!unlocked) {
      setOpened((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    const pending = rows.flatMap((row) => {
      const box = indexTitleBox(row);
      return box && opened[row._id]?.box !== box ? [{ row, box }] : [];
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(
      pending.map(async ({ row, box }) => {
        try {
          return [row._id, { box, title: await openIndexTitle(workspace, row) }] as const;
        } catch {
          // Locked keys, recovery custody and unverifiable boxes all read as an untitled session.
          return [row._id, { box, title: "" }] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setOpened((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [opened, rows, unlocked, workspace]);
  return (row: IndexedAgentSession): string | undefined => {
    const plain = row.title?.trim();
    if (plain) return plain;
    if (!row.sealedTitle && !row.legacyContent) return undefined;
    if (!unlocked) return "Locked";
    return opened[row._id]?.title.trim() || undefined;
  };
}

/**
 * Opens an indexed agent session: its chat when Radium has one, otherwise a chat bound to it
 * (`acp.OpenAgentSession`). `pending` holds the rows being opened so repeated clicks are ignored.
 * In a keyed workspace the owner creates the chat keys here, seals the session's title to the new
 * chat key, and signs the import proof that binds the agent session to the chat.
 */
export function useOpenAgentSession() {
  const open = useMutation(api.acp.OpenAgentSession);
  const navigate = useNavigate();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  async function openKeyedChat(workspace: Id<"workspaces">, row: IndexedAgentSession) {
    const title = await openIndexTitle(workspace, row);
    const keys = await createChatKeys({ workspaceId: workspace, scope: "personal" });
    const sealedTitle = title
      ? await sealTitle(
          { title },
          {
            workspaceId: workspace,
            e2eeId: keys.e2eeId,
            epoch: keys.epoch,
            publicKey: keys.publicKey,
          },
        )
      : undefined;
    const chatId = await open({
      workspace,
      worker: row.worker,
      agentId: row.agentId,
      sessionId: row.sessionId,
      e2ee: { keys: keys.keys, ...(sealedTitle ? { sealedTitle } : {}) },
    });
    // Another client may have opened the session first; then the chat has its own keys and
    // binding, and ours are discarded.
    const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
    if (state.e2eeId !== keys.e2eeId) {
      keys.seed.fill(0);
      return chatId;
    }
    rememberChatSeed(chatId, keys.e2eeId, keys.epoch, keys.seed);
    await publishAcpBinding({
      chatId,
      e2eeId: keys.e2eeId,
      scope: "personal",
      members: [],
      version: 1,
      importProof: await signImportProof({
        workspaceId: workspace,
        workerId: row.worker,
        chatId,
        agentId: row.agentId,
        sessionId: row.sessionId,
      }),
    });
    return chatId;
  }

  async function openRow(workspace: Id<"workspaces">, row: IndexedAgentSession) {
    if (pending.has(row._id)) return;
    setPending((current) => new Set(current).add(row._id));
    try {
      const chatId =
        row.chat ??
        ((await isKeyedWorkspace(workspace))
          ? await openKeyedChat(workspace, row)
          : await open({
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
  const syncAgentSessions = useSyncAgentSessions();
  const { pending, openRow } = useOpenAgentSession();
  const search = query.trim().toLowerCase();
  const { results, status, loadMore } = usePaginatedQuery(
    api.acp.ListAgentSessionIndex,
    { workspace, agentId: agent.agentId },
    { initialNumItems: 30 },
  );
  const titleOf = useAgentSessionTitles(workspace, results);
  // A string key keeps the sync effect from re-running on every new `reports` array.
  const syncWorkers = JSON.stringify(reports.map((report) => report.worker));
  useEffect(() => {
    void syncAgentSessions(workspace, agent.agentId, JSON.parse(syncWorkers) as string[]).catch(
      (error) => {
        // Locked keys only mean the refresh cannot be signed yet; Refresh reports it.
        if (!(error instanceof KeysLockedError)) showSyncError(error);
      },
    );
  }, [agent.agentId, syncAgentSessions, syncWorkers, workspace]);

  const states = reports.flatMap((report) => (report.sessionsSync ? [report.sessionsSync] : []));
  const syncing = states.some((state) => state.status === "running");
  const failed = states.filter((state) => state.status === "failed").sort((a, b) => b.at - a.at)[0];
  const latest = states.filter((state) => state.status === "done").sort((a, b) => b.at - a.at)[0];
  // Titles of a keyed workspace exist only here, so search filters the pages loaded so far and
  // pulls more pages until enough rows match (or the index is exhausted).
  const rows = search
    ? results.filter((row) => titleOf(row)?.toLowerCase().includes(search))
    : results;
  const loading = status === "LoadingFirstPage";
  useEffect(() => {
    if (search && status === "CanLoadMore" && rows.length < SEARCH_MIN_MATCHES) loadMore(30);
  }, [loadMore, rows.length, search, status]);
  const groups = groupByRecency(rows, now, (row) => row.updatedAt);
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
            void syncAgentSessions(
              workspace,
              agent.agentId,
              JSON.parse(syncWorkers) as string[],
            ).catch(showSyncError);
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
                        className={`min-w-0 flex-1 truncate ${titleOf(row) ? "" : "text-muted-foreground"}`}
                      >
                        {titleOf(row) || "Untitled session"}
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
      {status === "CanLoadMore" ? (
        <Button variant="outline" size="sm" className="self-center" onClick={() => loadMore(30)}>
          Load more
        </Button>
      ) : null}
      {status === "LoadingMore" ? <Spinner className="self-center text-muted-foreground" /> : null}
    </>
  );
}
