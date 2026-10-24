import type { ToolSelection } from "backend/src/chatroom/tools";
import {
  chatWorkerToolValidator,
  type ChatWorkerSelection,
  type ChatWorkerTool,
} from "backend/src/worker/chat-config";
import type { ChatScope } from "./composer";

/** Choices of an unsent draft. Saved chats read these from Convex instead. */
export type DraftTabSnapshot = {
  /** Workspace the choices belong to; a draft restored into another workspace discards them. */
  workspaceId: string;
  scope: ChatScope;
  worker: ChatWorkerSelection | null;
  project: string | null;
  /** Built-in/MCP override; `null` inherits the workspace defaults at creation. */
  tools: ToolSelection | null;
};

/**
 * What one Session Tab holds that Convex cannot give back after a reload. Attachments are not
 * kept: their blob URLs do not survive a reload.
 */
export type SessionTabSnapshot = {
  text?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  reasoningBudget?: number;
  agentId?: string;
  /** Present only while the Tab is a draft. */
  draft?: DraftTabSnapshot;
};

type TabStateMap = Record<string, SessionTabSnapshot>;

// Separate from the open-Tab list (`radium.tabs.*`) so either can change shape alone. Bump the
// suffix whenever the snapshot shape changes so an old shape is ignored instead of misread.
const storageKey = "radium.tab-state.v1";

// The validator's literals are the source of truth for which Worker tools exist.
const workerToolIds: ChatWorkerTool[] = chatWorkerToolValidator.members.map(
  (member) => member.value,
);

/** The persisted snapshot of one Tab, or `undefined` when there is none or storage fails. */
export function readTabState(tabId: string): SessionTabSnapshot | undefined {
  return readAll()[tabId];
}

/**
 * Merges `patch` into one Tab's snapshot (top-level fields; `undefined` removes a field).
 * Writes synchronously so a reload right after a change still restores it; failures leave the
 * state alive for the visit only.
 */
export function patchTabState(tabId: string, patch: Partial<SessionTabSnapshot>) {
  const all = readAll();
  const next: SessionTabSnapshot = { ...all[tabId], ...patch };
  for (const key of Object.keys(next) as (keyof SessionTabSnapshot)[]) {
    if (next[key] === undefined) delete next[key];
  }
  all[tabId] = next;
  writeAll(all);
}

/** Drops a Tab's snapshot when the Tab closes or its session becomes unavailable. */
export function removeTabState(tabId: string) {
  const all = readAll();
  if (!(tabId in all)) return;
  delete all[tabId];
  writeAll(all);
}

/** Drops snapshots of Tabs that no longer exist (closed in another visit, lost Tab list). */
export function pruneTabStates(openTabIds: Iterable<string>) {
  const keep = new Set(openTabIds);
  const all = readAll();
  let changed = false;
  for (const tabId of Object.keys(all)) {
    if (keep.has(tabId)) continue;
    delete all[tabId];
    changed = true;
  }
  if (changed) writeAll(all);
}

/**
 * Storage can be unavailable or hold anything (another version, manual edits), so each field is
 * validated and invalid fields are dropped rather than trusted.
 */
function readAll(): TabStateMap {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const all: TabStateMap = {};
    for (const [tabId, value] of Object.entries(parsed)) {
      if (typeof value === "object" && value !== null) all[tabId] = parseSnapshot(value);
    }
    return all;
  } catch {
    return {};
  }
}

function writeAll(all: TabStateMap) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private mode, quota, blocked site data); state lasts the visit.
  }
}

function parseSnapshot(value: object): SessionTabSnapshot {
  const snapshot: SessionTabSnapshot = {};
  if ("text" in value && typeof value.text === "string") snapshot.text = value.text;
  if ("model" in value && typeof value.model === "string") snapshot.model = value.model;
  if ("provider" in value && typeof value.provider === "string") {
    snapshot.provider = value.provider;
  }
  if ("reasoningEffort" in value && typeof value.reasoningEffort === "string") {
    snapshot.reasoningEffort = value.reasoningEffort;
  }
  if (
    "reasoningBudget" in value &&
    typeof value.reasoningBudget === "number" &&
    Number.isFinite(value.reasoningBudget)
  ) {
    snapshot.reasoningBudget = value.reasoningBudget;
  }
  if ("agentId" in value && typeof value.agentId === "string") snapshot.agentId = value.agentId;

  const draft = "draft" in value ? parseDraft(value.draft) : undefined;
  if (draft) snapshot.draft = draft;
  return snapshot;
}

/** A draft section is all-or-nothing: partial choices could mix two workspaces' settings. */
function parseDraft(value: unknown): DraftTabSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("workspaceId" in value) || typeof value.workspaceId !== "string") return undefined;
  if (!("scope" in value) || (value.scope !== "personal" && value.scope !== "workspace")) {
    return undefined;
  }
  if (!("worker" in value) || !("project" in value) || !("tools" in value)) return undefined;

  let worker: ChatWorkerSelection | null = null;
  if (value.worker !== null) {
    const parsedWorker = parseWorker(value.worker);
    if (!parsedWorker) return undefined;
    worker = parsedWorker;
  }

  if (value.project !== null && typeof value.project !== "string") return undefined;

  let tools: ToolSelection | null = null;
  if (value.tools !== null) {
    const parsedTools = parseToolSelection(value.tools);
    if (!parsedTools) return undefined;
    tools = parsedTools;
  }

  return {
    workspaceId: value.workspaceId,
    scope: value.scope,
    worker,
    project: value.project,
    tools,
  };
}

/**
 * A draft's Worker selection: `workerId` is optional (Worker tools chosen before a Worker) and a
 * stored directory is ignored, because the backend derives it.
 */
function parseWorker(value: unknown): ChatWorkerSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("tools" in value) || !Array.isArray(value.tools)) return undefined;

  let workerId: string | undefined;
  if ("workerId" in value && value.workerId !== undefined) {
    if (typeof value.workerId !== "string") return undefined;
    workerId = value.workerId;
  }

  const tools: ChatWorkerTool[] = [];
  for (const tool of value.tools) {
    const known = workerToolIds.find((id) => id === tool);
    // Duplicates are rejected by the backend, so a duplicated list is not a valid selection.
    if (!known || tools.includes(known)) return undefined;
    tools.push(known);
  }
  return workerId === undefined ? { tools } : { workerId, tools };
}

function parseToolSelection(value: unknown): ToolSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("builtinToolSets" in value) || !isStringArray(value.builtinToolSets)) return undefined;
  if (!("mcpServers" in value) || !isStringArray(value.mcpServers)) return undefined;
  return { builtinToolSets: value.builtinToolSets, mcpServers: value.mcpServers };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
