import { type FormEvent, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FolderInputIcon,
  FolderMinusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import type { Id } from "backend/convex/_generated/dataModel";
import { ProjectGlyph, type ProjectSummary } from "@/components/projects/project-glyph";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import { openMessages, sealTitle } from "@/lib/crypto/chat-content";
import { ensureChatKeys, writableChatKey } from "@/lib/crypto/chat-keys";
import { ChatKeysRequiredError, openHistoricalChat } from "@/lib/crypto/legacy-chat";
import type { SealedLegacyBox } from "@/lib/crypto/legacy-content";
import { getMessageText } from "@/components/session/message-parts";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { useTrpc } from "@/lib/trpc";
/** Matches the backend's title length limit for user-chosen titles. */
const maxTitleLength = 32;

/** Radio value for "No project"; Project ids never collide with it. */
const noProject = "none";

/** What the actions need to know about one session; `ListChats` items satisfy it. */
export type SessionActionsTarget = {
  id: Id<"aisdk_chats">;
  workspace: Id<"workspaces">;
  e2ee?: { e2eeId: string } | null;
  /** Historical content moved into a sidecar; rename/regenerate must create chat keys first. */
  legacyContent?: SealedLegacyBox | null;
  title?: string | null;
  pinnedAt?: number | null;
  project?: string | null;
  agent: { agentId: string; name: string } | null;
  /** Manager-only actions: Regenerate title and Move to project. */
  canManage: boolean;
};

/**
 * The `…` menu of a Home session Row (`docs/Interface_Design.md` §5.1): Pin, Rename, Regenerate
 * title, Move to project, Delete. Rendered for sessions the user can act on (`canAct`: managers,
 * and everyone who sees an ACP session); Regenerate title and Move to project also need
 * `canManage`. The backend re-checks every mutation and returns a string on refusal, which is
 * shown as a toast.
 * Moving to a Project (or out of one) asks for confirmation first, since the session's next turns
 * run in the target's context; this menu is the only place a saved session changes Project.
 * `projects` is the workspace's Project list, passed in once by Home rather than queried per Row.
 * The trigger is revealed by the Row on hover/focus and stays visible while open.
 */
export function SessionActionsMenu({
  session,
  projects,
}: {
  session: SessionActionsTarget;
  projects: ProjectSummary[];
}) {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const keyStatus = useKeyStatus();
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  // The target outlives the open state so the dialog keeps its text while it animates closed.
  const [moveTarget, setMoveTarget] = useState<{ id: string | null; name: string } | null>(null);
  const [isMoveOpen, setIsMoveOpen] = useState(false);
  const [title, setTitle] = useState(session.title?.trim() ?? "");
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const changed = {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.chats.pathKey() }),
  };
  const { mutateAsync: setPinned } = useMutation(trpc.chats.setPinned.mutationOptions(changed));
  const { mutateAsync: renameChat } = useMutation(trpc.chats.rename.mutationOptions(changed));
  const { mutateAsync: regenerateTitle } = useMutation(
    trpc.chats.regenerateTitle.mutationOptions(changed),
  );
  const { mutateAsync: deleteChat } = useMutation(trpc.chats.delete.mutationOptions(changed));
  const { mutateAsync: setChatProject } = useMutation(
    trpc.chats.setProject.mutationOptions(changed),
  );

  // Reopening Rename starts from the current title, including one regenerated meanwhile.
  useEffect(() => {
    if (!isRenameOpen) setTitle(session.title?.trim() ?? "");
  }, [session.title, isRenameOpen]);
  useEffect(() => {
    if (session.e2ee && keyStatus.state !== "unlocked") {
      setTitle("");
      setIsRenameOpen(false);
    }
  }, [session.e2ee, keyStatus]);

  const isBusy = pendingAction !== null;
  const displayTitle = session.title?.trim() || "Untitled session";
  const currentProject = projects.find((project) => project.id === session.project);

  /** Runs one mutation; a refusal or failure surfaces as a toast. */
  async function run(action: string, mutate: () => Promise<unknown>) {
    setPendingAction(action);
    try {
      await mutate();
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
    const succeeded = await run("regenerate", async () => {
      const keyed = session.e2ee || (await ensureChatKeys(session.id));
      if (!keyed) throw new ChatKeysRequiredError();
      const content = await queryClient.fetchQuery({
        ...trpc.chats.messages.queryOptions({ chatId: session.id }),
        staleTime: 0,
      });
      const chatKey = await writableChatKey(session.id);
      // History may be sealed natively or sit in sidecars; either way it is opened locally.
      const historical = await openHistoricalChat(
        {
          chatId: session.id,
          workspaceId: session.workspace,
          legacyContent: session.legacyContent,
          wants: { title: false, queue: true },
        },
        content.entries,
      );
      const { messages } = await openMessages(historical.entries, content.capsules, {
        workspaceId: session.workspace,
        e2eeId: chatKey.e2eeId,
        chatId: session.id,
      });
      const firstUser = messages.find((message) => message.role === "user");
      const prompt = firstUser ? getMessageText(firstUser) : historical.queue?.text;
      if (!prompt?.trim()) {
        throw new Error("No user message to generate a title from.");
      }
      return regenerateTitle({ chatId: session.id, prompt: prompt.slice(0, 8000) });
    });
    if (succeeded) toast.success("Session title regenerated.");
  }

  /** Picking a Project only stages the move; `confirmMove` applies it. */
  function requestMove(value: string) {
    if (value === (session.project ?? noProject)) return;
    const target = projects.find((project) => project.id === value) ?? null;
    setMoveTarget({ id: target?.id ?? null, name: target?.name ?? "No project" });
    setIsMoveOpen(true);
  }

  async function confirmMove() {
    if (!moveTarget) return;
    const succeeded = await run("move", () =>
      setChatProject({ chatId: session.id, project: moveTarget.id }),
    );
    if (!succeeded) return;
    if (moveTarget.id) {
      toast.success(`Moved to ${moveTarget.name}.`);
    } else {
      toast.success("Removed from its project.");
    }
    setIsMoveOpen(false);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const succeeded = await run("rename", async () => {
      // A keyless chat gets keys so the new title is sealed; the backend stores only sealed titles.
      const keyed = session.e2ee || (await ensureChatKeys(session.id));
      if (!keyed) throw new ChatKeysRequiredError();
      const chatKey = await writableChatKey(session.id);
      return renameChat({
        chatId: session.id,
        sealedTitle: await sealTitle({ title: trimmed }, chatKey),
      });
    });
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
            <DropdownMenuItem
              disabled={isBusy || Boolean(session.e2ee && keyStatus.state !== "unlocked")}
              onSelect={() => setIsRenameOpen(true)}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            {/* ACP prompts are not stored in Radium, so there is no first message to title from. */}
            {session.agent || !session.canManage ? null : (
              <DropdownMenuItem
                disabled={isBusy || Boolean(session.e2ee && keyStatus.state !== "unlocked")}
                onSelect={() => void regenerate()}
              >
                <SparklesIcon />
                Regenerate title
              </DropdownMenuItem>
            )}
            {session.canManage ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={isBusy}>
                  <FolderInputIcon />
                  Move to project
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={session.project ?? noProject}
                    onValueChange={requestMove}
                  >
                    <DropdownMenuRadioItem value={noProject}>
                      <FolderMinusIcon />
                      No project
                    </DropdownMenuRadioItem>
                    {projects.length > 0 ? <DropdownMenuSeparator /> : null}
                    {projects.map((project) => (
                      <DropdownMenuRadioItem key={project.id} value={project.id}>
                        <ProjectGlyph project={project} />
                        <span className="truncate">{project.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
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

      <AlertDialog
        open={isDeleteOpen}
        onOpenChange={(open) => {
          if (!isBusy) setIsDeleteOpen(open);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{displayTitle}” and its messages. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
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

      <AlertDialog
        open={isMoveOpen}
        onOpenChange={(open) => {
          if (!open && !isBusy) setIsMoveOpen(false);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {moveTarget?.id === null ? "Remove from project?" : "Move session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {moveTarget?.id === null
                ? `Remove “${displayTitle}” from ${currentProject?.name ?? "its project"}? Its next turns run without that project's folders and Worker.`
                : `Move “${displayTitle}” to ${moveTarget?.name}? Its next turns run in that project's context (folders and Worker).`}{" "}
              Existing messages are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isBusy}
              onClick={(event) => {
                // Stay open until the mutation settles so a refusal is visible in context.
                event.preventDefault();
                void confirmMove();
              }}
            >
              {moveTarget?.id === null ? "Remove from project" : "Move"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
