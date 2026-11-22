/** Stable icon identifiers accepted for persisted workspace settings. */
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

/** Default icon for workspaces without a supported icon identifier. */
export const DEFAULT_WORKSPACE_ICON: WorkspaceIconName = "boxes";

/** Check whether an untrusted string is one of the supported workspace icons. */
export function isWorkspaceIconName(value: string): value is WorkspaceIconName {
  return (WORKSPACE_ICON_NAMES as readonly string[]).includes(value);
}

/** Resolve missing or retired icon identifiers to the stable default. */
export function resolveWorkspaceIconName(value?: string): WorkspaceIconName {
  return value && isWorkspaceIconName(value) ? value : DEFAULT_WORKSPACE_ICON;
}
