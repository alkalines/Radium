/** A Project's display hint for a Tab icon: its name, tile color name, and icon name. */
export type TabProjectHint = { name: string; color?: string; icon?: string };

/**
 * One open session Tab. Tabs are client UI state (`docs/Interface_Design.md` §4): they hold only
 * IDs and display hints, and session content always loads from the backend.
 */
export type SessionTab = {
  /** Stable for the Tab's lifetime, including when a draft becomes a saved chat. */
  id: string;
  /** Saved chat; absent while the Tab is an unsent `New session` draft. */
  chatId?: string;
  /** Last known title, shown before the chat loads. */
  title?: string;
  /** Last known Project, shown as the Tab icon before the chat loads; absent without a Project. */
  project?: TabProjectHint;
};

type PersistedWindow = { tabs: SessionTab[] };

// Open Tabs live in localStorage, never Convex (spec §4). Bump the version suffix whenever the
// persisted shape changes incompatibly so an old shape is ignored instead of misread; additive
// optional fields (the `project` hint) keep the key because older entries still validate.
const storageKey = "radium.tabs.v1";

/**
 * Reads the persisted Tabs. Storage can be unavailable or hold anything (another version, manual
 * edits), so invalid entries are dropped rather than trusted.
 */
export function readPersistedTabs(): SessionTab[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("tabs" in parsed)) return [];
    if (!Array.isArray(parsed.tabs)) return [];

    return parsed.tabs.filter(isSessionTab);
  } catch {
    return [];
  }
}

/** Persists the Tabs; failures leave Tabs alive for the visit only. */
export function writePersistedTabs(tabs: SessionTab[]) {
  const value: PersistedWindow = { tabs };

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); Tabs then last for the visit.
  }
}

export function newTabId() {
  return `tab-${crypto.randomUUID().slice(0, 8)}`;
}

function isSessionTab(value: unknown): value is SessionTab {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || typeof value.id !== "string") return false;
  if ("chatId" in value && value.chatId !== undefined && typeof value.chatId !== "string") {
    return false;
  }
  if ("title" in value && value.title !== undefined && typeof value.title !== "string") {
    return false;
  }
  if ("project" in value && value.project !== undefined && !isTabProjectHint(value.project)) {
    return false;
  }
  return true;
}

function isTabProjectHint(value: unknown): value is TabProjectHint {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if ("color" in value && value.color !== undefined && typeof value.color !== "string") {
    return false;
  }
  if ("icon" in value && value.icon !== undefined && typeof value.icon !== "string") {
    return false;
  }
  return true;
}
