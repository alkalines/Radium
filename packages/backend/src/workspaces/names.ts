/** Maximum stored length for workspace and Project display names. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * Normalize a user-entered workspace or Project name to one line with collapsed whitespace,
 * truncated to {@link MAX_DISPLAY_NAME_LENGTH}. Throws `"<label> name is required."` when
 * nothing but whitespace remains.
 */
export function normalizeDisplayName(name: string, label: "Workspace" | "Project"): string {
  const normalized = name
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) throw new Error(`${label} name is required.`);
  return normalized.slice(0, MAX_DISPLAY_NAME_LENGTH);
}
