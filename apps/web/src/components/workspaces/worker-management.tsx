import { useEffect, useRef, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  BotIcon,
  CheckIcon,
  Clock3Icon,
  CopyIcon,
  FingerprintIcon,
  ShieldAlertIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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

  const [name, setName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [enrollmentCode, setEnrollmentCode] = useState<EnrollmentCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<WorkerList[number] | null>(null);
  const workspaceIdRef = useRef(workspaceId);
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

  return (
    <>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="mt-1 flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
              <BotIcon className="size-5" />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Chatroom / Infrastructure
                </p>
                <Badge variant="outline">Workspace scoped</Badge>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {workspace?.role === "owner"
                  ? `Enroll and manage machine identities for ${workspace.name}.`
                  : workspace
                    ? `Worker identities for ${workspace.name} are managed by its owner.`
                    : "Select an active workspace to manage its Worker identities."}
              </p>
            </div>
          </div>
          {isOwner ? (
            <Button
              size="sm"
              className="self-start sm:self-auto"
              onClick={openEnrollmentDialog}
              disabled={!workspaceId || pendingAction !== null}
            >
              <FingerprintIcon data-icon="inline-start" />
              Enroll a Worker
            </Button>
          ) : null}
        </header>

        <Separator />

        <Alert>
          <FingerprintIcon />
          <AlertTitle>Identity status is not connection status</AlertTitle>
          <AlertDescription>
            Active or revoked describes whether a Worker identity is authorized. It does not show
            whether a Worker process is currently connected.
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>Worker identities</CardTitle>
            <CardDescription>
              {workspace?.role === "owner"
                ? `Machine identities enrolled in ${workspace.name}.`
                : workspace
                  ? "Only the workspace owner can view or manage these identities."
                  : "Identities enrolled in the active workspace."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!workspace ? (
              <Alert>
                <AlertTitle>Workspace unavailable</AlertTitle>
                <AlertDescription>
                  Select an active workspace to manage Worker identities.
                </AlertDescription>
              </Alert>
            ) : !isOwner ? (
              <Alert>
                <AlertTitle>Owner access required</AlertTitle>
                <AlertDescription>
                  Only the workspace owner can view, enroll, or revoke Worker identities.
                </AlertDescription>
              </Alert>
            ) : error ? (
              <Alert variant="destructive">
                <AlertTitle>Workers unavailable</AlertTitle>
                <AlertDescription>
                  Radium could not load Worker identities. Try refreshing the page.
                </AlertDescription>
              </Alert>
            ) : data === undefined ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : workers.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BotIcon />
                  </EmptyMedia>
                  <EmptyTitle>No Workers enrolled</EmptyTitle>
                  <EmptyDescription>
                    Create a setup code to establish a workspace-scoped Worker identity.
                  </EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" onClick={openEnrollmentDialog}>
                  <FingerprintIcon data-icon="inline-start" />
                  Create setup code
                </Button>
              </Empty>
            ) : (
              <div className="flex flex-col divide-y rounded-lg border">
                {workers.map((worker) => (
                  <div key={worker.workerId} className="flex flex-wrap items-center gap-3 p-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                      <BotIcon className="size-4" />
                    </div>
                    <div className="flex min-w-40 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">{worker.name}</span>
                      <code className="truncate text-xs text-muted-foreground">
                        {worker.workerId}
                      </code>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={worker.status === "active" ? "secondary" : "outline"}>
                          {worker.status === "active" ? "Active identity" : "Revoked"}
                        </Badge>
                        <Badge variant="outline">Identity epoch {worker.identityEpoch}</Badge>
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                      {worker.capabilities.length > 0 ? (
                        worker.capabilities.map((capability) => (
                          <Badge key={capability} variant="outline">
                            {capability}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No capabilities reported
                        </span>
                      )}
                    </div>
                    {worker.status === "active" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={pendingAction !== null}
                        onClick={() => setRevokeTarget(worker)}
                        aria-label={`Revoke ${worker.name}`}
                      >
                        {pendingAction === `revoke-worker:${worker.workerId}` ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <Trash2Icon data-icon="inline-start" />
                        )}
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          {visibleEnrollmentCode ? (
            <>
              <DialogHeader>
                <DialogTitle>Worker setup code</DialogTitle>
                <DialogDescription>
                  This opaque code contains a secret enrollment credential. It is shown only now and
                  expires {formatExpiry(visibleEnrollmentCode.expiresAt)}.
                </DialogDescription>
              </DialogHeader>
              <Alert>
                <ShieldAlertIcon />
                <AlertTitle>Keep this code private</AlertTitle>
                <AlertDescription>
                  Anyone with the code may enroll a Worker in this workspace. Share it only with the
                  device you intend to enroll.
                </AlertDescription>
              </Alert>
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Setup code</span>
                <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs break-all whitespace-pre-wrap select-all">
                  {visibleEnrollmentCode.code}
                </pre>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <TerminalIcon className="size-4 text-muted-foreground" />
                  Enroll from the Worker host
                </div>
                <code className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
                  bun run --cwd packages/worker setup -- --setup-file /secure/path/worker-setup-code
                </code>
                <p className="text-xs text-muted-foreground">
                  Save the code in a file owned by you with permissions 0600, then run this from the
                  Radium checkout using that file's path. The code itself stays out of command-line
                  arguments.
                </p>
              </div>
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
                <DialogTitle>{expired ? "Create a new setup code" : "Enroll a Worker"}</DialogTitle>
                <DialogDescription>
                  Create a short-lived, workspace-scoped code to register a Worker identity.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4 py-2">
                {expired ? (
                  <Alert>
                    <Clock3Icon />
                    <AlertTitle>Setup code expired</AlertTitle>
                    <AlertDescription>
                      The previous code has been cleared. Create another code to continue.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <FieldGroup>
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
                    <FieldDescription>
                      A label to recognize this Worker in the workspace.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </div>
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
                    <FingerprintIcon data-icon="inline-start" />
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
              This disables the Worker identity for this workspace. It does not indicate or control
              whether a Worker process is currently connected.
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

function formatExpiry(expiresAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));
}
