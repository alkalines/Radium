import { type FormEvent, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import {
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { Tag } from "@/components/harness/group-list";
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
  Dialog,
  DialogClose,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** Matches the backend's title length limit for user-chosen titles. */
const maxTitleLength = 32;

/** What the actions need to know about one session; `ListChats` items satisfy it. */
export type SessionActionsTarget = {
  id: Id<"aisdk_chats">;
  title?: string;
  pinnedAt?: number;
};

/**
 * The `…` menu of a Home session Row (`docs/Interface_Design.md` §5.1): Pin, Rename, Regenerate
 * title, Move to project (planned), Delete. Only rendered for sessions the user can manage; the
 * backend re-checks every mutation and returns a string on refusal, which is shown as a toast.
 * The trigger is revealed by the Row on hover/focus and stays visible while open.
 */
export function SessionActionsMenu({ session }: { session: SessionActionsTarget }) {
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [title, setTitle] = useState(session.title?.trim() ?? "");
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const setPinned = useMutation(api.aisdk.SetChatPinned);
  const renameChat = useMutation(api.aisdk.RenameChat);
  const regenerateTitle = useMutation(api.aisdk.RegenerateChatTitle);
  const deleteChat = useMutation(api.aisdk.DeleteChat);

  // Reopening Rename starts from the current title, including one regenerated meanwhile.
  useEffect(() => {
    if (!isRenameOpen) setTitle(session.title?.trim() ?? "");
  }, [session.title, isRenameOpen]);

  const isBusy = pendingAction !== null;
  const displayTitle = session.title?.trim() || "Untitled session";

  /** Runs one mutation; a string result is a backend refusal, a throw is a failure. */
  async function run(action: string, mutate: () => Promise<unknown>) {
    setPendingAction(action);
    try {
      const result = await mutate();
      if (typeof result === "string") {
        toast.error(result);
        return false;
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Session action failed.");
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function togglePinned() {
    const isPinned = Boolean(session.pinnedAt);
    const succeeded = await run("pin", () => setPinned({ chatId: session.id, pinned: !isPinned }));
    if (succeeded) toast.success(isPinned ? "Session unpinned." : "Session pinned.");
  }

  async function regenerate() {
    const succeeded = await run("regenerate", () => regenerateTitle({ chatId: session.id }));
    if (succeeded) toast.success("Regenerating the session title.");
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const succeeded = await run("rename", () => renameChat({ chatId: session.id, title: trimmed }));
    if (succeeded) {
      toast.success("Session renamed.");
      setIsRenameOpen(false);
    }
  }

  async function confirmDelete() {
    // An open Tab for this session drops itself once the chat is gone (spec §4).
    const succeeded = await run("delete", () => deleteChat({ chatId: session.id }));
    if (succeeded) {
      toast.success("Session deleted.");
      setIsDeleteOpen(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${displayTitle} actions`}
            className="relative opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={isBusy} onSelect={() => void togglePinned()}>
              {session.pinnedAt ? <PinOffIcon /> : <PinIcon />}
              {session.pinnedAt ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isBusy} onSelect={() => setIsRenameOpen(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={isBusy} onSelect={() => void regenerate()}>
              <SparklesIcon />
              Regenerate title
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <FolderInputIcon />
              Move to project
              <Tag className="ml-auto">Planned</Tag>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              disabled={isBusy}
              onSelect={() => setIsDeleteOpen(true)}
            >
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={(event) => void submitRename(event)} className="contents">
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>A short title for Home and the Tab strip.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`session-title-${session.id}`}>Title</FieldLabel>
                <Input
                  id={`session-title-${session.id}`}
                  value={title}
                  maxLength={maxTitleLength}
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isBusy || !title.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{displayTitle}” and its messages. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isBusy}
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
