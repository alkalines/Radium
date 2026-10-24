import { useState } from "react";
import { useMutation } from "convex/react";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectDialog } from "./project-dialog";
import type { ProjectSummary } from "./project-glyph";

/**
 * The `…` menu of a Project: Edit (the Project dialog) and Delete. Render it only when the
 * Project's `canManage` is true (creator or workspace owner); the backend re-checks both.
 * Deleting detaches the Project's Sessions instead of deleting them.
 */
export function ProjectActionsMenu({
  project,
  workspaceId,
  isOwner,
}: {
  project: ProjectSummary;
  workspaceId: Id<"workspaces">;
  isOwner: boolean;
}) {
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const removeProject = useMutation(api.projects.remove);

  async function confirmDelete() {
    setIsDeleting(true);
    try {
      await removeProject({ project: project._id });
      toast.success("Project deleted. Its sessions are kept.");
      setIsDeleteOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the project.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`${project.name} actions`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => setIsEditOpen(true)}>
            <PencilIcon />
            Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setIsDeleteOpen(true)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectDialog
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        workspaceId={workspaceId}
        isOwner={isOwner}
        project={project}
      />

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{project.name}”. Its sessions are kept and no longer belong to a
              project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(event) => {
                // Stay open until the mutation settles so a refusal is visible in context.
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
