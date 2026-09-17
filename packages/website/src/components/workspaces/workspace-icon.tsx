import {
  BoxesIcon,
  BriefcaseBusinessIcon,
  Code2Icon,
  FlaskConicalIcon,
  Globe2Icon,
  HomeIcon,
  PaletteIcon,
  RocketIcon,
  ServerIcon,
  SparklesIcon,
  UsersIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

import {
  WORKSPACE_ICON_NAMES,
  resolveWorkspaceIconName,
  type WorkspaceIconName,
} from "@/utils/workspaces/icons";

const iconComponents: Record<WorkspaceIconName, LucideIcon> = {
  boxes: BoxesIcon,
  briefcase: BriefcaseBusinessIcon,
  code: Code2Icon,
  flask: FlaskConicalIcon,
  globe: Globe2Icon,
  home: HomeIcon,
  palette: PaletteIcon,
  rocket: RocketIcon,
  server: ServerIcon,
  sparkles: SparklesIcon,
  users: UsersIcon,
  zap: ZapIcon,
};

export const workspaceIconOptions = WORKSPACE_ICON_NAMES.map((name) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
  icon: iconComponents[name],
}));

export function WorkspaceIcon({ name, ...props }: { name?: string } & ComponentProps<"svg">) {
  const Icon = iconComponents[resolveWorkspaceIconName(name)];
  return <Icon {...props} />;
}
