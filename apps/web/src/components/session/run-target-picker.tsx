import { type ReactNode, useId, useState } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { validChatWorkerDirectory, type ChatWorkerSelection } from "backend/src/worker/chat-config";
import { ProviderLogo } from "@/components/gateway/provider-logo";
import { Tag } from "@/components/harness/group-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { SessionAgent, SessionWorker } from "./agents";

type WorkerTool = ChatWorkerSelection["tools"][number];

const workerTools: { id: WorkerTool; label: string }[] = [
  { id: "read", label: "Read files" },
  { id: "edit", label: "Edit files" },
  { id: "create", label: "Create files" },
  { id: "bash", label: "Bash commands" },
];

const noWorkerValue = "__no-worker__";

type View = "summary" | "worker" | "directory" | "tools" | "agent";

/** Agent artwork inside the picker: ACP agents use their provider logo, Radium its letter. */
export function AgentLogo({ agent, className }: { agent: SessionAgent; className?: string }) {
  if (agent.logo) return <ProviderLogo slug={agent.logo} className={className} />;
  return <img src="/letters/R.svg" alt="" className={cn("shrink-0", className)} />;
}

/**
 * Picks where a Session runs: Project (planned), Worker, its Directory and Tools, and the Agent.
 * A summary of rows drills into one view per part; picking returns to the summary, Backspace in an
 * empty search or path steps back, and closing resets to the summary. View switches are instant.
 *
 * Worker metadata has no connection state or OS user, so Workers are listed as active (selectable)
 * or revoked (disabled) only. Every change reports a complete `ChatWorkerSelection` (or `null` for
 * no Worker) through `onSelectionChange`; the caller decides whether it is local draft state or a
 * persisted chat setting. The backend requires an absolute Directory before Worker tools can run.
 */
export function RunTargetPicker({
  trigger,
  triggerLabel,
  workers,
  selection,
  agent,
  agents,
  disabled,
  onSelectionChange,
  onAgentChange,
}: {
  trigger: ReactNode;
  /** Accessible name of the trigger, e.g. `Run on build-box with Radium`. */
  triggerLabel: string;
  workers: SessionWorker[];
  selection: ChatWorkerSelection | null;
  agent: SessionAgent;
  agents: SessionAgent[];
  disabled?: boolean;
  onSelectionChange: (selection: ChatWorkerSelection | null) => void;
  onAgentChange: (agent: SessionAgent) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>("summary");

  const activeWorkers = workers.filter((candidate) => candidate.status === "active");
  const revokedWorkers = workers.filter((candidate) => candidate.status !== "active");
  const selectedWorker = activeWorkers.find(
    (candidate) => candidate.workerId === selection?.workerId,
  );

  function handleOpenChange(open: boolean) {
    setIsOpen(open);
    if (!open) setView("summary");
  }

  function pick(apply: () => void) {
    apply();
    setView("summary");
  }

  function selectWorker(workerId: string | null) {
    if (workerId === null) {
      onSelectionChange(null);
      return;
    }
    if (workerId === selection?.workerId) return;
    // A different machine gets no tools until the owner grants them again.
    onSelectionChange({ workerId, directory: selection?.directory, tools: [] });
  }

  function toggleTool(tool: WorkerTool, enabled: boolean) {
    if (!selection) return;
    const otherTools = selection.tools.filter((id) => id !== tool);
    onSelectionChange({ ...selection, tools: enabled ? [...otherTools, tool] : otherTools });
  }

  let workerValue: ReactNode = <span className="text-muted-foreground">No Worker</span>;
  if (selectedWorker) {
    workerValue = <span className="truncate">{selectedWorker.name}</span>;
  } else if (selection) {
    workerValue = <span className="text-muted-foreground">Worker unavailable</span>;
  }

  const selectedToolLabels = workerTools
    .filter((tool) => selection?.tools.includes(tool.id))
    .map((tool) => tool.label.split(" ")[0]);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="min-w-0 text-muted-foreground"
          aria-label={triggerLabel}
        >
          {trigger}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      {/*
        Opens upward: the row sits under the Composer and near the bottom once docked, and a fixed
        side keeps the popover from flipping when a drill-down view is taller than the summary.
      */}
      <PopoverContent
        side="top"
        align="center"
        className="w-80 gap-0 overflow-hidden rounded-2xl p-0"
      >
        {view === "summary" ? (
          <div className="flex flex-col p-1">
            <SummaryRow label="Project" disabled>
              <span className="truncate text-muted-foreground">No Project</span>
              <Tag>Planned</Tag>
            </SummaryRow>
            <SummaryRow label="Worker" onOpen={() => setView("worker")}>
              {workerValue}
            </SummaryRow>
            <SummaryRow
              label="Directory"
              disabled={!selectedWorker}
              onOpen={() => setView("directory")}
            >
              {selection?.directory ? (
                <span className="truncate font-mono text-xs" title={selection.directory}>
                  {selection.directory}
                </span>
              ) : (
                <>
                  <span className="text-muted-foreground">Not set</span>
                  {selectedWorker ? <Tag>Required</Tag> : null}
                </>
              )}
            </SummaryRow>
            <SummaryRow label="Tools" disabled={!selectedWorker} onOpen={() => setView("tools")}>
              <span
                className={cn(
                  "truncate",
                  selectedToolLabels.length === 0 && "text-muted-foreground",
                )}
              >
                {selectedToolLabels.length > 0 ? selectedToolLabels.join(", ") : "None"}
              </span>
            </SummaryRow>
            <SummaryRow label="Agent" onOpen={() => setView("agent")}>
              <AgentLogo agent={agent} className="size-4" />
              <span className="truncate">{agent.name}</span>
            </SummaryRow>
          </div>
        ) : null}

        {view === "worker" ? (
          <DrillList
            title="Workers"
            placeholder="Search workers…"
            onBack={() => setView("summary")}
          >
            <CommandGroup>
              <CommandItem
                value={noWorkerValue}
                keywords={["No Worker", "none"]}
                data-checked={selection === null}
                onSelect={() => pick(() => selectWorker(null))}
              >
                <span className="truncate">No Worker</span>
              </CommandItem>
            </CommandGroup>
            {activeWorkers.length > 0 ? (
              <CommandGroup heading="Active">
                {activeWorkers.map((candidate) => (
                  <CommandItem
                    key={candidate.workerId}
                    value={candidate.workerId}
                    keywords={[candidate.name]}
                    data-checked={candidate.workerId === selection?.workerId}
                    onSelect={() => pick(() => selectWorker(candidate.workerId))}
                  >
                    <span className="truncate">{candidate.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {revokedWorkers.length > 0 ? (
              <CommandGroup heading="Revoked">
                {revokedWorkers.map((candidate) => (
                  <CommandItem
                    key={candidate.workerId}
                    value={candidate.workerId}
                    keywords={[candidate.name]}
                    disabled
                  >
                    <span className="truncate">{candidate.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {activeWorkers.length === 0 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground">
                No active Workers in this workspace. Enroll one in Settings → Workers.
              </p>
            ) : null}
          </DrillList>
        ) : null}

        {view === "directory" && selection && selectedWorker ? (
          <DirectoryView
            workerName={selectedWorker.name}
            directory={selection.directory}
            onBack={() => setView("summary")}
            onSave={(directory) => pick(() => onSelectionChange({ ...selection, directory }))}
          />
        ) : null}

        {view === "tools" && selection && selectedWorker ? (
          <div className="flex flex-col">
            <DrillHeader
              title={`Tools on ${selectedWorker.name}`}
              onBack={() => setView("summary")}
            />
            <div className="flex flex-col p-1">
              {workerTools.map((tool) => (
                <label
                  key={tool.id}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
                >
                  <Checkbox
                    checked={selection.tools.includes(tool.id)}
                    onCheckedChange={(checked) => toggleTool(tool.id, checked === true)}
                  />
                  {tool.label}
                </label>
              ))}
            </div>
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              Edit, Create and Bash require approval.
            </p>
          </div>
        ) : null}

        {view === "agent" ? (
          <DrillList
            title={selectedWorker ? `Agents on ${selectedWorker.name}` : "Agents"}
            placeholder="Search agents…"
            onBack={() => setView("summary")}
          >
            <CommandGroup>
              {agents.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  keywords={[candidate.name]}
                  data-checked={candidate.id === agent.id}
                  onSelect={() => pick(() => onAgentChange(candidate))}
                >
                  <AgentLogo agent={candidate} className="size-4" />
                  <span className="flex-1 truncate">{candidate.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {candidate.protocol === "acp" ? "ACP" : "Built-in"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <p className="px-3 pb-3 text-xs text-muted-foreground">ACP agents are planned.</p>
          </DrillList>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** One summary row; rows without `onOpen` (or `disabled`) render as inert labels. */
function SummaryRow({
  label,
  disabled,
  onOpen,
  children,
}: {
  label: string;
  disabled?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || !onOpen}
      onClick={onOpen}
      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="w-18 shrink-0 text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {disabled || !onOpen ? null : (
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function DrillHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex h-9 items-center gap-1 px-1 pt-1">
      <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}>
        <ChevronLeftIcon />
      </Button>
      <span className="truncate text-sm font-medium">{title}</span>
    </div>
  );
}

/** One part's list: back to the summary, search, then a bounded scrolling list. */
function DrillList({
  title,
  placeholder,
  onBack,
  children,
}: {
  title: string;
  placeholder: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");

  return (
    <Command className="rounded-none bg-transparent">
      <DrillHeader title={title} onBack={onBack} />
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={placeholder}
        // An empty search plus Backspace steps back, so the keyboard can walk the whole picker.
        onKeyDown={(event) => {
          if (event.key === "Backspace" && query === "") onBack();
        }}
      />
      <CommandList className="max-h-64">
        <CommandEmpty>No matches.</CommandEmpty>
        {children}
      </CommandList>
    </Command>
  );
}

/** Absolute execution root on the Worker; empty clears it, invalid paths are not saved. */
function DirectoryView({
  workerName,
  directory,
  onBack,
  onSave,
}: {
  workerName: string;
  directory: string | undefined;
  onBack: () => void;
  onSave: (directory: string | undefined) => void;
}) {
  const inputId = useId();
  const [value, setValue] = useState(directory ?? "");
  const [isInvalid, setIsInvalid] = useState(false);

  function save() {
    const trimmed = value.trim();
    if (trimmed && !validChatWorkerDirectory(trimmed)) {
      setIsInvalid(true);
      return;
    }
    onSave(trimmed || undefined);
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <DrillHeader title={`Directory on ${workerName}`} onBack={onBack} />
      <div className="flex flex-col gap-1.5 p-3 pt-2">
        <label htmlFor={inputId} className="sr-only">
          Absolute path on {workerName}
        </label>
        <Input
          id={inputId}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="/absolute/project/path"
          aria-invalid={isInvalid}
          className="h-8 rounded-xl font-mono text-[13px]"
          onChange={(event) => {
            setValue(event.target.value);
            setIsInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && value === "") onBack();
          }}
        />
        <p className={cn("text-xs", isInvalid ? "text-destructive" : "text-muted-foreground")}>
          {isInvalid
            ? "Use an absolute path on the Worker."
            : "Required to run Worker tools. Absolute path on this Worker."}
        </p>
        <Button type="submit" size="sm" className="self-end">
          Save
        </Button>
      </div>
    </form>
  );
}
