import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { ServerIcon, SettingsIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";

import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { BUILTIN_TOOL_SETS, type ToolSelection } from "backend/src/chatroom/tools";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import {
  ToolRow,
  builtinToolIcon,
  isWorkerToolOptionEnabled,
  withWorkerToolOption,
  workerToolOptions,
  type WorkerToolOption,
} from "@/components/chatroom/tool-catalog";
import { GroupList, Row, RowBlock, Tag } from "@/components/harness/group-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InputGroupButton } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The Composer's Tools control: a toolbar wrench button that opens a Dialog. Built-in and Worker
 * tools share one flat list (icon, raw tool id as Machine text, description, Switch); MCP servers
 * follow as their own group.
 *
 * - Saved chat (`chatId`): built-in/MCP toggles write the chat's own override through
 *   `api.chatroom.setChatTools` (reading `getChatTools`, which falls back to the workspace
 *   defaults until the first change).
 * - Draft: toggles only call `onDraftToolsChange`; `draftTools` is `null` until the user changes
 *   something and the Dialog then shows the workspace defaults. Drafts never write defaults.
 *
 * Worker tools always go through `onWorkerSelectionChange` with the updated selection, so the
 * caller decides between draft state and `SetChatWorker`. They stay toggleable without a Worker:
 * the selection then has no `workerId` (and is `null` once no tool is left), and each Worker tool
 * shows an `Unavailable` Tag because nothing runs it until a Worker is picked. Callers only render
 * this for owners who may manage the chat.
 */
type ToolsDialogProps = {
  workspace: Id<"workspaces"> | undefined;
  chatId?: Id<"aisdk_chats">;
  draftTools: ToolSelection | null;
  onDraftToolsChange: (selection: ToolSelection) => void;
  workerSelection: ChatWorkerSelection | null;
  isWorkerLocked: boolean;
  onWorkerSelectionChange: (selection: ChatWorkerSelection | null) => void;
};

/** A disabled trigger does not mount the owner-only tool subscriptions or configuration dialog. */
export function ToolsDialog(props: ToolsDialogProps | { disabledReason: string }) {
  if ("disabledReason" in props) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex" aria-label={`Tools: ${props.disabledReason}`}>
            <InputGroupButton
              size="icon-sm"
              aria-label="Tools"
              title={props.disabledReason}
              disabled
            >
              <WrenchIcon />
            </InputGroupButton>
          </span>
        </TooltipTrigger>
        <TooltipContent>{props.disabledReason}</TooltipContent>
      </Tooltip>
    );
  }
  return <EnabledToolsDialog {...props} />;
}

function EnabledToolsDialog({
  workspace,
  chatId,
  draftTools,
  onDraftToolsChange,
  workerSelection,
  isWorkerLocked,
  onWorkerSelectionChange,
}: ToolsDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { data: servers } = useQuery(
    convexQuery(api.aisdk_tools.listMcpServers, workspace ? { workspace } : "skip"),
  );
  const { data: chatTools } = useQuery(
    convexQuery(api.chatroom.getChatTools, chatId ? { chatId } : "skip"),
  );
  const { data: defaults } = useQuery(
    convexQuery(api.chatroom.getToolDefaults, !chatId && workspace ? { workspace } : "skip"),
  );
  const setChatTools = useMutation(api.chatroom.setChatTools);

  let selection: ToolSelection | undefined = defaults;
  if (chatId) {
    selection = chatTools;
  } else if (draftTools) {
    selection = draftTools;
  }

  const hasWorker = Boolean(workerSelection?.workerId);
  const workerTools = workerSelection?.tools ?? [];

  async function changeTools(next: ToolSelection) {
    if (!chatId) {
      onDraftToolsChange(next);
      return;
    }

    try {
      await setChatTools({
        chatId,
        // MCP server ids round-trip as strings and are narrowed back to ids by Convex.
        selection: {
          builtinToolSets: next.builtinToolSets,
          mcpServers: next.mcpServers as Id<"mcp_servers">[],
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update tools.");
    }
  }

  function toggleBuiltin(current: ToolSelection, id: string, enabled: boolean) {
    const others = current.builtinToolSets.filter((entry) => entry !== id);
    void changeTools({ ...current, builtinToolSets: enabled ? [...others, id] : others });
  }

  function toggleServer(current: ToolSelection, id: string, enabled: boolean) {
    const others = current.mcpServers.filter((entry) => entry !== id);
    void changeTools({ ...current, mcpServers: enabled ? [...others, id] : others });
  }

  function toggleWorkerTool(option: WorkerToolOption, enabled: boolean) {
    const tools = withWorkerToolOption(workerTools, option, enabled);

    // Without a Worker the selection only carries tools; none left means no selection at all.
    if (!workerSelection?.workerId && tools.length === 0) {
      onWorkerSelectionChange(null);
      return;
    }
    onWorkerSelectionChange({ ...workerSelection, tools });
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <InputGroupButton size="icon-sm" aria-label="Tools" title="Tools">
          <WrenchIcon />
        </InputGroupButton>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100svh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tools</DialogTitle>
          <DialogDescription>
            {chatId
              ? "Tools this chat can use. Changes apply to this chat only."
              : "Tools the new chat starts with. Changes apply to this draft only."}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 flex min-h-0 flex-col gap-6 overflow-y-auto px-6">
          <GroupList>
            {BUILTIN_TOOL_SETS.map((toolSet) => (
              <ToolRow
                key={toolSet.id}
                icon={builtinToolIcon(toolSet.id)}
                toolId={toolSet.id}
                description={toolSet.description}
                tags={toolSet.available ? null : <Tag>Soon</Tag>}
                isDimmed={!toolSet.available}
              >
                <Switch
                  checked={
                    toolSet.available && (selection?.builtinToolSets.includes(toolSet.id) ?? false)
                  }
                  disabled={!selection || !toolSet.available}
                  aria-label={`Use ${toolSet.name}`}
                  onCheckedChange={(checked) => {
                    if (selection) toggleBuiltin(selection, toolSet.id, checked);
                  }}
                />
              </ToolRow>
            ))}
            {workerToolOptions.map((tool) => (
              <ToolRow
                key={tool.id}
                icon={tool.icon}
                toolId={tool.id}
                description={tool.description}
                tags={
                  <>
                    {tool.requiresApproval ? <Tag>Approval</Tag> : null}
                    {hasWorker ? null : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Tag tabIndex={0} title="Select a Worker to run this tool">
                            Unavailable
                          </Tag>
                        </TooltipTrigger>
                        <TooltipContent>Select a Worker to run this tool</TooltipContent>
                      </Tooltip>
                    )}
                  </>
                }
              >
                <Switch
                  checked={isWorkerToolOptionEnabled(tool, workerTools)}
                  disabled={isWorkerLocked}
                  aria-label={`Use ${tool.label}`}
                  onCheckedChange={(checked) => toggleWorkerTool(tool, checked)}
                />
              </ToolRow>
            ))}
          </GroupList>

          <GroupList title="MCP servers">
            {servers === undefined ? (
              <RowBlock>
                <Skeleton className="h-4 w-40" />
              </RowBlock>
            ) : null}
            {servers?.length === 0 ? (
              <RowBlock className="text-sm text-muted-foreground">
                No MCP servers in this workspace yet.
              </RowBlock>
            ) : null}
            {servers?.map((server) => (
              <Row
                key={server._id}
                icon={ServerIcon}
                title={server.name}
                description={<span className="font-mono text-[13px]">{server.url}</span>}
              >
                <Tag>{server.codeMode ? "Code Mode" : "Direct"}</Tag>
                <Switch
                  checked={selection?.mcpServers.includes(server._id) ?? false}
                  disabled={!selection}
                  aria-label={`Use ${server.name}`}
                  onCheckedChange={(checked) => {
                    if (selection) toggleServer(selection, server._id, checked);
                  }}
                />
              </Row>
            ))}
          </GroupList>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
            <Link
              to="/chatroom/$section"
              params={{ section: "tools" }}
              onClick={() => setIsOpen(false)}
            >
              <SettingsIcon data-icon="inline-start" />
              Tool Settings
            </Link>
          </Button>
          <DialogClose asChild>
            <Button size="sm">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
