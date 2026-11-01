import { Fragment, useEffect, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { MoreHorizontalIcon, PencilIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import {
  BUILTIN_TOOL_SETS,
  EMPTY_TOOL_SELECTION,
  WEB_SEARCH_TOOL_ID,
  type ToolSelection,
} from "backend/src/chatroom/tools";
import { GroupList, Row, RowBlock, Tag } from "@/components/harness/group-list";
import { WorkspacePageHeader, ownerOnlyNotice } from "@/components/settings/workspace-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { McpServerDialog, type McpServerEditTarget } from "./mcp-server-dialog";
import {
  ToolRow,
  builtinToolIcon,
  isWorkerToolOptionEnabled,
  withWorkerToolOption,
  workerToolOptions,
  type WorkerToolOption,
} from "./tool-catalog";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/**
 * Chatroom → Tools settings: the workspace *defaults* a new Session starts with (built-in tool
 * sets, MCP servers, and the Worker tools applied once a Worker is selected) plus the catalogue
 * of MCP servers. Owner-only writes; per-Session choices live in the Composer's Tools dialog and
 * never write back here.
 */
export function ToolsPanel() {
  const { workspace, workspaceId } = useWorkspace();
  const isOwner = workspace?.role === "owner";
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";
  const { data: servers } = useQuery(
    convexQuery(
      api.aisdk_tools.listMcpServers,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const { data: defaults } = useQuery(
    convexQuery(
      api.chatroom.getToolDefaults,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const setToolDefaults = useMutation(api.chatroom.setToolDefaults);
  const { data: workerToolDefaults } = useQuery(
    convexQuery(
      api.chatroom.getWorkerToolDefaults,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  // Optimistic so a quick second toggle builds on the first instead of the stale server list.
  const setWorkerToolDefaults = useMutation(
    api.chatroom.setWorkerToolDefaults,
  ).withOptimisticUpdate((localStore, args) => {
    localStore.setQuery(
      api.chatroom.getWorkerToolDefaults,
      { workspace: args.workspace },
      args.tools,
    );
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpServerEditTarget>(null);
  const [deleting, setDeleting] = useState<{ _id: Id<"mcp_servers">; name: string } | null>(null);

  const selection = defaults ?? EMPTY_TOOL_SELECTION;

  // Persist a new default selection. MCP server ids round-trip as strings and
  // are narrowed back to ids by Convex.
  async function persist(next: ToolSelection) {
    if (!signedIn || !workspaceId) return;
    try {
      await setToolDefaults({
        workspace: workspaceId,
        selection: {
          builtinToolSets: next.builtinToolSets,
          mcpServers: next.mcpServers as Id<"mcp_servers">[],
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update default tools.");
    }
  }

  function toggleBuiltin(id: string, enabled: boolean) {
    const builtinToolSets = enabled
      ? [...selection.builtinToolSets, id]
      : selection.builtinToolSets.filter((entry) => entry !== id);
    void persist({ ...selection, builtinToolSets });
  }

  function toggleServer(id: string, enabled: boolean) {
    const mcpServers = enabled
      ? [...selection.mcpServers, id]
      : selection.mcpServers.filter((entry) => entry !== id);
    void persist({ ...selection, mcpServers });
  }

  async function toggleWorkerTool(option: WorkerToolOption, enabled: boolean) {
    if (!workspaceId || !isOwner || workerToolDefaults === undefined) return;

    const tools = withWorkerToolOption(workerToolDefaults, option, enabled);
    try {
      await setWorkerToolDefaults({ workspace: workspaceId, tools });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update default Worker tools.",
      );
    }
  }

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  return (
    <>
      <WorkspacePageHeader
        title="Tools"
        description={
          isOwner
            ? "Workspace defaults for new Sessions. Choose tools for one Session from the Tools dialog in the Composer."
            : ownerOnlyNotice
        }
        action={
          <Button variant="outline" size="sm" onClick={openCreate} disabled={!signedIn}>
            <PlusIcon data-icon="inline-start" />
            Add MCP server
          </Button>
        }
      />

      {/* Same rows as the Composer's Tools dialog: built-in and Worker tools in one flat list. */}
      <GroupList
        title="Tools"
        description="Enabled tools are on in new Sessions. Worker tools apply once a Worker is picked; write and bash ask for approval before each run."
      >
        {BUILTIN_TOOL_SETS.map((toolSet) => {
          const enabled = toolSet.available && selection.builtinToolSets.includes(toolSet.id);
          return (
            <Fragment key={toolSet.id}>
              <ToolRow
                icon={builtinToolIcon(toolSet.id)}
                toolId={toolSet.id}
                description={toolSet.description}
                tags={toolSet.available ? null : <Tag>Soon</Tag>}
                isDimmed={!toolSet.available}
              >
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => toggleBuiltin(toolSet.id, checked)}
                  disabled={!signedIn || defaults === undefined || !toolSet.available}
                  aria-label={`Enable ${toolSet.name} by default`}
                />
              </ToolRow>
              {toolSet.id === WEB_SEARCH_TOOL_ID && enabled && workspaceId && (
                <ExaApiKeyField workspaceId={workspaceId} />
              )}
            </Fragment>
          );
        })}
        {workerToolOptions.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={tool.icon}
            toolId={tool.id}
            description={tool.description}
            tags={tool.requiresApproval ? <Tag>Approval</Tag> : null}
          >
            <Switch
              checked={isWorkerToolOptionEnabled(tool, workerToolDefaults ?? [])}
              onCheckedChange={(checked) => void toggleWorkerTool(tool, checked)}
              disabled={!isOwner || workerToolDefaults === undefined}
              aria-label={`Enable ${tool.label} by default`}
            />
          </ToolRow>
        ))}
      </GroupList>

      <GroupList
        title="MCP servers"
        description="Connect Model Context Protocol servers to expose their tools to your chats."
      >
        {!signedIn && userInfo !== undefined && (
          <RowBlock className="text-sm text-muted-foreground">Sign in to add MCP servers.</RowBlock>
        )}

        {signedIn && servers === undefined && (
          <RowBlock>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-64" />
          </RowBlock>
        )}

        {signedIn && servers?.length === 0 && (
          <RowBlock className="text-sm text-muted-foreground">
            No MCP servers yet. Add one to give your chats access to external tools.
          </RowBlock>
        )}

        {signedIn &&
          servers?.map((server) => (
            <Row
              key={server._id}
              icon={ServerIcon}
              title={server.name}
              tag={server.auth.type === "none" ? "No auth" : server.auth.type}
              description={<span className="font-mono text-[13px]">{server.url}</span>}
            >
              <Tag>{server.codeMode ? "Code Mode" : "Direct"}</Tag>
              <Switch
                checked={selection.mcpServers.includes(server._id)}
                onCheckedChange={(checked) => toggleServer(server._id, checked)}
                disabled={defaults === undefined}
                aria-label={`Enable ${server.name} by default`}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label={`Actions for ${server.name}`}
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      setEditTarget({
                        _id: server._id,
                        name: server.name,
                        url: server.url,
                        auth: server.auth,
                        preview: server.preview,
                        hasSecret: server.hasSecret,
                        codeMode: server.codeMode,
                      });
                      setDialogOpen(true);
                    }}
                  >
                    <PencilIcon />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting({ _id: server._id, name: server.name })}
                  >
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Row>
          ))}
      </GroupList>

      <McpServerDialog
        workspaceId={workspaceId}
        open={dialogOpen}
        target={editTarget}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
      />
      <DeleteServerDialog
        target={deleting}
        workspaceId={workspaceId}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </>
  );
}

/**
 * Exa API key manager shown under the Web Search tool when it is enabled. The
 * key is required for Web Search to run; it is stored encrypted per workspace and
 * only its masked preview is ever returned.
 */
function ExaApiKeyField({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const { data: stored } = useQuery(
    convexQuery(api.aisdk_tools.getExaApiKey, { workspace: workspaceId }),
  );
  const setApiKey = useMutation(api.aisdk_tools.setExaApiKey);
  const deleteApiKey = useMutation(api.aisdk_tools.deleteExaApiKey);

  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Clear the input once a key is saved so the field shows the placeholder.
  useEffect(() => {
    if (stored) setValue("");
  }, [stored]);

  async function save() {
    const apiKey = value.trim();
    if (!apiKey) return;
    setSubmitting(true);
    try {
      await setApiKey({ workspace: workspaceId, apiKey });
      toast.success("Exa API key saved.");
      setValue("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Exa API key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    setSubmitting(true);
    try {
      await deleteApiKey({ workspace: workspaceId });
      toast.success("Exa API key removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove Exa API key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RowBlock className="gap-2 pt-1">
      <Label htmlFor="exa-api-key" className="text-xs text-muted-foreground">
        Exa API key {!stored && <span className="text-destructive">(required for Web Search)</span>}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id="exa-api-key"
          type="password"
          autoComplete="off"
          placeholder={stored ? `Saved · ${stored.preview}` : "exa_…"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={submitting || stored === undefined}
        />
        <Button variant="outline" size="sm" onClick={save} disabled={submitting || !value.trim()}>
          {submitting && <Spinner data-icon="inline-start" />}
          {stored ? "Replace" : "Save"}
        </Button>
        {stored && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={remove}
            disabled={submitting}
            aria-label="Remove Exa API key"
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Get a key at{" "}
        <a
          href="https://dashboard.exa.ai/api-keys"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          dashboard.exa.ai
        </a>
        .
      </p>
    </RowBlock>
  );
}

function DeleteServerDialog({
  target,
  workspaceId,
  onOpenChange,
}: {
  target: { _id: Id<"mcp_servers">; name: string } | null;
  workspaceId: Id<"workspaces"> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteServer = useMutation(api.aisdk_tools.deleteMcpServer);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target) return;
    setSubmitting(true);
    try {
      if (!workspaceId) return;
      await deleteServer({ workspace: workspaceId, server: target._id });
      toast.success(`Deleted ${target.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target?.name}?</DialogTitle>
          <DialogDescription>
            Chats using this server will lose access to its tools. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner data-icon="inline-start" />}
            Delete server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
