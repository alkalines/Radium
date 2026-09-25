import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, RotateCcwIcon, SettingsIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { WorkspaceIcon } from "./workspace-icon";
import { useWorkspace } from "./workspace-provider";

export function WorkspaceSwitcher() {
  const {
    workspaces,
    workspace,
    workspaceId,
    isLoading,
    isProvisioning,
    provisionError,
    retryProvisioning,
    setWorkspace,
  } = useWorkspace();
  const { isMobile, setOpenMobile } = useSidebar();
  const isPreparing = isLoading || isProvisioning;

  function closeMobileSidebar() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className="h-9 rounded-xl px-3"
              disabled={isPreparing || (!workspace && !provisionError)}
              tooltip={workspace?.name ?? (provisionError ? "Workspace setup failed" : "Workspace")}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
                <WorkspaceIcon name={workspace?.icon} className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {workspace?.name ??
                  (provisionError
                    ? "Workspace setup failed"
                    : isPreparing
                      ? "Preparing..."
                      : "No workspace")}
              </span>
              <ChevronsUpDownIcon className="ml-auto text-sidebar-foreground/60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
              {provisionError ? (
                <DropdownMenuItem onSelect={retryProvisioning}>
                  <RotateCcwIcon />
                  Retry setup
                </DropdownMenuItem>
              ) : null}
              {workspaces.map((item) => (
                <DropdownMenuItem
                  key={item._id}
                  onSelect={() => {
                    setWorkspace(item._id);
                    closeMobileSidebar();
                  }}
                >
                  <WorkspaceIcon name={item.icon} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item._id === workspaceId ? (
                    <>
                      <CheckIcon />
                      <span className="sr-only">Current workspace</span>
                    </>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/settings/workspace" onClick={closeMobileSidebar}>
                  <SettingsIcon />
                  Manage workspaces
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
