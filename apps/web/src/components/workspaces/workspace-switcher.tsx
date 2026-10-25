import { Link } from "@tanstack/react-router";
import { ChevronsUpDownIcon, RotateCcwIcon, SettingsIcon } from "lucide-react";

import { ProjectTile } from "@/components/harness/project-tile";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceIcon } from "./workspace-icon";
import { useWorkspace } from "./workspace-provider";

/**
 * Changes the current workspace (Window state, `docs/Interface_Design.md` §4). `chip` is the flat
 * Tab strip control beside the User menu; `heading` is the Settings workspace section heading.
 * Selection persists through `WorkspaceProvider`; a failed personal-workspace setup offers retry.
 */
export function WorkspaceSwitcher({ variant }: { variant: "chip" | "heading" }) {
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

  if ((isLoading || isProvisioning) && !workspace) {
    return <Skeleton className={variant === "chip" ? "h-6 w-24" : "h-5 w-28"} />;
  }

  const name = workspace?.name ?? (provisionError ? "Workspace setup failed" : "No workspace");
  const label = `Workspace: ${name}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "chip" ? (
          <Button
            variant="ghost"
            size="xs"
            aria-label={label}
            className="max-w-48 min-w-0 text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
          >
            <ProjectTile color={workspace?.color}>
              <WorkspaceIcon name={workspace?.icon} />
            </ProjectTile>
            {/* The tile alone identifies the workspace where the Tab strip has no room. */}
            <span className="truncate max-sm:sr-only">{name}</span>
            <ChevronsUpDownIcon data-icon="inline-end" className="size-3 opacity-70" />
          </Button>
        ) : (
          // Spans the section heading row (cancelling its `pl-3 pr-1`) so the tile lines up with
          // the page icons below.
          <button
            type="button"
            aria-label={label}
            className="group/workspace -mr-1 -ml-3 flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors outline-none hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30 data-[state=open]:bg-accent"
          >
            <ProjectTile color={workspace?.color}>
              <WorkspaceIcon name={workspace?.icon} />
            </ProjectTile>
            <span className="flex min-w-0 flex-1 items-baseline gap-1">
              <span className="shrink-0 text-subtle-foreground">Workspace:</span>
              <span className="truncate font-medium text-foreground">{name}</span>
            </span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/workspace:text-foreground group-data-[state=open]/workspace:text-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === "chip" ? "end" : "start"}
        className={variant === "chip" ? "w-60" : "w-(--radix-dropdown-menu-trigger-width) min-w-60"}
      >
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {provisionError ? (
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={retryProvisioning}>
              <RotateCcwIcon />
              Retry workspace setup
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : null}
        <DropdownMenuRadioGroup
          value={workspaceId ?? ""}
          onValueChange={(id) => {
            const next = workspaces.find((candidate) => candidate._id === id);
            if (next) setWorkspace(next._id);
          }}
        >
          {workspaces.map((candidate) => (
            <DropdownMenuRadioItem key={candidate._id} value={candidate._id}>
              <ProjectTile color={candidate.color}>
                <WorkspaceIcon name={candidate.icon} />
              </ProjectTile>
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              <span className="text-xs text-muted-foreground">
                {candidate.role === "owner" ? "Owner" : "Member"}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/settings/workspace">
              <SettingsIcon />
              Manage workspaces
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
