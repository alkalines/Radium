import { useEffect, useRef, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArchiveIcon,
  BoxesIcon,
  MailIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  UserRoundIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  resolveWorkspaceIconName,
  type WorkspaceIconName,
} from "@/utils/workspaces/icons";
import { WorkspaceIcon, workspaceIconOptions } from "./workspace-icon";
import { useWorkspace, type WorkspaceSummary } from "./workspace-provider";

type WorkspaceMemberList = Exclude<
  FunctionReturnType<typeof api.workspaces.listMembers>,
  string
>;
type ArchivedWorkspaceList = Exclude<
  FunctionReturnType<typeof api.workspaces.listArchived>,
  string
>;

export function WorkspaceManagement() {
  const {
    workspaces,
    workspace,
    workspaceId,
    isLoading,
    error,
    isProvisioning,
    provisionError,
    retryProvisioning,
    setWorkspace,
  } = useWorkspace();
  const createWorkspace = useMutation(api.workspaces.create);
  const renameWorkspace = useMutation(api.workspaces.rename);
  const setWorkspaceIcon = useMutation(api.workspaces.setIcon);
  const archiveWorkspace = useMutation(api.workspaces.archive);
  const restoreWorkspace = useMutation(api.workspaces.restore);
  const addMember = useMutation(api.workspaces.addMember);
  const removeMember = useMutation(api.workspaces.removeMember);
  const ownedWorkspaceCount = workspaces.filter(
    (item) => item.role === "owner",
  ).length;
  const isOwner = workspace?.role === "owner";

  const { data: archivedData, error: archivedError } = useQuery(
    convexQuery(api.workspaces.listArchived, {}),
  );
  const { data: membersData, error: membersError } = useQuery(
    convexQuery(
      api.workspaces.listMembers,
      isOwner && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const archived = Array.isArray(archivedData)
    ? archivedData
    : ([] as ArchivedWorkspaceList);
  const members = Array.isArray(membersData)
    ? membersData
    : ([] as WorkspaceMemberList);

  const [nameDialog, setNameDialog] = useState<"create" | "rename" | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(
    null,
  );
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceSummary | null>(
    null,
  );
  const [iconTarget, setIconTarget] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const workspaceIdRef = useRef(workspaceId);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  function openCreate() {
    if (pendingAction) return;
    setName("");
    setRenameTarget(null);
    setNameDialog("create");
  }

  function openRename(target: WorkspaceSummary) {
    if (pendingAction) return;
    setName(target.name);
    setRenameTarget(target);
    setNameDialog("rename");
  }

  async function submitName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pendingAction) return;

    setPendingAction("name");
    try {
      if (nameDialog === "create") {
        const created = await createWorkspace({ name: trimmed });
        setWorkspace(created);
        toast.success("Workspace created.");
      } else if (renameTarget) {
        await renameWorkspace({ workspace: renameTarget._id, name: trimmed });
        toast.success("Workspace renamed.");
      }
      setNameDialog(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update workspace.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmArchive() {
    if (!archiveTarget || pendingAction) return;
    setPendingAction("archive");
    try {
      await archiveWorkspace({ workspace: archiveTarget._id });
      setArchiveTarget(null);
      toast.success("Workspace archived.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to archive workspace.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function updateWorkspaceIcon(
    target: WorkspaceSummary,
    icon: WorkspaceIconName,
  ) {
    if (pendingAction) return;
    setPendingAction(`icon:${target._id}`);
    try {
      await setWorkspaceIcon({ workspace: target._id, icon });
      setIconTarget(null);
      toast.success("Workspace icon updated.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update workspace icon.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function restore(target: ArchivedWorkspaceList[number]) {
    if (pendingAction) return;
    const workspaceAtStart = workspaceId;
    setPendingAction(target._id);
    try {
      await restoreWorkspace({ workspace: target._id });
      if (workspaceIdRef.current === workspaceAtStart) setWorkspace(target._id);
      toast.success("Workspace restored.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to restore workspace.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function addWorkspaceMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = memberEmail.trim();
    if (!workspaceId || !isOwner || !email || pendingAction) return;
    setPendingAction("add-member");
    try {
      await addMember({ workspace: workspaceId, email });
      setMemberEmail("");
      toast.success("Member added.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add member.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function removeWorkspaceMember(email: string) {
    if (!workspaceId || !isOwner || pendingAction) return;
    setPendingAction(email);
    try {
      await removeMember({ workspace: workspaceId, email });
      toast.success("Member removed.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove member.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Workspaces
          </h1>
          <p className="text-sm text-muted-foreground">
            Keep models, credentials, settings, and conversations separated by
            context.
          </p>
        </div>
        <Button
          onClick={openCreate}
          disabled={
            isLoading ||
            isProvisioning ||
            workspaces.length === 0 ||
            error !== null ||
            pendingAction !== null
          }
        >
          <PlusIcon data-icon="inline-start" />
          New workspace
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your workspaces</CardTitle>
          <CardDescription>
            Choose the active workspace or manage one you own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Workspaces unavailable</AlertTitle>
              <AlertDescription>
                Radium could not load your workspaces. Try refreshing the page.
              </AlertDescription>
            </Alert>
          ) : isLoading || isProvisioning ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : workspaces.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BoxesIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {provisionError
                    ? "Workspace setup failed"
                    : "Preparing your workspace"}
                </EmptyTitle>
                <EmptyDescription>
                  {provisionError
                    ? "Radium could not create the personal workspace for this account."
                    : "Radium is creating the personal workspace for this account."}
                </EmptyDescription>
              </EmptyHeader>
              {provisionError ? (
                <Button variant="outline" onClick={retryProvisioning}>
                  <RotateCcwIcon data-icon="inline-start" />
                  Retry setup
                </Button>
              ) : null}
            </Empty>
          ) : (
            <div className="flex flex-col divide-y rounded-lg border">
              {workspaces.map((item) => {
                const active = item._id === workspaceId;
                return (
                  <div
                    key={item._id}
                    className="flex flex-wrap items-center gap-3 p-3"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                      <WorkspaceIcon name={item.icon} className="size-4" />
                    </div>
                    <div className="flex min-w-40 flex-1 flex-col gap-1">
                      <span className="truncate font-medium">{item.name}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="capitalize">
                          {item.role}
                        </Badge>
                        {active ? (
                          <Badge variant="secondary">Active</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!active ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setWorkspace(item._id)}
                        >
                          Switch
                        </Button>
                      ) : null}
                      {item.role === "owner" ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openRename(item)}
                            aria-label={`Rename ${item.name}`}
                          >
                            <PencilIcon />
                          </Button>
                          <Popover
                            open={iconTarget === item._id}
                            onOpenChange={(open) =>
                              !pendingAction &&
                              setIconTarget(open ? item._id : null)
                            }
                          >
                            <PopoverTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={pendingAction !== null}
                                aria-label={`Change ${item.name} icon`}
                              >
                                <PaletteIcon />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="end"
                              className="w-64"
                              aria-labelledby={`workspace-icon-title-${item._id}`}
                              aria-describedby={`workspace-icon-description-${item._id}`}
                            >
                              <PopoverHeader>
                                <PopoverTitle
                                  id={`workspace-icon-title-${item._id}`}
                                >
                                  Workspace icon
                                </PopoverTitle>
                                <PopoverDescription
                                  id={`workspace-icon-description-${item._id}`}
                                >
                                  Choose an icon for {item.name}.
                                </PopoverDescription>
                              </PopoverHeader>
                              <div className="grid grid-cols-6 place-items-center gap-1">
                                {workspaceIconOptions.map((option) => {
                                  const selected =
                                    resolveWorkspaceIconName(item.icon) ===
                                    option.name;
                                  return (
                                    <Button
                                      key={option.name}
                                      variant={selected ? "secondary" : "ghost"}
                                      size="icon-sm"
                                      title={option.label}
                                      disabled={pendingAction !== null}
                                      onClick={() =>
                                        void updateWorkspaceIcon(
                                          item,
                                          option.name,
                                        )
                                      }
                                      aria-label={`Use ${option.label} icon`}
                                      aria-pressed={selected}
                                    >
                                      {pendingAction === `icon:${item._id}` &&
                                      selected ? (
                                        <Spinner />
                                      ) : (
                                        <option.icon />
                                      )}
                                      {selected ? (
                                        <span className="sr-only">
                                          Selected
                                        </span>
                                      ) : null}
                                    </Button>
                                  );
                                })}
                              </div>
                            </PopoverContent>
                          </Popover>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={ownedWorkspaceCount <= 1}
                            onClick={() => setArchiveTarget(item)}
                            aria-label={`Archive ${item.name}`}
                          >
                            <ArchiveIcon />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Member access</CardTitle>
          <CardDescription>
            {workspace
              ? `People with access to ${workspace.name}.`
              : "Select a workspace to manage access."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!workspace ? (
            <Alert>
              <AlertTitle>Workspace unavailable</AlertTitle>
              <AlertDescription>
                Select an active workspace to manage its members.
              </AlertDescription>
            </Alert>
          ) : !isOwner ? (
            <Alert>
              <AlertTitle>Owner access required</AlertTitle>
              <AlertDescription>
                You are a member of this workspace. Only its owner can change
                member access.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <form onSubmit={addWorkspaceMember}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="workspace-member-email">
                      Add member by email
                    </FieldLabel>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        id="workspace-member-email"
                        type="email"
                        autoComplete="off"
                        placeholder="teammate@example.com"
                        value={memberEmail}
                        disabled={pendingAction !== null}
                        onChange={(event) => setMemberEmail(event.target.value)}
                      />
                      <Button
                        type="submit"
                        className="w-full sm:w-auto"
                        disabled={!memberEmail.trim() || pendingAction !== null}
                      >
                        {pendingAction === "add-member" ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <UsersIcon data-icon="inline-start" />
                        )}
                        Add member
                      </Button>
                    </div>
                    <FieldDescription>
                      The person must already have a registered Radium account.
                      Access is granted immediately; no invitation is sent.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </form>

              <div className="flex flex-col divide-y rounded-lg border">
                {membersError ? (
                  <Alert
                    className="rounded-none border-0"
                    variant="destructive"
                  >
                    <AlertTitle>Members unavailable</AlertTitle>
                    <AlertDescription>
                      This workspace can no longer be managed from your account.
                    </AlertDescription>
                  </Alert>
                ) : membersData === undefined ? (
                  <div className="flex flex-col gap-2 p-3">
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                  </div>
                ) : (
                  members.map((member) => (
                    <div
                      key={member.userId}
                      className="flex items-center gap-3 p-3"
                    >
                      <Avatar size="sm">
                        <AvatarFallback>
                          {getInitials(member.name || member.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">
                          {member.name || member.email}
                        </span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <MailIcon className="size-3 shrink-0" />
                          {member.email}
                        </span>
                      </div>
                      <Badge
                        variant={
                          member.role === "owner" ? "default" : "secondary"
                        }
                      >
                        {member.role}
                      </Badge>
                      {member.role === "member" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={pendingAction !== null}
                          onClick={() =>
                            void removeWorkspaceMember(member.email)
                          }
                          aria-label={`Remove ${member.email}`}
                        >
                          {pendingAction === member.email ? (
                            <Spinner />
                          ) : (
                            <XIcon />
                          )}
                        </Button>
                      ) : (
                        <UserRoundIcon className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {archivedData === undefined || archivedError || archived.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Archived workspaces</CardTitle>
            <CardDescription>
              Restore an archived workspace and its configuration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {archivedError ? (
              <Alert variant="destructive">
                <AlertTitle>Archived workspaces unavailable</AlertTitle>
                <AlertDescription>
                  Try refreshing the page before restoring a workspace.
                </AlertDescription>
              </Alert>
            ) : archivedData === undefined ? (
              <Skeleton className="h-16" />
            ) : (
              <div className="flex flex-col divide-y rounded-lg border">
                {archived.map((item) => (
                  <div key={item._id} className="flex items-center gap-3 p-3">
                    <WorkspaceIcon
                      name={item.icon}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {item.name}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pendingAction !== null}
                      onClick={() => void restore(item)}
                    >
                      {pendingAction === item._id ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <RotateCcwIcon data-icon="inline-start" />
                      )}
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => !open && !pendingAction && setNameDialog(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitName} className="contents">
            <DialogHeader>
              <DialogTitle>
                {nameDialog === "rename" ? "Rename workspace" : "New workspace"}
              </DialogTitle>
              <DialogDescription>
                Workspaces keep provider credentials, API keys, settings, and
                chats separate.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
                <Input
                  id="workspace-name"
                  autoFocus
                  maxLength={80}
                  value={name}
                  disabled={pendingAction !== null}
                  placeholder="Personal workspace"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNameDialog(null)}
                disabled={pendingAction !== null}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pendingAction !== null || !name.trim()}
              >
                {pendingAction === "name" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {nameDialog === "rename" ? "Rename" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveTarget !== null}
        onOpenChange={(open) =>
          !open && !pendingAction && setArchiveTarget(null)
        }
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive {archiveTarget?.name}?</DialogTitle>
            <DialogDescription>
              The workspace will leave the active list. It can be restored from
              this page later. Workspaces containing chats cannot be archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setArchiveTarget(null)}
              disabled={pendingAction !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmArchive()}
              disabled={pendingAction !== null}
            >
              {pendingAction === "archive" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getInitials(value: string) {
  const initials = value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "?";
}
