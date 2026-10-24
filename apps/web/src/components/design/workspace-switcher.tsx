import { ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { demoWorkspaces, type DemoWorkspace } from "./demo-data";
import { ProjectTile } from "./project-tile";

/**
 * Changes the current workspace, which is Window state (spec §4). `chip` is the flat Tab strip
 * control beside the User menu; `heading` is the Settings workspace section heading itself.
 */
export function WorkspaceSwitcher({
  workspace,
  onWorkspaceChange,
  variant,
}: {
  workspace: DemoWorkspace;
  onWorkspaceChange: (workspace: DemoWorkspace) => void;
  variant: "chip" | "heading";
}) {
  const label = `Workspace: ${workspace.name}`;

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
            <ProjectTile initial={workspace.initial} />
            <span className="truncate">{workspace.name}</span>
          </Button>
        ) : (
          <button
            type="button"
            aria-label={label}
            className="-mx-1 flex min-w-0 items-center gap-1 rounded-md px-1 text-sm text-subtle-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 data-[state=open]:text-foreground"
          >
            <span className="truncate">{workspace.name}</span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-design="harness"
        align={variant === "chip" ? "end" : "start"}
        className="w-56"
      >
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={workspace.id}
          onValueChange={(id) => {
            const next = demoWorkspaces.find((candidate) => candidate.id === id);
            if (next) onWorkspaceChange(next);
          }}
        >
          {demoWorkspaces.map((candidate) => (
            <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
              <ProjectTile initial={candidate.initial} />
              <span className="flex-1 truncate">{candidate.name}</span>
              <span className="text-xs text-muted-foreground">{candidate.role}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
