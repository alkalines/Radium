import { useEffect, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { PencilIcon, PlusIcon, ServerIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";

import {
  BUILTIN_TOOL_SETS,
  EMPTY_TOOL_SELECTION,
  WEB_SEARCH_TOOL_ID,
  type ToolSelection,
} from "@/utils/chatroom/tools";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { McpServerDialog, type McpServerEditTarget } from "./mcp-server-dialog";

/**
 * Chatroom → Tools settings. Manages the user's *default* tool selection (which
 * built-in tool sets and MCP servers new chats start with) and the catalogue of
 * MCP servers themselves. Per-chat overrides are edited from the chat composer.
 */
export function ToolsPanel() {
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";
  // Exa keys are still stored per balance; everything else here is per user.
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: servers } = useQuery(
    convexQuery(api.mcp.listServers, signedIn ? {} : "skip"),
  );
  const { data: defaults } = useQuery(
    convexQuery(api.chatroom.getToolDefaults, signedIn ? {} : "skip"),
  );
  const setToolDefaults = useMutation(api.chatroom.setToolDefaults);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpServerEditTarget>(null);
  const [deleting, setDeleting] = useState<{ _id: Id<"mcp_servers">; name: string } | null>(null);

  const selection = defaults ?? EMPTY_TOOL_SELECTION;

  // Persist a new default selection. MCP server ids round-trip as strings and
  // are narrowed back to ids by Convex.
  async function persist(next: ToolSelection) {
    if (!signedIn) return;
    try {
      await setToolDefaults({
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

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Built-in tools</h2>
          <p className="text-sm text-muted-foreground">
            Tool sets bundled with Radium. Enabled tools are turned on by default in new chats.
          </p>
        </div>

        <div className="flex flex-col divide-y rounded-lg border">
          {BUILTIN_TOOL_SETS.map((toolSet) => {
            const enabled = selection.builtinToolSets.includes(toolSet.id);
            return (
              <div key={toolSet.id} className="flex flex-col">
                <div className="flex items-center gap-3 p-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                    <WrenchIcon className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 font-medium">
                      {toolSet.name}
                      {!toolSet.available && <Badge variant="secondary">Soon</Badge>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {toolSet.description}
                    </span>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => toggleBuiltin(toolSet.id, checked)}
                    disabled={!signedIn || defaults === undefined}
                    aria-label={`Enable ${toolSet.name} by default`}
                  />
                </div>
                {toolSet.id === WEB_SEARCH_TOOL_ID && enabled && balanceId && (
                  <ExaApiKeyField balanceId={balanceId} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight">MCP servers</h2>
            <p className="text-sm text-muted-foreground">
              Connect Model Context Protocol servers to expose their tools to your chats.
            </p>
          </div>
          <Button onClick={openCreate} disabled={!signedIn}>
            <PlusIcon data-icon="inline-start" />
            Add server
          </Button>
        </div>

        {!signedIn && userInfo !== undefined && (
          <Alert>
            <AlertTitle>Sign in required</AlertTitle>
            <AlertDescription>Sign in to add MCP servers.</AlertDescription>
          </Alert>
        )}

        {signedIn && servers === undefined ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : signedIn && servers && servers.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon />
              </EmptyMedia>
              <EmptyTitle>No MCP servers</EmptyTitle>
              <EmptyDescription>
                Add a server to give your chats access to external tools.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={openCreate}>
              <PlusIcon data-icon="inline-start" />
              Add server
            </Button>
          </Empty>
        ) : signedIn && servers ? (
          <div className="flex flex-col divide-y rounded-lg border">
            {servers.map((server) => (
              <div key={server._id} className="flex items-center gap-3 p-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                  <ServerIcon className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{server.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {server.url}
                  </span>
                </div>
                <Badge variant="secondary" className="shrink-0 capitalize">
                  {server.auth.type === "none" ? "No auth" : server.auth.type}
                </Badge>
                <div className="flex shrink-0 items-center gap-1.5 pl-1">
                  <Switch
                    checked={selection.mcpServers.includes(server._id)}
                    onCheckedChange={(checked) => toggleServer(server._id, checked)}
                    disabled={defaults === undefined}
                    aria-label={`Enable ${server.name} by default`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={() => {
                      setEditTarget({
                        _id: server._id,
                        name: server.name,
                        url: server.url,
                        auth: server.auth,
                        preview: server.preview,
                        hasSecret: server.hasSecret,
                      });
                      setDialogOpen(true);
                    }}
                    aria-label={`Edit ${server.name}`}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting({ _id: server._id, name: server.name })}
                    aria-label={`Delete ${server.name}`}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <McpServerDialog
        open={dialogOpen}
        target={editTarget}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditTarget(null);
        }}
      />
      <DeleteServerDialog
        target={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </div>
  );
}

/**
 * Exa API key manager shown under the Web Search tool when it is enabled. The
 * key is required for Web Search to run; it is stored encrypted per balance and
 * only its masked preview is ever returned.
 */
function ExaApiKeyField({ balanceId }: { balanceId: Id<"balances"> }) {
  const { data: stored } = useQuery(convexQuery(api.exa.getApiKey, { balance: balanceId }));
  const setApiKey = useMutation(api.exa.setApiKey);
  const deleteApiKey = useMutation(api.exa.deleteApiKey);

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
      await setApiKey({ balance: balanceId, apiKey });
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
      await deleteApiKey({ balance: balanceId });
      toast.success("Exa API key removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove Exa API key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 bg-muted/20 px-3 pb-3 pt-1">
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
        <Button onClick={save} disabled={submitting || !value.trim()}>
          {submitting && <Spinner data-icon="inline-start" />}
          {stored ? "Replace" : "Save"}
        </Button>
        {stored && (
          <Button
            variant="ghost"
            size="icon"
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
    </div>
  );
}

function DeleteServerDialog({
  target,
  onOpenChange,
}: {
  target: { _id: Id<"mcp_servers">; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteServer = useMutation(api.mcp.deleteServer);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target) return;
    setSubmitting(true);
    try {
      await deleteServer({ server: target._id });
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
