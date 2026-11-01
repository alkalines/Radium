import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { FileUIPart } from "ai";
import { useMutation } from "convex/react";
import * as m from "motion/react-m";
import {
  ArrowUpIcon,
  FileTextIcon,
  LockKeyholeIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { transitions } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { VoiceInputButton } from "./voice-input-button";

/** What the Composer submits: trimmed text plus AI SDK file parts backed by Convex File Storage. */
export type ComposerMessage = { text: string; files: FileUIPart[] };

/** A picked file held as a local blob URL for preview until submit uploads it. */
type PendingAttachment = { id: string; file: File; url: string };

/**
 * Where the Composer keeps its text beyond the component (the per-Tab snapshot). `read` runs once
 * after mount, so server and client render the same empty textarea; `write` runs on every text
 * change, including the clear on submit and the restore after a failed submit.
 */
export type ComposerTextStore = { read: () => string; write: (text: string) => void };

/** Text plus attached files: what the Composer holds before a submit. */
export type ComposerDraft = { text: string; files: File[] };

/** Imperative access for flows that put a draft back into the Composer, such as a revert. */
export type ComposerHandle = {
  /** Replaces the Composer's text and files, focuses it, and returns what it held before. */
  swapDraft: (next: ComposerDraft) => ComposerDraft;
};

/**
 * The Session prompt input (`docs/Interface_Design.md` §2, Composer): textarea plus a toolbar with
 * the `+` menu and `toolbarControls` (Tools) leading and the Model control, voice input, and
 * send/stop trailing. Enter sends, Shift+Enter adds a line. Files come from the `+` menu, paste,
 * or a drop onto the Composer; Backspace in an empty textarea removes the last one.
 *
 * Submitting clears the input immediately and uploads files to `workspace` before calling
 * `onSubmit` once. Upload or submit failures show an error and restore the text and files so the
 * user can retry; no local preview URL is sent. `ref` exposes `swapDraft` for reverting a turn.
 *
 * `layoutId` is shared by the empty and docked positions so the Composer moves (Reflow) instead of
 * remounting, which keeps the draft text and the model choice.
 */
export function Composer({
  ref,
  layoutId,
  workspace,
  autoFocus,
  canSend,
  isRunning,
  onSubmit,
  onStop,
  modelControl,
  menuItems,
  toolbarControls,
  textStore,
  commands,
  attachmentsDisabledReason,
}: {
  ref?: Ref<ComposerHandle>;
  layoutId: string;
  /** The saved chat's workspace, or the draft's settings workspace; required to upload files. */
  workspace?: Id<"workspaces">;
  autoFocus: boolean;
  /** False while a model is not chosen yet or a turn cannot start; typing stays enabled. */
  canSend: boolean;
  /** A turn is in flight: the send button becomes Stop. */
  isRunning: boolean;
  onSubmit: (message: ComposerMessage) => void | Promise<void>;
  onStop: () => void;
  modelControl: ReactNode;
  /** Extra `+` menu entries (submenus) after "Add photos & files". */
  menuItems?: ReactNode;
  /** Toolbar buttons right after the `+` menu, such as the Tools control. */
  toolbarControls?: ReactNode;
  textStore?: ComposerTextStore;
  /** Agent-advertised slash commands; selecting one inserts ordinary prompt text. */
  commands?: { name: string; description: string; hint?: string }[];
  /** Disable all attachment entry points when the agent cannot receive files. */
  attachmentsDisabledReason?: string;
}) {
  const [value, setValue] = useState("");
  // Async submit and voice callbacks need the latest text, not the text of their render.
  const valueRef = useRef(value);
  const [isComposing, setIsComposing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const uploadAttachment = useAttachmentUpload(workspace);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandsId = useId();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const commandQuery = /^\/([^\s]*)$/.exec(value)?.[1];
  const matchingCommands =
    commandQuery === undefined
      ? []
      : (commands ?? []).filter((command) =>
          `${command.name} ${command.description}`
            .toLowerCase()
            .includes(commandQuery.toLowerCase()),
        );
  const commandsOpen = !commandsDismissed && matchingCommands.length > 0;
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1));
  const {
    attachments,
    addFiles,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    replaceFiles,
  } = useFileAttachments();
  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const isSendEnabled =
    canSend &&
    hasContent &&
    !isRunning &&
    !isSubmitting &&
    !(attachmentsDisabledReason && attachments.length);

  // The text lives in Composer state so typing re-renders only the Composer; the store is written
  // directly instead of lifting the text into the Session screen.
  function updateValue(next: string) {
    valueRef.current = next;
    setValue(next);
    textStore?.write(next);
    setCommandsDismissed(false);
    setCommandIndex(0);
  }

  // Restore after mount (not in the initial state) so server and client markup match.
  const readStoredText = useRef(textStore?.read);
  useEffect(() => {
    const stored = readStoredText.current?.();
    if (!stored) return;
    valueRef.current = stored;
    setValue(stored);
  }, []);

  useImperativeHandle(ref, () => ({
    swapDraft(next) {
      const previous = { text: valueRef.current, files: replaceFiles(next.files) };
      updateValue(next.text);
      textareaRef.current?.focus();
      return previous;
    },
  }));

  async function submit() {
    if (attachmentsDisabledReason && attachments.length) {
      toast.info(attachmentsDisabledReason);
      return;
    }
    if (!isSendEnabled) return;

    const text = value.trim();
    const submitted = takeAttachments();
    setIsSubmitting(true);
    updateValue("");

    try {
      const files = await Promise.all(submitted.map(uploadAttachment));
      await onSubmit({ text, files });
      for (const attachment of submitted) URL.revokeObjectURL(attachment.url);
    } catch (error) {
      // Keep the prompt for a retry; anything typed meanwhile wins over the restored text.
      updateValue(valueRef.current || text);
      restoreAttachments(submitted);
      toast.error(error instanceof Error ? error.message : "Unable to send message.");
    } finally {
      setIsSubmitting(false);
    }
  }
  function selectCommand(name: string) {
    updateValue(`/${name} `);
    textareaRef.current?.focus();
  }

  function attachFiles(files: File[] | FileList) {
    if (attachmentsDisabledReason) {
      toast.info(attachmentsDisabledReason);
      return;
    }
    addFiles(files);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commandsOpen && !isComposing && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex(
          (activeCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + matchingCommands.length) %
            matchingCommands.length,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandsDismissed(true);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        const command = matchingCommands[activeCommandIndex];
        if (command) {
          event.preventDefault();
          selectCommand(command.name);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      // Enter confirms an IME candidate while composing; it must not send.
      if (isComposing || event.nativeEvent.isComposing) return;
      event.preventDefault();
      void submit();
      return;
    }

    if (event.key === "Backspace" && event.currentTarget.value === "") {
      const lastAttachment = attachments.at(-1);
      if (lastAttachment) {
        event.preventDefault();
        removeAttachment(lastAttachment.id);
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files: File[] = [];
    for (const item of event.clipboardData?.items ?? []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0) {
      event.preventDefault();
      attachFiles(files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (!attachmentsDisabledReason) setIsDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length > 0) attachFiles(event.dataTransfer.files);
  }

  return (
    <m.div layout layoutId={layoutId} transition={transitions.layout} className="relative w-full">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {commandsOpen ? (
          <div
            id={commandsId}
            role="listbox"
            aria-label="Agent commands"
            className="absolute inset-x-0 bottom-full mb-2 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {matchingCommands.map((command, index) => (
              <button
                key={command.name}
                id={`${commandsId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeCommandIndex}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left text-sm",
                  index === activeCommandIndex && "bg-accent text-accent-foreground",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => selectCommand(command.name)}
                ref={(element) => {
                  if (index === activeCommandIndex) element?.scrollIntoView({ block: "nearest" });
                }}
              >
                <span className="font-mono">
                  /{command.name}
                  {command.hint ? (
                    <span className="ml-2 text-xs text-muted-foreground">{command.hint}</span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Add photos and files"
          disabled={Boolean(attachmentsDisabledReason)}
          onChange={(event) => {
            if (event.currentTarget.files) attachFiles(event.currentTarget.files);
            // Reset so picking a file that was just removed fires `change` again.
            event.currentTarget.value = "";
          }}
        />
        <InputGroup
          className={cn(
            // Squared under an attached todo tray (`TodoPanel`), so the two read as one input.
            "rounded-2xl border-border bg-card group-data-[tray=attached]/prompt-slot:rounded-t-none",
            isDragging && "border-ring",
          )}
          onDragOver={handleDragOver}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {attachments.length > 0 ? (
            <InputGroupAddon align="block-start" className="flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => removeAttachment(attachment.id)}
                />
              ))}
            </InputGroupAddon>
          ) : null}
          <InputGroupTextarea
            ref={textareaRef}
            value={value}
            autoFocus={autoFocus}
            aria-label="Message"
            aria-autocomplete={commands ? "list" : undefined}
            aria-expanded={commands ? commandsOpen : undefined}
            aria-controls={commandsOpen ? commandsId : undefined}
            aria-activedescendant={commandsOpen ? `${commandsId}-${activeCommandIndex}` : undefined}
            placeholder="Ask anything, / for commands, @ for context…"
            className="max-h-48 min-h-14 px-4 pt-3.5"
            onChange={(event) => updateValue(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
          />
          <InputGroupAddon align="block-end" className="gap-1 px-2 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <InputGroupButton size="icon-sm" aria-label="Add context">
                  <PlusIcon />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuItem
                  disabled={Boolean(attachmentsDisabledReason)}
                  onSelect={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                  <span className="flex flex-col">
                    Add photos & files
                    {attachmentsDisabledReason ? (
                      <span className="text-xs text-muted-foreground">
                        {attachmentsDisabledReason}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
            {toolbarControls}

            <div className="ml-auto flex min-w-0 items-center gap-1">{modelControl}</div>

            <VoiceInputButton
              onTranscript={(transcript) =>
                updateValue(valueRef.current ? `${valueRef.current} ${transcript}` : transcript)
              }
            />

            {isRunning ? (
              <InputGroupButton
                variant="secondary"
                size="icon-sm"
                aria-label="Stop"
                onClick={onStop}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                aria-label="Send"
                disabled={!isSendEnabled}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </m.div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const isImage = attachment.file.type.startsWith("image/");

  return (
    <Attachment size="sm" className="min-w-0">
      <AttachmentMedia variant={isImage ? "image" : "icon"}>
        {isImage ? <img src={attachment.url} alt="" /> : <FileTextIcon />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle className="max-w-40" title={attachment.file.name}>
          {attachment.file.name}
        </AttachmentTitle>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label={`Remove ${attachment.file.name}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

/**
 * Pending Composer files as blob URLs. Removing a file revokes its URL; `takeAttachments` hands the
 * list to a submit without revoking (the submit revokes after success or restores on failure).
 */
function useFileAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Blob URLs outlive the component unless revoked.
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
    },
    [],
  );

  function addFiles(files: FileList | File[]) {
    const added = Array.from(files, (file) => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
    }));
    setAttachments((current) => [...current, ...added]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  function takeAttachments() {
    const taken = attachmentsRef.current;
    setAttachments([]);
    return taken;
  }

  function restoreAttachments(restored: PendingAttachment[]) {
    setAttachments((current) => [...restored, ...current]);
  }

  /** Swaps every pending file for `files` and returns the files it removed. */
  function replaceFiles(files: File[]) {
    const removed = attachmentsRef.current;
    for (const attachment of removed) URL.revokeObjectURL(attachment.url);
    setAttachments(
      files.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })),
    );
    return removed.map((attachment) => attachment.file);
  }

  return {
    attachments,
    addFiles,
    removeAttachment,
    takeAttachments,
    restoreAttachments,
    replaceFiles,
  };
}

/** Matches the server's attachment limit; oversized files must never start an upload. */
export const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Uploads a local preview to the chosen workspace and returns only registered storage file parts.
 * Rejected registration means the backend already removed the file; reject the submit, never fall
 * back to a local URL. The Composer retains the original files for a retry.
 */
function useAttachmentUpload(workspace: Id<"workspaces"> | undefined) {
  const generateUploadUrl = useMutation(api.chat_files.generateUploadUrl);
  const registerFile = useMutation(api.chat_files.register);

  return async ({ file }: PendingAttachment): Promise<FileUIPart> => {
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) throw new Error("File is too large.");
    if (!workspace) throw new Error("Choose a workspace before uploading files.");
    const uploadUrl = await generateUploadUrl({ workspace });
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) throw new Error(`Unable to upload ${file.name} (${response.status}).`);
    const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
    const part = await registerFile({ workspace, storageId, filename: file.name });
    if (!part) throw new Error("File could not be attached.");
    return part;
  };
}

export type ChatScope = "personal" | "workspace";

/**
 * `+` menu submenu for who can access the conversation. Drafts edit the scope the chat will be
 * created with; existing chats change it through the caller (only the creator may, so
 * `canChange` is false for everyone else).
 */
export function ConversationVisibilityMenu({
  scope,
  isDraft,
  canChange,
  onChange,
}: {
  scope: ChatScope;
  isDraft: boolean;
  canChange: boolean;
  onChange: (scope: ChatScope) => void;
}) {
  const isPersonal = scope === "personal";

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {isPersonal ? <LockKeyholeIcon /> : <UsersIcon />}
          Conversation visibility
          <span className="ml-auto text-xs text-muted-foreground">
            {isPersonal ? "Personal" : "Workspace"}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-72">
          <DropdownMenuLabel>
            {isDraft ? "New chat visibility" : "Conversation visibility"}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(value) => {
              if (value === "personal" || value === "workspace") onChange(value);
            }}
          >
            <DropdownMenuRadioItem value="personal" disabled={!canChange}>
              <span className="flex flex-col gap-0.5">
                <span>Personal</span>
                <span className="text-xs text-muted-foreground">
                  Private to the person who creates it.
                </span>
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="workspace" disabled={!canChange}>
              <span className="flex flex-col gap-0.5">
                <span>Workspace</span>
                <span className="text-xs text-muted-foreground">
                  Visible to members of this workspace.
                </span>
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-normal whitespace-normal text-muted-foreground">
            {canChange
              ? "Personal chat encryption and audit controls are planned. This setting only controls who can access the conversation."
              : "Only the creator can change visibility."}
          </DropdownMenuLabel>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
