import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FileUIPart } from "ai";
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

/** What the Composer submits: trimmed text plus attachments as AI SDK file parts with data URLs. */
export type ComposerMessage = { text: string; files: FileUIPart[] };

/** A picked file held as a blob URL until submit converts it. */
type PendingAttachment = { id: string; file: File; url: string };

/**
 * The Session prompt input (`docs/Interface_Design.md` §2, Composer): textarea plus a toolbar with
 * the `+` menu leading and the Model control, context usage, voice input, and send/stop trailing.
 * Enter sends, Shift+Enter adds a line. Files come from the `+` menu, paste, or a drop onto the
 * Composer; Backspace in an empty textarea removes the last one.
 *
 * Submitting clears the input immediately. When `onSubmit` throws or rejects, the text and files
 * are restored so the user can retry; it is called at most once per submit.
 *
 * `layoutId` is shared by the empty and docked positions so the Composer moves (Reflow) instead of
 * remounting, which keeps the draft text and the model choice.
 */
export function Composer({
  layoutId,
  autoFocus,
  canSend,
  isRunning,
  onSubmit,
  onStop,
  modelControl,
  contextUsage,
  menuItems,
}: {
  layoutId: string;
  autoFocus: boolean;
  /** False while a model is not chosen yet or a turn cannot start; typing stays enabled. */
  canSend: boolean;
  /** A turn is in flight: the send button becomes Stop. */
  isRunning: boolean;
  onSubmit: (message: ComposerMessage) => void | Promise<void>;
  onStop: () => void;
  modelControl: ReactNode;
  contextUsage?: ReactNode;
  /** Extra `+` menu entries (submenus) after "Add photos & files". */
  menuItems?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { attachments, addFiles, removeAttachment, takeAttachments, restoreAttachments } =
    useFileAttachments();
  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const isSendEnabled = canSend && hasContent && !isRunning;

  async function submit() {
    if (!isSendEnabled) return;

    const text = value.trim();
    const submitted = takeAttachments();
    setValue("");

    try {
      const files = await Promise.all(submitted.map(toFileUIPart));
      await onSubmit({ text, files });
      for (const attachment of submitted) URL.revokeObjectURL(attachment.url);
    } catch {
      // Keep the prompt for a retry; anything typed meanwhile wins over the restored text.
      setValue((current) => current || text);
      restoreAttachments(submitted);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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
      addFiles(files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  return (
    <m.div layout layoutId={layoutId} transition={transitions.layout} className="w-full">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Add photos and files"
          onChange={(event) => {
            if (event.currentTarget.files) addFiles(event.currentTarget.files);
            // Reset so picking a file that was just removed fires `change` again.
            event.currentTarget.value = "";
          }}
        />
        <InputGroup
          className={cn("rounded-2xl border-border bg-card", isDragging && "border-ring")}
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
            value={value}
            autoFocus={autoFocus}
            aria-label="Message"
            placeholder="Ask anything, / for commands, @ for context…"
            className="max-h-48 min-h-14 px-4 pt-3.5"
            onChange={(event) => setValue(event.target.value)}
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
                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                  <PaperclipIcon />
                  Add photos & files
                </DropdownMenuItem>
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="ml-auto flex min-w-0 items-center gap-1">
              {modelControl}
              {/* Usage is secondary; at phone width the Model control and send keep the room. */}
              {contextUsage ? <div className="shrink-0 max-sm:hidden">{contextUsage}</div> : null}
            </div>

            <VoiceInputButton
              onTranscript={(transcript) =>
                setValue((current) => (current ? `${current} ${transcript}` : transcript))
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

  return { attachments, addFiles, removeAttachment, takeAttachments, restoreAttachments };
}

/** AI SDK file part with the file inlined as a data URL; keeps the blob URL if reading fails. */
function toFileUIPart(attachment: PendingAttachment): Promise<FileUIPart> {
  const { promise, resolve } = Promise.withResolvers<FileUIPart>();
  const part = {
    type: "file" as const,
    mediaType: attachment.file.type,
    filename: attachment.file.name,
  };
  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : null;
    resolve({ ...part, url: dataUrl ?? attachment.url });
  };
  reader.onerror = () => resolve({ ...part, url: attachment.url });
  reader.readAsDataURL(attachment.file);
  return promise;
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
