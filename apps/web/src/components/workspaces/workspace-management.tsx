import { useEffect, useRef, useState, type FormEvent } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArchiveIcon, BoxesIcon, PlusIcon, RotateCcwIcon, UsersIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { ProjectTile } from "@/components/harness/project-tile";
import { WorkspacePageHeader, ownerOnlyNotice } from "@/components/settings/workspace-page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { resolveWorkspaceIconName, type WorkspaceIconName } from "backend/src/workspaces/icons";
import { WorkspaceIcon, workspaceIconOptions } from "./workspace-icon";
import { useWorkspace, type WorkspaceSummary } from "./workspace-provider";

type WorkspaceMemberList = Exclude<FunctionReturnType<typeof api.workspaces.listMembers>, string>;
type ArchivedWorkspaceList = Exclude<
  FunctionReturnType<typeof api.workspaces.listArchived>,
  string
>;

/**
 * General settings of the current workspace (`docs/Interface_Design.md` §5.2): its name, icon,
 * and member access (owner-only), the user's other workspaces with switching and creation, and
 * archived workspaces to restore. Members see the current workspace without editing controls.
 */
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
  const ownedWorkspaceCount = workspaces.filter((item) => item.role === "owner").length;
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
  const archived = Array.isArray(archivedData) ? archivedData : ([] as ArchivedWorkspaceList);
  const members = Array.isArray(membersData) ? membersData : ([] as WorkspaceMemberList);

  const [nameDialog, setNameDialog] = useState<"create" | "rename" | null>(null);
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceSummary | null>(null);
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false);
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
      toast.error(error instanceof Error ? error.message : "Failed to update workspace.");
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
      toast.error(error instanceof Error ? error.message : "Failed to archive workspace.");
    } finally {
      setPendingAction(null);
    }
  }

  async function updateWorkspaceIcon(target: WorkspaceSummary, icon: WorkspaceIconName) {
    if (pendingAction) return;
    setPendingAction(`icon:${target._id}`);
    try {
      await setWorkspaceIcon({ workspace: target._id, icon });
      setIsIconPickerOpen(false);
      toast.success("Workspace icon updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update workspace icon.");
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
      toast.error(error instanceof Error ? error.message : "Failed to restore workspace.");
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
      toast.error(error instanceof Error ? error.message : "Failed to add member.");
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
      toast.error(error instanceof Error ? error.message : "Failed to remove member.");
    } finally {
      setPendingAction(null);
    }
  }

  const isListLoading = isLoading || isProvisioning;
  const canCreate =
    !isListLoading && workspaces.length > 0 && error === null && pendingAction === null;

  return (
    <>
      <WorkspacePageHeader
        title="General"
        description={
          isOwner || !workspace
            ? "Keep models, credentials, settings, and conversations separated by context."
            : ownerOnlyNotice
        }
        action={
          <Button variant="outline" size="sm" onClick={openCreate} disabled={!canCreate}>
            <PlusIcon data-icon="inline-start" />
            New workspace
          </Button>
        }
      />

      {workspace ? (
        <GroupList title="Workspace">
          <Row title="Name" description={workspace.name} tag={isOwner ? undefined : "Member"}>
            {isOwner ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pendingAction !== null}
                onClick={() => openRename(workspace)}
              >
                Rename
              </Button>
            ) : null}
          </Row>
          <Row
            leading={
              <ProjectTile>
                <WorkspaceIcon name={workspace.icon} />
              </ProjectTile>
            }
            title="Icon"
            description="Shown in the Tab strip, Home, and Settings."
          >
            {isOwner ? (
              <Popover
                open={isIconPickerOpen}
                onOpenChange={(open) => !pendingAction && setIsIconPickerOpen(open)}
              >
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pendingAction !== null}>
                    Change
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-64"
                  aria-labelledby="workspace-icon-title"
                  aria-describedby="workspace-icon-description"
                >
                  <PopoverHeader>
                    <PopoverTitle id="workspace-icon-title">Workspace icon</PopoverTitle>
                    <PopoverDescription id="workspace-icon-description">
                      Choose an icon for {workspace.name}.
                    </PopoverDescription>
                  </PopoverHeader>
                  <div className="grid grid-cols-6 place-items-center gap-1">
                    {workspaceIconOptions.map((option) => {
                      const selected = resolveWorkspaceIconName(workspace.icon) === option.name;
                      const isSaving = pendingAction === `icon:${workspace._id}` && selected;

                      return (
                        <Button
                          key={option.name}
                          variant={selected ? "secondary" : "ghost"}
                          size="icon-sm"
                          title={option.label}
                          disabled={pendingAction !== null}
                          onClick={() => void updateWorkspaceIcon(workspace, option.name)}
                          aria-label={`Use ${option.label} icon`}
                          aria-pressed={selected}
                        >
                          {isSaving ? <Spinner /> : <option.icon />}
                          {selected ? <span className="sr-only">Selected</span> : null}
                        </Button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </Row>
          {isOwner ? (
            <Row
              icon={ArchiveIcon}
              title="Archive workspace"
              description={
                ownedWorkspaceCount <= 1
                  ? "Your only owned workspace cannot be archived."
                  : "Hide it from the workspace list. You can restore it here later."
              }
            >
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={ownedWorkspaceCount <= 1 || pendingAction !== null}
                onClick={() => setArchiveTarget(workspace)}
              >
                Archive
              </Button>
            </Row>
          ) : null}
        </GroupList>
      ) : null}

      {workspace ? (
        <GroupList
          title="Members"
          description={`People with access to ${workspace.name}. Personal chats stay private to their creator.`}
        >
          {isOwner ? (
            <>
              <RowBlock>
                <form onSubmit={addWorkspaceMember}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="workspace-member-email">Add member by email</FieldLabel>
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
                          variant="outline"
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
                        The person must already have a registered Radium account. Access is granted
                        immediately; no invitation is sent.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </form>
              </RowBlock>
              <MemberRows
                members={members}
                isLoading={membersData === undefined}
                hasError={Boolean(membersError)}
                pendingAction={pendingAction}
                onRemove={(email) => void removeWorkspaceMember(email)}
              />
            </>
          ) : (
            <RowBlock>
              <p className="text-sm text-muted-foreground">
                Only the workspace owner can see and change member access.
              </p>
            </RowBlock>
          )}
        </GroupList>
      ) : null}

      <GroupList title="Your workspaces" description="Choose which workspace Radium shows.">
        <WorkspaceRows
          workspaces={workspaces}
          currentWorkspaceId={workspaceId}
          isLoading={isListLoading}
          hasError={error !== null}
          provisionError={provisionError}
          onRetryProvisioning={retryProvisioning}
          onSwitch={setWorkspace}
        />
      </GroupList>

      {archivedData === undefined || archivedError || archived.length > 0 ? (
        <GroupList
          title="Archived"
          description="Restore an archived workspace and its configuration."
        >
          <ArchivedRows
            archived={archived}
            isLoading={archivedData === undefined}
            hasError={Boolean(archivedError)}
            pendingAction={pendingAction}
            onRestore={(target) => void restore(target)}
          />
        </GroupList>
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
                Workspaces keep provider credentials, API keys, settings, and chats separate.
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
              <Button type="submit" disabled={pendingAction !== null || !name.trim()}>
                {pendingAction === "name" ? <Spinner data-icon="inline-start" /> : null}
                {nameDialog === "rename" ? "Rename" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && !pendingAction && setArchiveTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive {archiveTarget?.name}?</DialogTitle>
            <DialogDescription>
              The workspace will leave the active list. It can be restored from this page later.
              Workspaces containing chats cannot be archived.
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
              {pendingAction === "archive" ? <Spinner data-icon="inline-start" /> : null}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SkeletonRows() {
  return (
    <RowBlock aria-busy="true">
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
    </RowBlock>
  );
}

function WorkspaceRows({
  workspaces,
  currentWorkspaceId,
  isLoading,
  hasError,
  provisionError,
  onRetryProvisioning,
  onSwitch,
}: {
  workspaces: WorkspaceSummary[];
  currentWorkspaceId?: WorkspaceSummary["_id"];
  isLoading: boolean;
  hasError: boolean;
  provisionError: Error | null;
  onRetryProvisioning: () => void;
  onSwitch: (workspaceId: WorkspaceSummary["_id"]) => void;
}) {
  if (hasError) {
    return (
      <RowBlock>
        <p className="text-sm text-destructive">
          Radium could not load your workspaces. Try refreshing the page.
        </p>
      </RowBlock>
    );
  }

  if (isLoading) {
    return <SkeletonRows />;
  }

  if (workspaces.length === 0) {
    return (
      <RowBlock>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>
              {provisionError ? "Workspace setup failed" : "Preparing your workspace"}
            </EmptyTitle>
            <EmptyDescription>
              {provisionError
                ? "Radium could not create the personal workspace for this account."
                : "Radium is creating the personal workspace for this account."}
            </EmptyDescription>
          </EmptyHeader>
          {provisionError ? (
            <Button variant="outline" size="sm" onClick={onRetryProvisioning}>
              <RotateCcwIcon data-icon="inline-start" />
              Retry setup
            </Button>
          ) : null}
        </Empty>
      </RowBlock>
    );
  }

  return workspaces.map((item) => {
    const isCurrent = item._id === currentWorkspaceId;

    return (
      <Row
        key={item._id}
        leading={
          <ProjectTile>
            <WorkspaceIcon name={item.icon} />
          </ProjectTile>
        }
        title={item.name}
        tag={item.role === "owner" ? "Owner" : "Member"}
      >
        {isCurrent ? (
          <span className="px-2 text-sm text-muted-foreground">Current</span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onSwitch(item._id)}>
            Switch
          </Button>
        )}
      </Row>
    );
  });
}

function MemberRows({
  members,
  isLoading,
  hasError,
  pendingAction,
  onRemove,
}: {
  members: WorkspaceMemberList;
  isLoading: boolean;
  hasError: boolean;
  pendingAction: string | null;
  onRemove: (email: string) => void;
}) {
  if (hasError) {
    return (
      <RowBlock>
        <p className="text-sm text-destructive">
          Members unavailable: this workspace can no longer be managed from your account.
        </p>
      </RowBlock>
    );
  }

  if (isLoading) {
    return <SkeletonRows />;
  }

  return members.map((member) => (
    <Row
      key={member.userId}
      leading={
        <Avatar size="sm">
          <AvatarFallback>{getInitials(member.name || member.email)}</AvatarFallback>
        </Avatar>
      }
      title={member.name || member.email}
      description={member.email}
      tag={member.role === "owner" ? "Owner" : "Member"}
    >
      {member.role === "member" ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          disabled={pendingAction !== null}
          onClick={() => onRemove(member.email)}
          aria-label={`Remove ${member.email}`}
        >
          {pendingAction === member.email ? <Spinner /> : <XIcon />}
        </Button>
      ) : null}
    </Row>
  ));
}

function ArchivedRows({
  archived,
  isLoading,
  hasError,
  pendingAction,
  onRestore,
}: {
  archived: ArchivedWorkspaceList;
  isLoading: boolean;
  hasError: boolean;
  pendingAction: string | null;
  onRestore: (target: ArchivedWorkspaceList[number]) => void;
}) {
  if (hasError) {
    return (
      <RowBlock>
        <p className="text-sm text-destructive">
          Archived workspaces are unavailable. Try refreshing the page before restoring one.
        </p>
      </RowBlock>
    );
  }

  if (isLoading) {
    return <SkeletonRows />;
  }

  return archived.map((item) => (
    <Row
      key={item._id}
      leading={<WorkspaceIcon name={item.icon} className="size-4 shrink-0 text-muted-foreground" />}
      title={item.name}
    >
      <Button
        size="sm"
        variant="outline"
        disabled={pendingAction !== null}
        onClick={() => onRestore(item)}
      >
        {pendingAction === item._id ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RotateCcwIcon data-icon="inline-start" />
        )}
        Restore
      </Button>
    </Row>
  ));
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
