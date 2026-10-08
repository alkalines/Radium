import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { MonitorIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Id } from "backend/convex/_generated/dataModel";
import { api } from "backend/convex/_generated/api";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";

import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type { ChatWorkerSelection } from "backend/src/worker/chat-config";

const workerTools = [
  { id: "read", label: "Read files" },
  { id: "edit", label: "Edit files" },
  { id: "create", label: "Create files" },
] as const;

/** Owner-only configuration for the composer's workspace, including existing chats. */
export function ChatWorkerSelector({
  workspace,
  selection,
  onChange,
  disabled,
}: {
  workspace: Id<"workspaces"> | undefined;
  selection: ChatWorkerSelection | null | undefined;
  onChange: (selection: ChatWorkerSelection | null) => void;
  disabled?: boolean;
}) {
  const { workspaces } = useWorkspace();
  const directoryId = useId();
  const [directory, setDirectory] = useState(selection?.directory ?? "");
  useEffect(
    () => setDirectory(selection?.directory ?? ""),
    [selection?.directory, selection?.workerId],
  );
  const isOwner = workspaces.some((item) => item._id === workspace && item.role === "owner");
  const { data: workers, error } = useQuery(
    convexQuery(api.workers.list, workspace && isOwner ? { workspace } : "skip"),
  );
  if (!isOwner) return null;

  const activeWorkers = workers?.filter((worker) => worker.status === "active") ?? [];
  const selected = activeWorkers.find((worker) => worker.workerId === selection?.workerId);
  const loading = workers === undefined && !error;

  function saveDirectory() {
    if (!selected || !selection || disabled || directory.trim() === (selection.directory ?? ""))
      return;
    onChange({ ...selection, directory: directory.trim() || undefined });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          aria-label="Select Worker and file tools"
          disabled={disabled || loading || Boolean(error)}
          size="xs"
          className="max-w-28 gap-1.5 sm:max-w-40"
        >
          <MonitorIcon data-icon="inline-start" />
          <span className="truncate">
            {error
              ? "Workers unavailable"
              : loading
                ? "Workers…"
                : (selected?.name ?? (selection ? "Worker unavailable" : "No Worker"))}
          </span>
          <ChevronDownIcon data-icon="inline-end" />
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Worker</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={selection?.workerId ?? ""}
            onValueChange={(workerId) =>
              onChange(workerId ? { workerId, directory: selection?.directory, tools: [] } : null)
            }
          >
            <DropdownMenuRadioItem value="" disabled={disabled}>
              No Worker
            </DropdownMenuRadioItem>
            {activeWorkers.map((worker) => (
              <DropdownMenuRadioItem
                key={worker.workerId}
                value={worker.workerId}
                disabled={disabled}
              >
                <span className="truncate">{worker.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {activeWorkers.length === 0 ? (
            <DropdownMenuItem disabled>No active Workers</DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <FieldGroup className="p-2">
          <Field data-disabled={!selected || disabled}>
            <FieldLabel htmlFor={directoryId}>Worker directory</FieldLabel>
            <Input
              id={directoryId}
              value={directory}
              placeholder="/absolute/project/path"
              disabled={!selected || disabled}
              autoComplete="off"
              onChange={(event) => setDirectory(event.target.value)}
              onBlur={saveDirectory}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveDirectory();
                }
              }}
            />
            <FieldDescription>Required. Absolute path on this Worker.</FieldDescription>
          </Field>
        </FieldGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>File tools</DropdownMenuLabel>
          {workerTools.map((tool) => (
            <DropdownMenuCheckboxItem
              key={tool.id}
              checked={Boolean(selected && selection?.tools.includes(tool.id))}
              disabled={!selected || disabled}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                if (!selected || !selection) return;
                onChange({
                  ...selection,
                  directory: directory.trim() || undefined,
                  tools: checked
                    ? [...selection.tools.filter((id) => id !== tool.id), tool.id]
                    : selection.tools.filter((id) => id !== tool.id),
                });
              }}
            >
              {tool.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="whitespace-normal font-normal text-muted-foreground">
          Edit and Create require approval. The Worker must be connected.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
