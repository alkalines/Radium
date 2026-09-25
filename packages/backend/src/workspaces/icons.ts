export const WORKSPACE_ICON_NAMES = [
  "boxes",
  "briefcase",
  "code",
  "flask",
  "globe",
  "home",
  "palette",
  "rocket",
  "server",
  "sparkles",
  "users",
  "zap",
] as const;

export type WorkspaceIconName = (typeof WORKSPACE_ICON_NAMES)[number];

export const DEFAULT_WORKSPACE_ICON: WorkspaceIconName = "boxes";

export function isWorkspaceIconName(value: string): value is WorkspaceIconName {
  return (WORKSPACE_ICON_NAMES as readonly string[]).includes(value);
}

export function resolveWorkspaceIconName(value?: string): WorkspaceIconName {
  return value && isWorkspaceIconName(value) ? value : DEFAULT_WORKSPACE_ICON;
}
