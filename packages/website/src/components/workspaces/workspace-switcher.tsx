import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArchiveIcon,
  BoxesIcon,
  ChevronsUpDownIcon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  UserRoundIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useWorkspace } from "./workspace-provider";

type WorkspaceMemberList = Exclude<FunctionReturnType<typeof api.workspaces.listMembers>, string>;
type ArchivedWorkspaceList = Exclude<
  FunctionReturnType<typeof api.workspaces.listArchived>,
  string
>;

export function WorkspaceSwitcher() {
  const { workspaces, workspace, workspaceId, isLoading, setWorkspace } = useWorkspace();
  const createWorkspace = useMutation(api.workspaces.create);
  const renameWorkspace = useMutation(api.workspaces.rename);
  const archiveWorkspace = useMutation(api.workspaces.archive);
  const restoreWorkspace = useMutation(api.workspaces.restore);
  const addMember = useMutation(api.workspaces.addMember);
  const removeMember = useMutation(api.workspaces.removeMember);
  const isOwner = workspace?.role === "owner";
  const ownedWorkspaceCount = workspaces.filter((item) => item.role === "owner").length;
  const { data: archivedData } = useQuery(convexQuery(api.workspaces.listArchived, {}));
  const { data: membersData, error: membersError } = useQuery(
    convexQuery(
      api.workspaces.listMembers,
      isOwner && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const archived = Array.isArray(archivedData) ? archivedData : ([] as ArchivedWorkspaceList);
  const members = Array.isArray(membersData) ? membersData : ([] as WorkspaceMemberList);
  const [dialog, setDialog] = useState<"create" | "rename" | "members" | "archived" | null>(null);
  const [name, setName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberAction, setMemberAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function openCreate() {
    setName("");
    setDialog("create");
  }

  function openRename() {
    setName(workspace?.name ?? "");
    setDialog("rename");
  }

  function openMembers() {
    setMemberEmail("");
    setDialog("members");
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      if (dialog === "create") {
        const created = await createWorkspace({ name: trimmed });
        setWorkspace(created);
        toast.success("Workspace created.");
      } else if (dialog === "rename" && workspaceId) {
        await renameWorkspace({ workspace: workspaceId, name: trimmed });
        toast.success("Workspace renamed.");
      }
      setDialog(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  async function archive() {
    if (!workspaceId || !isOwner || ownedWorkspaceCount <= 1 || submitting) return;
    setSubmitting(true);
    try {
      await archiveWorkspace({ workspace: workspaceId });
      toast.success("Workspace archived.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  async function addWorkspaceMember() {
    const email = memberEmail.trim();
    if (!workspaceId || !isOwner || !email || memberAction) return;
    setMemberAction("add");
    try {
      await addMember({ workspace: workspaceId, email });
      setMemberEmail("");
      toast.success("Member added.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add member.");
    } finally {
      setMemberAction(null);
    }
  }

  async function removeWorkspaceMember(email: string) {
    if (!workspaceId || !isOwner || memberAction) return;
    setMemberAction(email);
    try {
      await removeMember({ workspace: workspaceId, email });
      toast.success("Member removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove member.");
    } finally {
      setMemberAction(null);
    }
  }

  async function restoreArchivedWorkspace(archivedWorkspaceId: (typeof archived)[number]["_id"]) {
    if (memberAction) return;
    setMemberAction(archivedWorkspaceId);
    try {
      await restoreWorkspace({ workspace: archivedWorkspaceId });
      setWorkspace(archivedWorkspaceId);
      setDialog(null);
      toast.success("Workspace restored.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restore workspace.");
    } finally {
      setMemberAction(null);
    }
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                className="h-11 border border-sidebar-border bg-sidebar-accent/40"
                disabled={isLoading || !workspace}
                tooltip={workspace?.name ?? "Workspace"}
              >
                <BoxesIcon />
                <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                  <span className="text-[0.65rem] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/50">
                    Workspace
                  </span>
                  <span className="w-full truncate font-medium">
                    {workspace?.name ?? (isLoading ? "Preparing..." : "No workspace")}
                  </span>
                  {workspace ? (
                    <Badge
                      variant="outline"
                      className="mt-0.5 px-1.5 py-0 text-[0.6rem] capitalize"
                    >
                      {workspace.role}
                    </Badge>
                  ) : null}
                </span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-sidebar-foreground/50" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" className="w-64">
              <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
              {workspaces.map((item) => (
                <DropdownMenuItem
                  key={item._id}
                  className="gap-2"
                  onSelect={() => setWorkspace(item._id)}
                >
                  <BoxesIcon className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <Badge variant="outline" className="px-1.5 py-0 text-[0.6rem] capitalize">
                    {item.role}
                  </Badge>
                  {item._id === workspaceId && <span className="text-xs text-primary">Active</span>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openCreate}>
                <PlusIcon className="size-4" />
                New workspace
              </DropdownMenuItem>
              {isOwner ? (
                <>
                  <DropdownMenuItem disabled={!workspaceId} onSelect={openRename}>
                    <PencilIcon className="size-4" />
                    Rename current
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!workspaceId || ownedWorkspaceCount <= 1}
                    variant="destructive"
                    onSelect={() => void archive()}
                  >
                    <ArchiveIcon className="size-4" />
                    Archive current
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!workspaceId} onSelect={openMembers}>
                    <UsersIcon className="size-4" />
                    Manage members
                  </DropdownMenuItem>
                </>
              ) : null}
              {archived.length > 0 ? (
                <DropdownMenuItem onSelect={() => setDialog("archived")}>
                  <RotateCcwIcon className="size-4" />
                  Restore archived
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className={dialog === "members" ? "sm:max-w-lg" : "sm:max-w-sm"}>
          {dialog === "members" ? (
            <>
              <DialogHeader>
                <DialogTitle>Manage members</DialogTitle>
                <DialogDescription>
                  Add registered Radium users to <strong>{workspace?.name}</strong>. Members can use
                  workspace chats, but cannot manage Gateway or workspace settings.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workspace-member-email">Member email</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id="workspace-member-email"
                      type="email"
                      autoComplete="off"
                      placeholder="teammate@example.com"
                      value={memberEmail}
                      onChange={(event) => setMemberEmail(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void addWorkspaceMember();
                        }
                      }}
                    />
                    <Button
                      onClick={() => void addWorkspaceMember()}
                      disabled={!memberEmail.trim() || memberAction !== null}
                    >
                      {memberAction === "add" && <Spinner data-icon="inline-start" />}
                      Add
                    </Button>
                  </div>
                  <FieldDescription>Only existing registered users can be added.</FieldDescription>
                </Field>
              </FieldGroup>
              <div className="flex flex-col divide-y rounded-lg border">
                {membersError ? (
                  <Alert className="rounded-none border-0" variant="destructive">
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
                ) : members.length === 0 ? (
                  <Empty className="rounded-none border-0 py-8">
                    <EmptyHeader>
                      <EmptyTitle>No members</EmptyTitle>
                      <EmptyDescription>Add a registered user by email.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  members.map((member) => (
                    <div key={member.userId} className="flex items-center gap-3 p-3">
                      <Avatar size="sm">
                        <AvatarFallback>{getInitials(member.name || member.email)}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{member.name || member.email}</span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <MailIcon className="size-3 shrink-0" />
                          {member.email}
                        </span>
                      </div>
                      <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                        {member.role}
                      </Badge>
                      {member.role === "member" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={memberAction !== null}
                          onClick={() => void removeWorkspaceMember(member.email)}
                          aria-label={`Remove ${member.email}`}
                        >
                          {memberAction === member.email ? <Spinner /> : <XIcon />}
                        </Button>
                      ) : (
                        <UserRoundIcon className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  ))
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : dialog === "archived" ? (
            <>
              <DialogHeader>
                <DialogTitle>Restore archived workspace</DialogTitle>
                <DialogDescription>
                  Restored workspaces keep their existing chats and configuration.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col divide-y rounded-lg border">
                {archived.map((item) => (
                  <div key={item._id} className="flex items-center gap-3 p-3">
                    <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={memberAction !== null}
                      onClick={() => void restoreArchivedWorkspace(item._id)}
                    >
                      {memberAction === item._id && <Spinner data-icon="inline-start" />}
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog === "rename" ? "Rename workspace" : "New workspace"}
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
                    value={name}
                    placeholder="Personal workspace"
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submit();
                    }}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialog(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={submitting || !name.trim()}>
                  {submitting && <Spinner data-icon="inline-start" />}
                  {dialog === "rename" ? "Rename" : "Create"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
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
