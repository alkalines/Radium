import { Link } from "@tanstack/react-router";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { SettingsIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";

import { BUILTIN_TOOL_SETS, EMPTY_TOOL_SELECTION } from "@/utils/chatroom/tools";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * The "Tools" submenu shown inside the chat composer's `+` action menu.
 *
 * Lists the user's built-in tool sets and MCP servers with enable/disable
 * toggles, plus a deep link to the Chatroom → Tools settings page to configure
 * or add servers. Renders inside an existing dropdown menu, so it only emits
 * dropdown sub-menu primitives.
 *
 * Two modes:
 * - **chat** (`chatId` provided) — toggles write a per-chat override via
 *   {@link api.chatroom.setChatTools}; the menu reflects the chat's effective
 *   selection (its override, or the user defaults until first changed).
 * - **defaults** (no `chatId`, e.g. the home composer) — toggles edit the user's
 *   default selection via {@link api.chatroom.setToolDefaults}.
 */
export function ChatToolsMenu({
  balance,
  chatId,
}: {
  balance: Id<"balances"> | undefined;
  chatId?: Id<"aisdk_chats">;
}) {
  const { data: servers } = useQuery(
    convexQuery(api.mcp.listServers, balance ? {} : "skip"),
  );
  const { data: chatTools } = useQuery(
    convexQuery(api.chatroom.getChatTools, chatId ? { chatId } : "skip"),
  );
  const { data: defaults } = useQuery(
    convexQuery(api.chatroom.getToolDefaults, !chatId && balance ? {} : "skip"),
  );
  const setChatTools = useMutation(api.chatroom.setChatTools);
  const setToolDefaults = useMutation(api.chatroom.setToolDefaults);

  const selection = chatId ? chatTools : (defaults ?? EMPTY_TOOL_SELECTION);
  const loading = selection === undefined;

  async function persist(builtinToolSets: string[], mcpServers: string[]) {
    try {
      if (chatId) {
        await setChatTools({
          chatId,
          selection: { builtinToolSets, mcpServers: mcpServers as Id<"mcp_servers">[] },
        });
      } else {
        await setToolDefaults({
          selection: { builtinToolSets, mcpServers: mcpServers as Id<"mcp_servers">[] },
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update tools.");
    }
  }

  function toggleBuiltin(id: string, enabled: boolean) {
    if (loading) return;
    const builtinToolSets = enabled
      ? [...selection.builtinToolSets, id]
      : selection.builtinToolSets.filter((entry) => entry !== id);
    void persist(builtinToolSets, selection.mcpServers);
  }

  function toggleServer(id: string, enabled: boolean) {
    if (loading) return;
    const mcpServers = enabled
      ? [...selection.mcpServers, id]
      : selection.mcpServers.filter((entry) => entry !== id);
    void persist(selection.builtinToolSets, mcpServers);
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <WrenchIcon className="size-4" />
        Tools
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        <DropdownMenuLabel>Built-in</DropdownMenuLabel>
        {BUILTIN_TOOL_SETS.map((toolSet) => (
          <DropdownMenuCheckboxItem
            key={toolSet.id}
            checked={selection?.builtinToolSets.includes(toolSet.id) ?? false}
            disabled={loading || (!balance && !chatId)}
            // Keep the menu open so several tools can be toggled in one go.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => toggleBuiltin(toolSet.id, checked)}
          >
            {toolSet.name}
            {!toolSet.available && (
              <span className="ml-auto text-xs text-muted-foreground">soon</span>
            )}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>MCP servers</DropdownMenuLabel>
        {servers && servers.length > 0 ? (
          servers.map((server) => (
            <DropdownMenuCheckboxItem
              key={server._id}
              checked={selection?.mcpServers.includes(server._id) ?? false}
              disabled={loading}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => toggleServer(server._id, checked)}
            >
              <span className="truncate">{server.name}</span>
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No MCP servers yet</DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/chatroom/$section" params={{ section: "tools" }}>
            <SettingsIcon className="size-4" />
            Configure tools
          </Link>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
