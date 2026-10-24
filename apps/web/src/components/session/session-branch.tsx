import { ChevronDownIcon, GitBranchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The `/ branch` part of the Session context: the Git branch of the Project checkout on the
 * Worker. The name is Machine text and truncates (full name in `title`). Editable before the first
 * message when `branches` and `onBranchChange` are given; a plain label once `isFixed`.
 *
 * Renders nothing without a `branch`. Branches will come from the Worker checkout of a Project's
 * folder; nothing reads that checkout yet, so Sessions pass `branch={undefined}` and the chip stays hidden.
 */
export function SessionBranch({
  branch,
  branches,
  onBranchChange,
  isFixed,
}: {
  branch?: string;
  branches?: string[];
  onBranchChange?: (branch: string) => void;
  isFixed: boolean;
}) {
  if (!branch) return null;

  const label = (
    <>
      <GitBranchIcon className="size-3.5 shrink-0" />
      <span className="max-w-44 truncate font-mono text-xs">{branch}</span>
    </>
  );
  const isEditable = !isFixed && onBranchChange !== undefined && Boolean(branches?.length);

  return (
    <>
      <span aria-hidden="true" className="text-subtle-foreground">
        /
      </span>
      {isEditable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              title={branch}
              className="min-w-0 text-muted-foreground"
              aria-label={`Branch: ${branch}`}
            >
              {label}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            <DropdownMenuLabel>Branches</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={branch} onValueChange={onBranchChange}>
              {branches?.map((candidate) => (
                <DropdownMenuRadioItem key={candidate} value={candidate}>
                  <span className="truncate font-mono text-[13px]">{candidate}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span
          className="inline-flex h-6 min-w-0 items-center gap-1 px-2 text-muted-foreground"
          title={branch}
        >
          {label}
        </span>
      )}
    </>
  );
}
