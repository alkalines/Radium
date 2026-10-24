import { CheckIcon } from "lucide-react";

import {
  TILE_COLOR_NAMES,
  resolveTileColorName,
  type TileColorName,
} from "backend/src/workspaces/colors";
import { resolveWorkspaceIconName, type WorkspaceIconName } from "backend/src/workspaces/icons";
import { Button } from "@/components/ui/button";
import { workspaceIconOptions } from "@/components/workspaces/workspace-icon";
import { cn } from "@/lib/utils";

/**
 * Color swatches and the icon grid for a workspace or Project tile. Values are persisted names
 * (`backend/src/workspaces/colors.ts`, `icons.ts`); unknown names show the defaults as selected.
 * The caller owns persistence: it may save on every pick (Settings) or on submit (dialogs).
 */
export function TileAppearanceFields({
  color,
  icon,
  disabled,
  onColorChange,
  onIconChange,
}: {
  color?: string;
  icon?: string;
  disabled?: boolean;
  onColorChange: (color: TileColorName) => void;
  onIconChange: (icon: WorkspaceIconName) => void;
}) {
  const selectedColor = resolveTileColorName(color);
  const selectedIcon = resolveWorkspaceIconName(icon);

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
        {TILE_COLOR_NAMES.map((name) => {
          const isSelected = name === selectedColor;
          const label = name === "brand" ? "Radium orange" : name[0]!.toUpperCase() + name.slice(1);

          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={label}
              title={label}
              disabled={disabled}
              style={{ backgroundColor: `var(--tile-${name})` }}
              className={cn(
                "flex size-6 items-center justify-center rounded-md text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                isSelected && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
              )}
              onClick={() => onColorChange(name)}
            >
              {isSelected ? <CheckIcon className="size-3.5" /> : null}
            </button>
          );
        })}
      </div>

      <div
        role="radiogroup"
        aria-label="Icon"
        className="grid grid-cols-6 place-items-center gap-1"
      >
        {workspaceIconOptions.map((option) => {
          const isSelected = option.name === selectedIcon;

          return (
            <Button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={isSelected}
              variant={isSelected ? "secondary" : "ghost"}
              size="icon-sm"
              title={option.label}
              aria-label={option.label}
              disabled={disabled}
              onClick={() => onIconChange(option.name)}
            >
              <option.icon />
            </Button>
          );
        })}
      </div>
    </div>
  );
}
