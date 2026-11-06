import { useEffect, useRef, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CheckIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { AgentStatus } from "@/components/agentic/agent-status";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { ownerOnlyNotice, WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { acpActionError } from "@/components/session/acp/use-acp-session";
import { useWorkspace } from "./workspace-provider";

type WorkerList = Exclude<FunctionReturnType<typeof api.workers.list>, string>;

type EnrollmentCode = {
  code: string;
  enrollmentId: string;
  expiresAt: number;
  workspace: Id<"workspaces">;
};

export function WorkerManagement() {
  const { workspace, workspaceId } = useWorkspace();
  const isOwner = workspace?.role === "owner";
  const { data, error } = useQuery(
    convexQuery(api.workers.list, isOwner && workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const createEnrollment = useAction(api.workers.createEnrollment);
  const revokeWorker = useMutation(api.workers.revoke);
  const revokeEnrollment = useMutation(api.workers.revokeEnrollment);
  const setGatewayAccess = useMutation(api.workers.setGatewayAccess);
  const setGatewayTelemetry = useMutation(api.workers.setGatewayTelemetry);

  const [name, setName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [enrollmentCode, setEnrollmentCode] = useState<EnrollmentCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<WorkerList[number] | null>(null);
  const workspaceIdRef = useRef(workspaceId);

  // Async handlers consult this ref before changing setup codes and workspace-scoped dialogs.
  workspaceIdRef.current = workspaceId;

  useEffect(() => {
    setEnrollmentCode(null);
    setDialogOpen(false);
    setExpired(false);
    setCopied(false);
    setName("");
    setRevokeTarget(null);
    setPendingAction(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!enrollmentCode) return;
    const timeout = window.setTimeout(
      () => {
        setEnrollmentCode((current) =>
          current?.enrollmentId === enrollmentCode.enrollmentId ? null : current,
        );
        setExpired(true);
        setCopied(false);
      },
      Math.max(0, enrollmentCode.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [enrollmentCode]);

  const workers = Array.isArray(data) ? data : ([] as WorkerList);

  function clearEnrollment() {
    setEnrollmentCode(null);
    setExpired(false);
    setCopied(false);
    setName("");
  }

  function handleDialogOpenChange(open: boolean) {
    if (pendingAction !== null) return;
    setDialogOpen(open);
    if (!open) clearEnrollment();
  }

  async function issueEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!workspaceId || !isOwner || !trimmedName || pendingAction) return;

    const workspaceAtStart = workspaceId;
    setPendingAction("create-enrollment");
    try {
      const result = await createEnrollment({
        workspace: workspaceAtStart,
        name: trimmedName,
      });
      if (workspaceIdRef.current !== workspaceAtStart) return;
      setEnrollmentCode({ ...result, workspace: workspaceAtStart });
      setExpired(false);
      toast.success("Worker setup code created.");
    } catch (actionError) {
      toast.error(
        actionError instanceof Error
          ? actionError.message
          : "Could not create a worker setup code.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function copyEnrollmentCode() {
    if (!enrollmentCode || enrollmentCode.workspace !== workspaceId) return;
    if (Date.now() >= enrollmentCode.expiresAt) {
      setEnrollmentCode(null);
      setExpired(true);
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(enrollmentCode.code);
      setCopied(true);
      toast.success("Setup code copied.");
    } catch {
      toast.error("Could not copy the setup code. Select and copy it manually.");
    }
  }

  async function revokeSetupCode() {
    if (!workspaceId || !enrollmentCode || pendingAction) return;
    const workspaceAtStart = workspaceId;
    const enrollmentId = enrollmentCode.enrollmentId;
    setPendingAction("revoke-enrollment");
    try {
      await revokeEnrollment({ workspace: workspaceAtStart, enrollmentId });
      if (workspaceIdRef.current === workspaceAtStart) {
        clearEnrollment();
        setDialogOpen(false);
      }
      toast.success("Worker setup code revoked.");
    } catch (actionError) {
      toast.error(
        actionError instanceof Error
          ? actionError.message
          : "Could not revoke the worker setup code.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmRevokeWorker() {
    if (!workspaceId || !revokeTarget || pendingAction) return;
    const workspaceAtStart = workspaceId;
    const workerId = revokeTarget.workerId;
    setPendingAction(`revoke-worker:${workerId}`);
    try {
      await revokeWorker({ workspace: workspaceAtStart, workerId });
      if (workspaceIdRef.current === workspaceAtStart) setRevokeTarget(null);
      toast.success("Worker identity revoked.");
    } catch (actionError) {
      toast.error(
        actionError instanceof Error
          ? actionError.message
          : "Could not revoke the worker identity.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function updateGateway(
    workerId: string,
    update: (workspace: Id<"workspaces">) => Promise<null>,
  ) {
    if (!workspaceId || pendingAction) return;
    setPendingAction(`gateway:${workerId}`);
    try {
      await update(workspaceId);
    } catch (actionError) {
      toast.error(acpActionError(actionError) ?? "Could not update Gateway access.");
    } finally {
      setPendingAction(null);
    }
  }

  function openEnrollmentDialog() {
    clearEnrollment();
    setDialogOpen(true);
  }

  const visibleEnrollmentCode =
    enrollmentCode !== null &&
    enrollmentCode.workspace === workspaceId &&
    enrollmentCode.expiresAt > Date.now()
      ? enrollmentCode
      : null;

  const headerAction = isOwner ? (
    <Button
      variant="outline"
      size="sm"
      onClick={openEnrollmentDialog}
      disabled={!workspaceId || pendingAction !== null}
    >
      <PlusIcon data-icon="inline-start" />
      Add Worker
    </Button>
  ) : undefined;

  return (
    <>
      <WorkspacePageHeader
        title="Workers"
        description={
          isOwner ? "Machines that run files, folders, and commands for agents." : ownerOnlyNotice
        }
        action={headerAction}
      />

      <GroupList title="Enrolled">
        <WorkerRows
          canManage={Boolean(workspace) && isOwner}
          hasError={Boolean(error)}
          isLoading={data === undefined}
          workers={workers}
          workspaceId={workspaceId}
          disabled={pendingAction !== null}
          onRevoke={setRevokeTarget}
          onGatewayAccess={(worker, enabled) =>
            void updateGateway(worker.workerId, (workspace) =>
              setGatewayAccess({ workspace, workerId: worker.workerId, enabled }),
            )
          }
          onGatewayTelemetry={(worker, enabled) =>
            void updateGateway(worker.workerId, (workspace) =>
              setGatewayTelemetry({
                workspace,
                workerId: worker.workerId,
                telemetry: enabled ? "workspace" : "off",
              }),
            )
          }
        />
      </GroupList>
      {isOwner ? (
        <p className="px-4 text-sm text-muted-foreground">
          Configure ACP agents and check their availability on each machine in the{" "}
          <Link
            to="/chatroom/$section"
            params={{ section: "acp" }}
            className="text-foreground underline underline-offset-4"
          >
            ACP settings
          </Link>
          .
        </p>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-md">
          {visibleEnrollmentCode ? (
            <>
              <DialogHeader>
                <DialogTitle>Worker setup code</DialogTitle>
                <DialogDescription>
                  Keep this code private. It expires {formatExpiry(visibleEnrollmentCode.expiresAt)}
                  .
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="worker-setup-code">Setup code</FieldLabel>
                  <Textarea
                    id="worker-setup-code"
                    readOnly
                    rows={4}
                    className="max-h-40"
                    value={visibleEnrollmentCode.code}
                  />
                  <FieldDescription>
                    Run <code>bun run --cwd packages/worker setup</code> on the machine and paste
                    this code into the prompt.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={pendingAction !== null}
                  onClick={() => void revokeSetupCode()}
                >
                  {pendingAction === "revoke-enrollment" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Trash2Icon data-icon="inline-start" />
                  )}
                  Revoke code
                </Button>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleDialogOpenChange(false)}
                    disabled={pendingAction !== null}
                  >
                    Close
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void copyEnrollmentCode()}
                    disabled={pendingAction !== null}
                  >
                    {copied ? (
                      <CheckIcon data-icon="inline-start" />
                    ) : (
                      <CopyIcon data-icon="inline-start" />
                    )}
                    {copied ? "Copied" : "Copy setup code"}
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={issueEnrollment}>
              <DialogHeader>
                <DialogTitle>Add Worker</DialogTitle>
                <DialogDescription>
                  {expired
                    ? "The setup code expired. Generate another to continue."
                    : "Name the Worker to generate its setup code."}
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="py-4">
                <Field>
                  <FieldLabel htmlFor="worker-enrollment-name">Worker name</FieldLabel>
                  <Input
                    id="worker-enrollment-name"
                    autoFocus
                    autoComplete="off"
                    maxLength={80}
                    placeholder="Build machine"
                    value={name}
                    disabled={pendingAction !== null}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogOpenChange(false)}
                  disabled={pendingAction !== null}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={pendingAction !== null || !name.trim()}>
                  {pendingAction === "create-enrollment" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlusIcon data-icon="inline-start" />
                  )}
                  Create setup code
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (pendingAction !== null) return;
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget?.name ?? "this Worker"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This Worker will no longer be authorized to access the workspace.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={pendingAction !== null}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRevokeWorker()}
              disabled={pendingAction !== null}
            >
              {pendingAction?.startsWith("revoke-worker:") ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              Revoke worker
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WorkerRows({
  canManage,
  hasError,
  isLoading,
  workers,
  workspaceId,
  disabled,
  onRevoke,
  onGatewayAccess,
  onGatewayTelemetry,
}: {
  canManage: boolean;
  hasError: boolean;
  isLoading: boolean;
  workers: WorkerList;
  workspaceId: Id<"workspaces"> | undefined;
  disabled: boolean;
  onRevoke: (worker: WorkerList[number]) => void;
  onGatewayAccess: (worker: WorkerList[number], enabled: boolean) => void;
  onGatewayTelemetry: (worker: WorkerList[number], enabled: boolean) => void;
}) {
  if (!canManage) {
    return (
      <RowBlock className="text-sm text-muted-foreground">
        Only the workspace owner can manage Workers.
      </RowBlock>
    );
  }

  if (hasError) {
    return (
      <RowBlock className="text-sm text-destructive">
        Could not load Workers. Try refreshing the page.
      </RowBlock>
    );
  }

  if (isLoading) {
    return (
      <RowBlock>
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </RowBlock>
    );
  }

  if (workers.length === 0) {
    return (
      <RowBlock>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>No Workers</EmptyTitle>
            <EmptyDescription>
              Add a Worker to connect a machine to this workspace.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </RowBlock>
    );
  }

  return workers.map((worker) => (
    <WorkerRow
      key={worker.workerId}
      worker={worker}
      workspaceId={workspaceId}
      disabled={disabled}
      onRevoke={() => onRevoke(worker)}
      onGatewayAccess={(enabled) => onGatewayAccess(worker, enabled)}
      onGatewayTelemetry={(enabled) => onGatewayTelemetry(worker, enabled)}
    />
  ));
}

const gatewayAccessLabels: Record<WorkerList[number]["gateway"]["access"], string> = {
  off: "Lets the Worker's Gateway agents call models with a key the Worker creates.",
  pending: "Waiting for the Worker",
  active: "Active",
  missing: "Key deleted",
};

/**
 * One Worker identity: name, id, authorization status, and owner actions in a `…` menu. An
 * authorized Worker also shows its Gateway access and, while on, its Gateway telemetry.
 */
function WorkerRow({
  worker,
  workspaceId,
  disabled,
  onRevoke,
  onGatewayAccess,
  onGatewayTelemetry,
}: {
  worker: WorkerList[number];
  workspaceId: Id<"workspaces"> | undefined;
  disabled: boolean;
  onRevoke: () => void;
  onGatewayAccess: (enabled: boolean) => void;
  onGatewayTelemetry: (enabled: boolean) => void;
}) {
  const isActive = worker.status === "active";
  const { access, telemetry } = worker.gateway;

  return (
    <>
      <Row
        icon={ServerIcon}
        title={worker.name}
        description={<span className="font-mono text-[13px]">{worker.workerId}</span>}
      >
        <AgentStatus
          state={isActive ? "succeeded" : "idle"}
          label={isActive ? "Authorized" : "Revoked"}
          title="Identity authorization status"
        />
        {isActive ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={`${worker.name} actions`}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
                  Revoke
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </Row>
      {isActive ? (
        <Row
          className="pl-7"
          title="Gateway access"
          description={
            <span className={access === "missing" ? "text-destructive" : undefined}>
              {gatewayAccessLabels[access]}
            </span>
          }
        >
          {access === "missing" && workspaceId ? (
            <IssueGatewayKeyButton
              workspace={workspaceId}
              workerId={worker.workerId}
              disabled={disabled}
            />
          ) : null}
          <Switch
            checked={access !== "off"}
            disabled={disabled}
            onCheckedChange={onGatewayAccess}
            aria-label={`Gateway access for ${worker.name}`}
          />
        </Row>
      ) : null}
      {isActive && access !== "off" ? (
        <Row
          className="pl-7"
          title="Gateway telemetry"
          description={
            telemetry === "workspace"
              ? "Follows the workspace telemetry settings."
              : "Requests with this Worker's key are not captured."
          }
        >
          <Switch
            checked={telemetry === "workspace"}
            disabled={disabled}
            onCheckedChange={onGatewayTelemetry}
            aria-label={`Gateway telemetry for ${worker.name}`}
          />
        </Row>
      ) : null}
    </>
  );
}

/** Replaces a deleted Worker Gateway key: the Worker creates the new one when it next connects. */
export function IssueGatewayKeyButton({
  workspace,
  workerId,
  disabled,
}: {
  workspace: Id<"workspaces">;
  workerId: string;
  disabled?: boolean;
}) {
  const issueGatewayKey = useMutation(api.workers.issueGatewayKey);
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    try {
      await issueGatewayKey({ workspace, workerId });
      toast.success("New Gateway key requested. The Worker creates it when it is online.");
    } catch (actionError) {
      toast.error(acpActionError(actionError) ?? "Could not issue a new Gateway key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="xs" variant="outline" disabled={disabled || busy} onClick={() => void issue()}>
      {busy ? <Spinner data-icon="inline-start" /> : null}
      Issue new key
    </Button>
  );
}

function formatExpiry(expiresAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));
}
