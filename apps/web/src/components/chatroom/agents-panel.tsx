import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { BotIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { acpAgentDefinitionError, type AcpAgentDefinition } from "backend/src/acp/contract";
import { isWorkerOnline } from "backend/src/worker/presence";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { AcpAgentAuth } from "@/components/session/acp/agent-auth";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useWorkerPresenceClock } from "@/components/workspaces/worker-presence";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { formatAgentCommandLine, parseAgentCommandLine } from "./agent-command-line";

type AgentDefinition = FunctionReturnType<typeof api.acp.ListAgentDefinitions>[number];
type RegistryAgent = FunctionReturnType<typeof api.acp.RegistryAgents>[number];
type Worker = FunctionReturnType<typeof api.workers.list>[number];
type AgentReport = FunctionReturnType<typeof api.acp.ListAgents>[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not save the agent.";
}

function definitionFields(agent: AcpAgentDefinition): AcpAgentDefinition {
  const { agentId, name, command, args, env, enabled, source, icon, version } = agent;
  return { agentId, name, command, args, env, enabled, source, icon, version };
}

function AgentIcon({ name, icon }: { name: string; icon?: string }) {
  return (
    <Avatar className="size-7 rounded">
      {icon && /^https?:\/\//i.test(icon) ? (
        <AvatarImage src={icon} alt="" className="object-contain" />
      ) : null}
      <AvatarFallback className="rounded text-xs uppercase">{name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** Workspace launch definitions, with the result of each Worker's own PATH check underneath. */
export function AgentsPanel() {
  const { workspaceId, workspace } = useWorkspace();
  const canManage = workspace?.role === "owner" && Boolean(workspaceId);
  const queryArgs = canManage && workspaceId ? { workspace: workspaceId } : "skip";
  const { data: definitions, error } = useQuery(
    convexQuery(api.acp.ListAgentDefinitions, queryArgs),
  );
  const { data: workers, error: workerError } = useQuery(convexQuery(api.workers.list, queryArgs));
  const { data: reports, error: reportError } = useQuery(
    convexQuery(api.acp.ListAgents, queryArgs),
  );
  const saveAgent = useMutation(api.acp.SaveAgentDefinition);
  const deleteAgent = useMutation(api.acp.DeleteAgentDefinition);
  const now = useWorkerPresenceClock();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<AgentDefinition | null>(null);
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setDialogOpen(false);
    setTarget(null);
    setDeleting(null);
    setPending(null);
    setDeleteError(null);
  }, [workspaceId]);

  async function toggle(agent: AgentDefinition, enabled: boolean) {
    if (!workspaceId || pending) return;
    setPending(agent._id);
    try {
      await saveAgent({
        workspace: workspaceId,
        id: agent._id,
        definition: { ...definitionFields(agent), enabled },
      });
    } catch (saveError) {
      toast.error(errorMessage(saveError));
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!workspaceId || !deleting || pending) return;
    setPending(deleting._id);
    setDeleteError(null);
    try {
      await deleteAgent({ workspace: workspaceId, id: deleting._id });
      setDeleting(null);
    } catch (removeError) {
      setDeleteError(errorMessage(removeError));
    } finally {
      setPending(null);
    }
  }

  const activeWorkers = workers?.filter((worker) => worker.status === "active");
  return (
    <>
      <WorkspacePageHeader
        title="Agents"
        description="Connect independent ACP agents to Chatroom. Every Worker checks the command on its own PATH. Agents run with the Worker user's permissions, just like Bash."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage}
            onClick={() => {
              setTarget(null);
              setDialogOpen(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add agent
          </Button>
        }
      />
      <GroupList
        title="Configured agents"
        description="Definitions are shared across the workspace. Each machine keeps the agent's own login and conversation history."
      >
        {error ? (
          <RowBlock className="text-sm text-destructive">
            Could not load agents. Try refreshing the page.
          </RowBlock>
        ) : definitions === undefined ? (
          <RowBlock>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </RowBlock>
        ) : definitions.length === 0 ? (
          <RowBlock>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BotIcon />
                </EmptyMedia>
                <EmptyTitle>No agents yet</EmptyTitle>
                <EmptyDescription>
                  Add an agent from the ACP registry or configure your own ACP command.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </RowBlock>
        ) : (
          definitions.map((agent) => (
            <Fragment key={agent._id}>
              <Row
                leading={<AgentIcon name={agent.name} icon={agent.icon} />}
                title={agent.name}
                tag={agent.source === "registry" ? "Registry" : "Custom"}
                description={
                  <span
                    className="font-mono text-[13px]"
                    title={formatAgentCommandLine([agent.command, ...agent.args])}
                  >
                    {formatAgentCommandLine([agent.command, ...agent.args])}
                  </span>
                }
              >
                <Switch
                  checked={agent.enabled}
                  disabled={pending !== null}
                  onCheckedChange={(enabled) => void toggle(agent, enabled)}
                  aria-label={`Enable ${agent.name}`}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Edit ${agent.name}`}
                  disabled={pending !== null}
                  onClick={() => {
                    setTarget(agent);
                    setDialogOpen(true);
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Delete ${agent.name}`}
                  disabled={pending !== null}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(agent);
                  }}
                >
                  <Trash2Icon />
                </Button>
              </Row>
              <RowBlock>
                {workerError || reportError ? (
                  <p className="text-xs text-destructive">Could not load Worker availability.</p>
                ) : activeWorkers === undefined || reports === undefined ? (
                  <Skeleton className="h-5 w-48" />
                ) : activeWorkers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No active Workers. Enroll a Worker from the Workers tab to run this agent.
                  </p>
                ) : (
                  activeWorkers.map((worker) => (
                    <AgentWorkerStatus
                      key={worker.workerId}
                      workspace={workspaceId!}
                      worker={worker}
                      agent={agent}
                      report={reports.find(
                        (report) =>
                          report.worker === worker.workerId && report.agentId === agent.agentId,
                      )}
                      now={now}
                    />
                  ))
                )}
              </RowBlock>
            </Fragment>
          ))
        )}
      </GroupList>
      <AgentDefinitionDialog
        key={workspaceId}
        open={dialogOpen}
        target={target}
        workspaceId={workspaceId}
        onOpenChange={setDialogOpen}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its launch definition from every Worker. Existing Sessions keep their
              agent binding and become unavailable; they will not switch to another agent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button variant="outline" disabled={pending !== null} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending !== null} onClick={() => void remove()}>
              {pending ? <Spinner data-icon="inline-start" /> : null}Delete agent
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AgentWorkerStatus({
  workspace,
  worker,
  agent,
  report,
  now,
}: {
  workspace: Id<"workspaces">;
  worker: Worker;
  agent: AgentDefinition;
  report?: AgentReport;
  now: number;
}) {
  const online = now > 0 && isWorkerOnline(worker.lastSeenAt, now);
  const availableReport = agent.enabled && online ? report : undefined;
  const label = !agent.enabled
    ? "Disabled"
    : !availableReport
      ? "Waiting for Worker"
      : availableReport.status === "ready"
        ? `Available${availableReport.version ? ` · ${availableReport.version}` : ""}`
        : availableReport.status === "needs_auth"
          ? "Needs sign in"
          : availableReport.status === "unavailable"
            ? "Not on PATH"
            : "Failed";
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs">
          <span className="font-medium">{worker.name}</span>
          <span className="text-muted-foreground">
            {" "}
            · {label}
            {agent.enabled && now > 0 && !online ? " · Offline" : ""}
          </span>
        </p>
        {availableReport?.error ? (
          <p className="text-xs text-destructive break-words">{availableReport.error}</p>
        ) : null}
      </div>
      {availableReport &&
      (availableReport.status === "needs_auth" ||
        (availableReport.status === "ready" && availableReport.capabilities.logout)) ? (
        <AcpAgentAuth
          workspace={workspace}
          worker={worker.workerId}
          agentId={agent.agentId}
          name={agent.name}
          authMethods={availableReport.authMethods}
          logout={availableReport.status === "ready"}
        />
      ) : null}
    </div>
  );
}

function slug(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function AgentDefinitionDialog({
  open,
  target,
  workspaceId,
  onOpenChange,
}: {
  open: boolean;
  target: AgentDefinition | null;
  workspaceId?: Id<"workspaces">;
  onOpenChange: (open: boolean) => void;
}) {
  const registryAgents = useAction(api.acp.RegistryAgents);
  const saveAgent = useMutation(api.acp.SaveAgentDefinition);
  const [path, setPath] = useState<"registry" | "custom">("registry");
  const [registry, setRegistry] = useState<RegistryAgent[] | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<RegistryAgent | null>(null);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [commandLine, setCommandLine] = useState("");
  const [env, setEnv] = useState<AcpAgentDefinition["env"]>([]);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const registryRequest = useRef(0);

  useEffect(() => {
    if (!open) return;
    setPath(target?.source ?? "registry");
    setSelected(null);
    setName(target?.name ?? "");
    setAgentId(target?.agentId ?? "");
    setIdEdited(target !== null);
    setCommandLine(target ? formatAgentCommandLine([target.command, ...target.args]) : "");
    setEnv(target?.env.map((entry) => ({ ...entry })) ?? []);
    setEnabled(target?.enabled ?? true);
    setSearch("");
    setSaveError(null);
  }, [open, target]);

  useEffect(() => {
    if (!open || target || path !== "registry" || !workspaceId) return;
    const request = ++registryRequest.current;
    setRegistryLoading(true);
    setRegistryError(null);
    void registryAgents({ workspace: workspaceId })
      .then((entries) => {
        if (registryRequest.current === request) setRegistry(entries);
      })
      .catch((error) => {
        if (registryRequest.current === request) setRegistryError(errorMessage(error));
      })
      .finally(() => {
        if (registryRequest.current === request) setRegistryLoading(false);
      });
    return () => {
      registryRequest.current++;
    };
  }, [open, target, path, workspaceId, registryAgents]);

  function choose(entry: RegistryAgent) {
    const launch = entry.launch ?? entry.pathCommand;
    if (!launch) return;
    setSelected(entry);
    setName(entry.name);
    setAgentId(entry.id);
    setIdEdited(true);
    setCommandLine(formatAgentCommandLine([launch.command, ...launch.args]));
    setEnv(entry.launch?.env.map((item) => ({ ...item })) ?? []);
    setSaveError(null);
  }

  let argv: string[] = [];
  let parseError: string | null = null;
  try {
    argv = parseAgentCommandLine(commandLine);
  } catch (error) {
    parseError = errorMessage(error);
  }
  const definition: AcpAgentDefinition = {
    agentId,
    name: name.trim(),
    command: argv[0] ?? "",
    args: argv.slice(1),
    env,
    enabled,
    source: target?.source ?? path,
    icon: target?.icon ?? selected?.icon,
    version: target?.version ?? selected?.version,
  };
  const validationError = parseError ?? acpAgentDefinitionError(definition);
  const showForm = target !== null || path === "custom" || selected !== null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || submitting) return;
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSubmitting(true);
    setSaveError(null);
    try {
      await saveAgent({ workspace: workspaceId, id: target?._id, definition });
      onOpenChange(false);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(event) => void save(event)} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{target ? "Edit agent" : "Add agent"}</DialogTitle>
            <DialogDescription>
              Launch an ACP program on each Worker. The command runs directly, not through a shell.
            </DialogDescription>
          </DialogHeader>
          {!target ? (
            <ToggleGroup
              type="single"
              variant="outline"
              value={path}
              onValueChange={(value) => {
                if (value === "registry" || value === "custom") {
                  setPath(value);
                  setSelected(null);
                  setName("");
                  setAgentId("");
                  setIdEdited(false);
                  setCommandLine("");
                  setEnv([]);
                  setSaveError(null);
                }
              }}
              aria-label="Agent source"
            >
              <ToggleGroupItem value="registry">From registry</ToggleGroupItem>
              <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          {!target && path === "registry" ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-registry-search">ACP registry</FieldLabel>
                <Input
                  id="agent-registry-search"
                  placeholder="Search agents…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
              {registryLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  Loading registry…
                </div>
              ) : registryError ? (
                <p role="alert" className="text-sm text-destructive">
                  {registryError}
                </p>
              ) : (
                <div
                  className="max-h-48 overflow-y-auto rounded-md border"
                  role="group"
                  aria-label="Registry agents"
                >
                  {registry
                    ?.filter((entry) =>
                      `${entry.name} ${entry.id} ${entry.description ?? ""}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((entry) => (
                      <Button
                        key={entry.id}
                        type="button"
                        variant={selected?.id === entry.id ? "secondary" : "ghost"}
                        className="h-auto w-full justify-start gap-3 rounded-none py-3"
                        disabled={!entry.launch && !entry.pathCommand}
                        onClick={() => choose(entry)}
                      >
                        <AgentIcon name={entry.name} icon={entry.icon} />
                        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                          <span>
                            {entry.name}{" "}
                            <span className="text-muted-foreground">{entry.version}</span>
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {entry.description ?? entry.id}
                          </span>
                          {!entry.launch && !entry.pathCommand ? (
                            <span className="text-xs text-muted-foreground">
                              No supported launch command
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    ))}
                  {registry &&
                  !registry.some((entry) =>
                    `${entry.name} ${entry.id} ${entry.description ?? ""}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  ) ? (
                    <p className="p-3 text-sm text-muted-foreground">No matching agents.</p>
                  ) : null}
                </div>
              )}
              {selected && !selected.launch ? (
                <FieldDescription>
                  Install this agent's binary on every Worker's PATH. Radium does not download or
                  install binaries.
                </FieldDescription>
              ) : selected ? (
                <FieldDescription>
                  The registry command uses {selected.launch?.command}; that runtime must be on each
                  Worker's PATH.
                </FieldDescription>
              ) : null}
            </FieldGroup>
          ) : null}
          {showForm ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                <Input
                  id="agent-name"
                  value={name}
                  disabled={submitting}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!idEdited) setAgentId(slug(event.target.value));
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-id">Agent ID</FieldLabel>
                <Input
                  id="agent-id"
                  value={agentId}
                  disabled={target !== null || submitting}
                  onChange={(event) => {
                    setAgentId(event.target.value);
                    setIdEdited(true);
                  }}
                />
                <FieldDescription>
                  Stable lowercase identifier. Existing Sessions keep this ID; it cannot change
                  after creation.
                </FieldDescription>
              </Field>
              <Field data-invalid={parseError !== null}>
                <FieldLabel htmlFor="agent-command">Command line</FieldLabel>
                <Input
                  id="agent-command"
                  className="font-mono"
                  placeholder="my-agent --acp"
                  value={commandLine}
                  disabled={submitting}
                  aria-invalid={parseError !== null}
                  aria-describedby="agent-argv"
                  onChange={(event) => setCommandLine(event.target.value)}
                />
                <FieldDescription id="agent-argv" className="break-all font-mono">
                  {parseError ?? `argv: ${JSON.stringify(argv)}`}
                </FieldDescription>
                <FieldDescription>
                  Use quotes or backslashes for spaces. No shell expansion, pipes, or redirects.
                </FieldDescription>
              </Field>
              <FieldSet>
                <FieldLegend>Environment variables</FieldLegend>
                <FieldDescription>
                  Stored in Convex and visible to the workspace owner. Not for secrets: agents keep
                  their own login on each machine.
                </FieldDescription>
                <FieldGroup>
                  {env.map((entry, index) => (
                    <Field key={index} orientation="horizontal">
                      <FieldLabel className="sr-only" htmlFor={`agent-env-name-${index}`}>
                        Variable {index + 1} name
                      </FieldLabel>
                      <Input
                        id={`agent-env-name-${index}`}
                        aria-label={`Variable ${index + 1} name`}
                        placeholder="NAME"
                        value={entry.name}
                        className="min-w-0 flex-1 font-mono"
                        disabled={submitting}
                        onChange={(event) =>
                          setEnv((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <FieldLabel className="sr-only" htmlFor={`agent-env-value-${index}`}>
                        Variable {index + 1} value
                      </FieldLabel>
                      <Input
                        id={`agent-env-value-${index}`}
                        placeholder="Value"
                        value={entry.value}
                        className="min-w-0 flex-1 font-mono"
                        disabled={submitting}
                        onChange={(event) =>
                          setEnv((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, value: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove variable ${index + 1}`}
                        disabled={submitting}
                        onClick={() =>
                          setEnv((current) => current.filter((_, itemIndex) => itemIndex !== index))
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </Field>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={submitting || env.length >= 32}
                    onClick={() => setEnv((current) => [...current, { name: "", value: "" }])}
                  >
                    <PlusIcon data-icon="inline-start" />
                    Add variable
                  </Button>
                </FieldGroup>
              </FieldSet>
              <Field orientation="horizontal">
                <Switch
                  id="agent-enabled"
                  checked={enabled}
                  disabled={submitting}
                  onCheckedChange={setEnabled}
                />
                <FieldLabel htmlFor="agent-enabled">Enabled on all Workers</FieldLabel>
              </Field>
            </FieldGroup>
          ) : null}
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !showForm || !workspaceId}>
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              {target ? "Save changes" : "Add agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
