import { useEffect, useRef, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpSessionListPage } from "backend/src/acp/contract";
import { validChatWorkerDirectory } from "backend/src/worker/chat-config";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AcpSessionAgent, SessionProject } from "../agents";

/** Enumeration is explicit, cwd-filtered, and page cursors never leave this mounted dialog. */
export function OpenAcpSessionDialog({
  workspace,
  agent,
  project,
  scope,
  onClose,
  onCreated,
}: {
  workspace: Id<"workspaces">;
  agent: AcpSessionAgent;
  project: SessionProject | null;
  scope?: "personal" | "workspace";
  onClose: () => void;
  onCreated: (chat: Id<"aisdk_chats">) => void;
}) {
  const folder = project?.folders?.find(
    (candidate) => candidate.workerId === agent.workerId,
  )?.directory;
  const [directory, setDirectory] = useState(folder ?? "");
  const [sessions, setSessions] = useState<AcpSessionListPage["sessions"]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [listed, setListed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [command, setCommand] = useState<Id<"acp_commands">>();
  const list = useMutation(api.acp.ListAgentSessions);
  const create = useMutation(api.acp.CreateSession);
  const { data: result, error } = useQuery(
    convexQuery(api.acp.GetCommand, command ? { command } : "skip"),
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const cwd = folder ?? directory.trim();
  const valid = validChatWorkerDirectory(cwd) && (!project || folder !== undefined);
  const busy = starting || command !== undefined || opening;

  useEffect(() => {
    if (
      !command ||
      (!error && result?.status !== "done" && result?.status !== "failed" && result !== null)
    )
      return;
    setCommand(undefined);
    if (error || result === null || result?.status === "failed") {
      toast.error(
        error instanceof Error
          ? error.message
          : (result?.error ?? "Session listing is no longer available."),
      );
      return;
    }
    try {
      const page: unknown = JSON.parse(result?.result ?? "");
      if (!isSessionPage(page)) throw new Error("The agent returned an invalid session list.");
      setSessions((previous) => {
        const seen = new Set(previous.map((session) => session.sessionId));
        return [...previous, ...page.sessions.filter((session) => !seen.has(session.sessionId))];
      });
      setNextCursor(page.nextCursor);
      setListed(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the session list.");
    }
  }, [command, error, result]);

  async function load(cursor?: string) {
    if (!valid || busy) return;
    setStarting(true);
    try {
      const id = await list({
        workspace,
        worker: agent.workerId,
        agentId: agent.agentId,
        cwd,
        cursor,
        clientId: crypto.randomUUID(),
      });
      if (mounted.current) setCommand(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not list agent sessions.");
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function open(sessionId: string) {
    if (!valid || busy) return;
    setOpening(true);
    try {
      const chat = await create({
        workspace,
        worker: agent.workerId,
        agentId: agent.agentId,
        cwd,
        project: project?._id,
        scope,
        sessionId,
      });
      onCreated(chat);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the agent session.");
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !opening) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open existing · {agent.name}</DialogTitle>
          <DialogDescription>
            Import one session from this Worker. Sessions are listed only when you ask.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="acp-import-directory">Directory on Worker</FieldLabel>
          <Input
            id="acp-import-directory"
            value={cwd}
            readOnly={Boolean(project)}
            disabled={busy}
            placeholder="/absolute/path"
            onChange={(event) => {
              setDirectory(event.target.value);
              setSessions([]);
              setNextCursor(undefined);
              setListed(false);
            }}
          />
          {project && !folder ? (
            <p className="text-xs text-destructive">
              This Project has no folder on the selected Worker.
            </p>
          ) : !valid && cwd ? (
            <p className="text-xs text-destructive">Enter an absolute directory on the Worker.</p>
          ) : null}
        </Field>
        {!listed ? (
          <Button disabled={!valid || busy} onClick={() => void load()}>
            {busy ? "Loading…" : "List sessions"}
          </Button>
        ) : null}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {sessions.map((session) => (
            <Button
              key={session.sessionId}
              variant="ghost"
              className="h-auto w-full justify-start py-2 text-left"
              disabled={busy}
              onClick={() => void open(session.sessionId)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{session.title || session.sessionId}</span>
                {session.updatedAt ? (
                  <span className="text-xs text-muted-foreground">{session.updatedAt}</span>
                ) : null}
              </span>
            </Button>
          ))}
          {listed && sessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No sessions in this directory.
            </p>
          ) : null}
        </div>
        {nextCursor ? (
          <Button variant="outline" disabled={busy} onClick={() => void load(nextCursor)}>
            {busy ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function isSessionPage(page: unknown): page is AcpSessionListPage {
  return (
    typeof page === "object" &&
    page !== null &&
    "sessions" in page &&
    Array.isArray(page.sessions) &&
    page.sessions.every(
      (session: unknown) =>
        typeof session === "object" &&
        session !== null &&
        "sessionId" in session &&
        typeof session.sessionId === "string" &&
        "cwd" in session &&
        typeof session.cwd === "string" &&
        (!("title" in session) || typeof session.title === "string") &&
        (!("updatedAt" in session) || typeof session.updatedAt === "string"),
    ) &&
    (!("nextCursor" in page) || typeof page.nextCursor === "string")
  );
}
