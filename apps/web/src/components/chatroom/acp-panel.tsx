import { useEffect, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { acpAgentDefinitionError, type AcpAgentDefinition } from "backend/src/acp/contract";
import { isWorkerOnline } from "backend/src/worker/presence";
import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { GroupList, Row, RowBlock, Tag } from "@/components/harness/group-list";
import { AcpMark } from "@/components/icons/acp-mark";
import { AcpAgentAuth } from "@/components/session/acp/agent-auth";
import { AcpAgentIcon } from "@/components/session/acp/agent-icon";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

/** Workspace definitions are independent of each Worker's installation and login. */
export function AcpPanel() {
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
  const registryAgents = useAction(api.acp.RegistryAgents);
  const registry = useQuery({
    queryKey: ["acp-registry", workspaceId],
    queryFn: () => registryAgents({ workspace: workspaceId! }),
    enabled: canManage,
    staleTime: 5 * 60_000,
  });
  const saveAgent = useMutation(api.acp.SaveAgentDefinition);
  const deleteAgent = useMutation(api.acp.DeleteAgentDefinition);
  const now = useWorkerPresenceClock();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState<AgentDefinition | null>(null);
  const [setup, setSetup] = useState<RegistryAgent | null>(null);
  const [deleting, setDeleting] = useState<AgentDefinition | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setDialogOpen(false);
    setTarget(null);
    setSetup(null);
    setDeleting(null);
    setPending(null);
    setDeleteError(null);
    setSearch("");
    setShowAll(false);
  }, [workspaceId]);

  function openForm(agent: AgentDefinition | null, entry: RegistryAgent | null = null) {
    setTarget(agent);
    setSetup(entry);
    setDialogOpen(true);
  }

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

  async function add(entry: RegistryAgent) {
    if (!workspaceId || !entry.launch || pending) return;
    setPending(entry.id);
    try {
      await saveAgent({
        workspace: workspaceId,
        definition: {
          agentId: entry.id,
          name: entry.name,
          ...entry.launch,
          enabled: true,
          source: "registry",
          icon: entry.icon,
          version: entry.version,
        },
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
  const matchingAgents = registry.data?.filter((entry) =>
    `${entry.name} ${entry.id} ${entry.description ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const visibleAgents = showAll ? matchingAgents : matchingAgents?.slice(0, 8);

  return (
    <>
      <WorkspacePageHeader
        title="ACP"
        description="Run independent agents on your Workers with the Agent Client Protocol."
        action={
          <Button variant="ghost" size="sm" asChild>
            <a href="https://agentclientprotocol.com" target="_blank" rel="noreferrer">
              About ACP
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </Button>
        }
      />
      <GroupList
        title="Agents"
        description="Shared launch commands. Installation and sign-in stay on each Worker."
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
                <EmptyMedia>
                  <AcpMark className="h-5 w-auto" />
                </EmptyMedia>
                <EmptyTitle>No agents yet</EmptyTitle>
                <EmptyDescription>
                  Add an agent from the registry below, or bring your own ACP command.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </RowBlock>
        ) : (
          definitions.map((agent) => {
            const command = formatAgentCommandLine([agent.command, ...agent.args]);
            return (
              <Row
                key={agent._id}
                leading={<AcpAgentIcon name={agent.name} icon={agent.icon} className="size-6" />}
                title={
                  <>
                    {agent.name}
                    {agent.version ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        {agent.version}
                      </span>
                    ) : null}
                  </>
                }
                description={
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0} className="truncate font-mono text-[13px]">
                          {command}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="break-all font-mono text-[13px]">{command}</span>
                      </TooltipContent>
                    </Tooltip>
                    <span className="flex flex-wrap gap-1 whitespace-normal">
                      {workerError || reportError ? (
                        <span className="text-xs text-destructive">
                          Could not load Worker availability.
                        </span>
                      ) : activeWorkers === undefined || reports === undefined ? (
                        <Skeleton className="h-5 w-36" />
                      ) : activeWorkers.length === 0 ? (
                        <span className="text-xs">
                          Enroll a Worker in Workers to run this agent.
                        </span>
                      ) : (
                        activeWorkers.map((worker) => (
                          <AgentWorkerPill
                            key={worker.workerId}
                            worker={worker}
                            enabled={agent.enabled}
                            now={now}
                            report={reports.find(
                              (report) =>
                                report.worker === worker.workerId &&
                                report.agentId === agent.agentId,
                            )}
                          />
                        ))
                      )}
                    </span>
                  </span>
                }
              >
                <Switch
                  checked={agent.enabled}
                  disabled={!canManage || pending !== null}
                  onCheckedChange={(enabled) => void toggle(agent, enabled)}
                  aria-label={`Enable ${agent.name}`}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="-mr-1.5"
                      aria-label={`Actions for ${agent.name}`}
                      disabled={!canManage || pending !== null}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => openForm(agent)}>
                        <PencilIcon />
                        Edit
                      </DropdownMenuItem>
                      {agent.enabled &&
                        activeWorkers?.map((worker) => {
                          const report = reports?.find(
                            (entry) =>
                              entry.worker === worker.workerId && entry.agentId === agent.agentId,
                          );
                          if (
                            now <= 0 ||
                            !isWorkerOnline(worker.lastSeenAt, now) ||
                            !report ||
                            (report.status !== "needs_auth" &&
                              !(report.status === "ready" && report.capabilities.logout))
                          )
                            return null;
                          return (
                            <AcpAgentAuth
                              key={worker.workerId}
                              workspace={workspaceId!}
                              worker={worker.workerId}
                              agentId={agent.agentId}
                              name={agent.name}
                              authMethods={report.authMethods}
                              logout={report.status === "ready"}
                              menuLabel={`${report.status === "ready" ? "Sign out" : "Sign in"} on ${worker.name}`}
                            />
                          );
                        })}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          setDeleteError(null);
                          setDeleting(agent);
                        }}
                      >
                        <Trash2Icon />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Row>
            );
          })
        )}
      </GroupList>
      <GroupList
        title="Add agents"
        description="From the ACP registry, or your own command."
        action={
          <>
            <InputGroup className="h-8 w-24 sm:w-40">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label="Search ACP registry"
                placeholder="Search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setShowAll(false);
                }}
              />
            </InputGroup>
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={() => openForm(null)}
              aria-label="Custom agent"
            >
              <PlusIcon data-icon="inline-start" />
              Custom<span className="hidden sm:inline"> agent</span>
            </Button>
          </>
        }
      >
        {registry.isPending ? (
          <RowBlock>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </RowBlock>
        ) : registry.error ? (
          <RowBlock>
            <p role="alert" className="text-sm text-destructive">
              Could not load the ACP registry. You can still add a custom agent.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void registry.refetch()}
            >
              Try again
            </Button>
          </RowBlock>
        ) : visibleAgents?.length === 0 ? (
          <RowBlock className="text-sm text-muted-foreground">
            {search
              ? "No matching agents."
              : "No registry agents available. Add a custom agent instead."}
          </RowBlock>
        ) : (
          visibleAgents?.map((entry) => {
            const added = definitions?.some((agent) => agent.agentId === entry.id) ?? false;
            return (
              <Row
                key={entry.id}
                leading={<AcpAgentIcon name={entry.name} icon={entry.icon} className="size-6" />}
                title={
                  <>
                    {entry.name}
                    <span className="ml-2 font-normal text-muted-foreground">{entry.version}</span>
                  </>
                }
                description={
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag>{entry.launch?.command ?? "Binary on PATH"}</Tag>
                    <span className="truncate" title={entry.description ?? entry.id}>
                      {entry.description ?? entry.id}
                    </span>
                  </span>
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-18"
                  disabled={added || !canManage || pending !== null || definitions === undefined}
                  onClick={() => (entry.launch ? void add(entry) : openForm(null, entry))}
                >
                  {pending === entry.id ? <Spinner data-icon="inline-start" /> : null}
                  {added ? "Added" : entry.launch ? "Add" : "Set up"}
                </Button>
              </Row>
            );
          })
        )}
        {!showAll && matchingAgents && matchingAgents.length > 8 ? (
          <RowBlock className="items-center py-2">
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Show all ({matchingAgents.length})
            </Button>
          </RowBlock>
        ) : null}
      </GroupList>
      <AgentDefinitionDialog
        key={workspaceId}
        open={dialogOpen}
        target={target}
        setup={setup}
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

function workerAvailability(
  worker: Worker,
  enabled: boolean,
  now: number,
  report?: AgentReport,
): { label: string; state: RunState; detail: string } {
  if (now > 0 && !isWorkerOnline(worker.lastSeenAt, now))
    return {
      label: "Offline",
      state: "idle",
      detail: "Worker is offline. Availability updates when it reconnects.",
    };
  if (!enabled)
    return {
      label: "Waiting",
      state: "queued",
      detail: "Enable this agent to check its availability on the Worker.",
    };
  if (now <= 0 || !report)
    return { label: "Waiting", state: "queued", detail: "Worker has not reported this agent yet." };
  switch (report.status) {
    case "ready":
      return {
        label: "Available",
        state: "succeeded",
        detail: report.version ? `Available · ${report.version}` : "Available",
      };
    case "needs_auth":
      return {
        label: "Needs sign in",
        state: "awaiting",
        detail: report.error ?? "Sign in from this agent's menu, or use its CLI on the Worker.",
      };
    case "unavailable":
      return {
        label: "Not on PATH",
        state: "failed",
        detail: report.error ?? "The command was not found on this Worker's PATH.",
      };
    case "failed":
      return {
        label: "Failed",
        state: "failed",
        detail: report.error ?? "The Worker could not start this agent.",
      };
  }
}

function AgentWorkerPill({
  worker,
  enabled,
  now,
  report,
}: {
  worker: Worker;
  enabled: boolean;
  now: number;
  report?: AgentReport;
}) {
  const availability = workerAvailability(worker, enabled, now, report);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Tag
          tabIndex={0}
          className="h-5 max-w-full px-1.5"
          aria-label={`${worker.name}: ${availability.label}`}
        >
          <AgentStatus
            state={availability.state}
            label={<span className="max-w-32 truncate">{worker.name}</span>}
          />
        </Tag>
      </TooltipTrigger>
      <TooltipContent>
        <span>
          {worker.name} · {availability.label}. {availability.detail}
        </span>
      </TooltipContent>
    </Tooltip>
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
  setup,
  workspaceId,
  onOpenChange,
}: {
  open: boolean;
  target: AgentDefinition | null;
  setup: RegistryAgent | null;
  workspaceId?: Id<"workspaces">;
  onOpenChange: (open: boolean) => void;
}) {
  const saveAgent = useMutation(api.acp.SaveAgentDefinition);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [commandLine, setCommandLine] = useState("");
  const [env, setEnv] = useState<AcpAgentDefinition["env"]>([]);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const launch = target ?? setup?.pathCommand;
    setName(target?.name ?? setup?.name ?? "");
    setAgentId(target?.agentId ?? setup?.id ?? "");
    setIdEdited(target !== null || setup !== null);
    setCommandLine(launch ? formatAgentCommandLine([launch.command, ...launch.args]) : "");
    setEnv(target?.env.map((entry) => ({ ...entry })) ?? []);
    setEnabled(target?.enabled ?? true);
    setSaveError(null);
  }, [open, target, setup]);

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
    source: target?.source ?? (setup ? "registry" : "custom"),
    icon: target?.icon ?? setup?.icon,
    version: target?.version ?? setup?.version,
  };
  const validationError = parseError ?? acpAgentDefinitionError(definition);

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
            <DialogTitle>
              {target ? "Edit agent" : setup ? `Set up ${setup.name}` : "Custom agent"}
            </DialogTitle>
            <DialogDescription>
              {setup
                ? "Install this binary on each Worker's PATH. Radium does not download or install binaries."
                : "Launch an ACP program on each Worker. The command runs directly, not through a shell."}
            </DialogDescription>
          </DialogHeader>
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
            {!target ? (
              <Field>
                <FieldLabel htmlFor="agent-id">Agent ID</FieldLabel>
                <Input
                  id="agent-id"
                  value={agentId}
                  disabled={submitting}
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
            ) : null}
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
              <FieldLabel htmlFor="agent-enabled">Enabled</FieldLabel>
            </Field>
          </FieldGroup>
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
            <Button type="submit" disabled={submitting || !workspaceId}>
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              {target ? "Save changes" : "Add agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
