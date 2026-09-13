import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { ChevronsUpDownIcon, PlusIcon, PencilIcon, ArchiveIcon, BoxesIcon } from "lucide-react";

import { api } from "../../../convex/_generated/api";
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useWorkspace } from "./workspace-provider";

export function WorkspaceSwitcher() {
  const { workspaces, workspace, workspaceId, isLoading, setWorkspace } = useWorkspace();
  const createWorkspace = useMutation(api.workspaces.create);
  const renameWorkspace = useMutation(api.workspaces.rename);
  const archiveWorkspace = useMutation(api.workspaces.archive);
  const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function openCreate() {
    setName("");
    setDialog("create");
  }

  function openRename() {
    setName(workspace?.name ?? "");
    setDialog("rename");
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
    if (!workspaceId || workspaces.length <= 1 || submitting) return;
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
                  {item._id === workspaceId && <span className="text-xs text-primary">Active</span>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openCreate}>
                <PlusIcon className="size-4" />
                New workspace
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!workspaceId} onSelect={openRename}>
                <PencilIcon className="size-4" />
                Rename current
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!workspaceId || workspaces.length <= 1}
                variant="destructive"
                onSelect={() => void archive()}
              >
                <ArchiveIcon className="size-4" />
                Archive current
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialog === "rename" ? "Rename workspace" : "New workspace"}</DialogTitle>
            <DialogDescription>
              Workspaces keep provider credentials, API keys, settings, and chats separate.
            </DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || !name.trim()}>
              {submitting && <Spinner data-icon="inline-start" />}
              {dialog === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
