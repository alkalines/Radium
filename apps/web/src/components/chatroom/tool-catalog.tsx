import type { ReactNode } from "react";
import {
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import type { ChatWorkerTool } from "backend/src/worker/chat-config";
import { Row } from "@/components/harness/group-list";
import { cn } from "@/lib/utils";

/**
 * One Worker tool as people pick it. `write` covers the separate `edit` and `create` backend
 * tools: both change files on the host behind an approval, so they are offered as one choice.
 * Tools that change the host (`requiresApproval`) pause the Run for an approval gate first.
 */
export type WorkerToolOption = {
  id: string;
  tools: readonly ChatWorkerTool[];
  label: string;
  description: string;
  icon: LucideIcon;
  requiresApproval: boolean;
};

/** Worker tool choices in display order, shared by the Tools dialog and Settings → Tools. */
export const workerToolOptions: readonly WorkerToolOption[] = [
  {
    id: "read",
    tools: ["read"],
    label: "Read files",
    description: "Read files under the Session directory.",
    icon: FileTextIcon,
    requiresApproval: false,
  },
  {
    id: "write",
    tools: ["edit", "create"],
    label: "Write files",
    description: "Create new files and change existing ones.",
    icon: FilePenIcon,
    requiresApproval: true,
  },
  {
    id: "bash",
    tools: ["bash"],
    label: "Bash commands",
    description: "Run shell commands in the Session directory.",
    icon: TerminalIcon,
    requiresApproval: true,
  },
];

const workerToolOrder: readonly ChatWorkerTool[] = workerToolOptions.flatMap(
  (option) => option.tools,
);

/** On when any of its backend tools is stored, so a legacy edit-only selection still shows. */
export function isWorkerToolOptionEnabled(
  option: WorkerToolOption,
  tools: readonly ChatWorkerTool[],
) {
  return option.tools.some((tool) => tools.includes(tool));
}

/**
 * `tools` with one choice switched on or off, in display order so the stored list never depends
 * on click order.
 */
export function withWorkerToolOption(
  tools: readonly ChatWorkerTool[],
  option: WorkerToolOption,
  enabled: boolean,
): ChatWorkerTool[] {
  return workerToolOrder.filter((tool) =>
    option.tools.includes(tool) ? enabled : tools.includes(tool),
  );
}

/**
 * Tools for a newly picked Worker: the workspace's Worker tool defaults plus the tools the Session
 * already chose (with or without a Worker), in display order.
 */
export function workerToolsFor(
  defaults: readonly ChatWorkerTool[],
  chosen: readonly ChatWorkerTool[],
): ChatWorkerTool[] {
  return workerToolOrder.filter((tool) => defaults.includes(tool) || chosen.includes(tool));
}

// Built-in tool sets without an entry here use the wrench.
const builtinToolIcons: Record<string, LucideIcon> = {
  web_search: GlobeIcon,
  code_interpreter: SquareTerminalIcon,
  image_generation: ImageIcon,
};

export function builtinToolIcon(toolSetId: string): LucideIcon {
  return builtinToolIcons[toolSetId] ?? WrenchIcon;
}

/**
 * One tool: its icon, raw id as Machine text with Tags, the description, and its control.
 * `isDimmed` greys out tools that cannot be turned on yet (`Soon`).
 */
export function ToolRow({
  icon,
  toolId,
  description,
  tags,
  isDimmed = false,
  children,
}: {
  icon: LucideIcon;
  toolId: string;
  description: string;
  tags?: ReactNode;
  isDimmed?: boolean;
  children: ReactNode;
}) {
  return (
    <Row
      icon={icon}
      aria-disabled={isDimmed || undefined}
      className={cn(isDimmed && "opacity-50")}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px] font-normal">{toolId}</span>
          {tags}
        </span>
      }
      description={description}
    >
      {children}
    </Row>
  );
}
