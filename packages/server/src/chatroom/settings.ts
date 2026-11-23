import { and, asc, eq, inArray } from "drizzle-orm";
import { WEB_SEARCH_TOOL_ID } from "contracts/chatroom/tools";
import { chatWorkerToolValidator, type ChatWorkerTool } from "contracts/worker/chat-config";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "../gateway/providers";
import { authors, models } from "../gateway/schema";
import { workspaces } from "../workspaces/schema";
import { readWorkspaceSettings, updateWorkspaceSettings } from "../workspaces/settings";
import { requireChatAccess, requireChatManager, type Chat } from "./access";
import { mcpServers, type McpServerAuth } from "./schema";
import type { ChatModelIdentity, SystemPromptSettings } from "./system-prompt";
import { isTitleGenerationModel } from "./titles";
import {
  readChatSelection,
  readChatStoredSelection,
  readWorkspaceSelection,
  writeChatSelection,
  writeWorkspaceSelection,
  effectiveSelection,
  type WorkspaceToolSelection,
} from "./tool-selection";

/**
 * Workspace Chatroom configuration: default tool selection, default and title models, Chain of
 * Thought and system prompt switches, and a chat's own tool override. Authorization (member read,
 * owner write) is the procedure's; chat-scoped functions authorize through the chat access
 * function themselves.
 */

// --- Tool defaults ----------------------------------------------------------------------------

/** The workspace's default tool selection. */
export function getToolDefaults(db: Database, workspace: string) {
  return readWorkspaceSelection(db, workspace);
}

/** Replaces the workspace's default tool selection. */
export function setToolDefaults(
  db: Database,
  workspace: string,
  selection: WorkspaceToolSelection,
) {
  return writeWorkspaceSelection(db, workspace, selection);
}

/** The workspace's default Worker tools; none when never set. */
export async function getWorkerToolDefaults(
  db: Database,
  workspace: string,
): Promise<ChatWorkerTool[]> {
  const settings = await readWorkspaceSettings(db, workspace);
  return (settings?.workerTools ?? []).map((tool) => chatWorkerToolValidator.parse(tool));
}

/** Replaces the workspace's default Worker tools; they must be unique. */
export async function setWorkerToolDefaults(
  db: Database,
  workspace: string,
  tools: ChatWorkerTool[],
) {
  if (new Set(tools).size !== tools.length) {
    throw new AppError("BAD_REQUEST", "Worker tools must be unique.");
  }
  await updateWorkspaceSettings(db, workspace, { workerTools: tools });
}

// --- Models -----------------------------------------------------------------------------------

/** Whether an enabled provider of the workspace offers `slug`. */
async function workspaceHasModel(db: Database, workspace: string, slug: string) {
  const records = await workspaceProviderRecords(db, workspace);
  return records.some(
    (record) =>
      isWorkspaceProviderEnabled(record) &&
      record.provider.models.some((model) => model.model === slug),
  );
}

async function catalogModel(db: Database, slug: string) {
  const [model] = await db.select().from(models).where(eq(models.slug, slug));
  return model ?? null;
}

/**
 * The default model slug, or `null` if unset. The stored slug is validated against the
 * catalogue and the workspace's providers so a removed model never sticks as a phantom default.
 */
export async function getModelDefault(db: Database, workspace: string): Promise<string | null> {
  const slug = (await readWorkspaceSettings(db, workspace))?.defaultModel;
  if (!slug) return null;
  return (await catalogModel(db, slug)) && (await workspaceHasModel(db, workspace, slug))
    ? slug
    : null;
}

/** Sets (or clears, with `null`) the default model slug. */
export async function setModelDefault(db: Database, workspace: string, model: string | null) {
  if (model) {
    if (!(await catalogModel(db, model))) throw new AppError("BAD_REQUEST", "Unknown model.");
    if (!(await workspaceHasModel(db, workspace, model))) {
      throw new AppError("BAD_REQUEST", "Model is not configured for this workspace.");
    }
  }
  await updateWorkspaceSettings(db, workspace, { defaultModel: model });
}

/** The title-generator model slug, or `null` if unset or no longer usable. */
export async function getTitleModelDefault(db: Database, workspace: string) {
  const slug = (await readWorkspaceSettings(db, workspace))?.titleModel;
  if (!slug) return null;
  return isTitleGenerationModel(await catalogModel(db, slug)) &&
    (await workspaceHasModel(db, workspace, slug))
    ? slug
    : null;
}

/** Sets (or clears, with `null`) the title-generator model slug. */
export async function setTitleModelDefault(db: Database, workspace: string, model: string | null) {
  if (model) {
    if (!isTitleGenerationModel(await catalogModel(db, model))) {
      throw new AppError("BAD_REQUEST", "Unknown title model.");
    }
    if (!(await workspaceHasModel(db, workspace, model))) {
      throw new AppError("BAD_REQUEST", "Title model is not configured for this workspace.");
    }
  }
  await updateWorkspaceSettings(db, workspace, { titleModel: model });
}

/**
 * The model that titles a workspace's chats: the title model (else the default model) when it
 * can generate titles and a provider offers it, otherwise the first catalogue model that can.
 * `null` when the workspace is archived or nothing qualifies.
 */
export async function titleModelFor(db: Database, workspace: string): Promise<string | null> {
  const [row] = await db
    .select({ archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspace));
  if (!row || row.archivedAt !== null) return null;

  const settings = await readWorkspaceSettings(db, workspace);
  const preferred = settings?.titleModel ?? settings?.defaultModel;
  const offered = new Set(
    (await workspaceProviderRecords(db, workspace))
      .filter(isWorkspaceProviderEnabled)
      .flatMap((record) => record.provider.models.map((model) => model.model)),
  );
  if (offered.size === 0) return null;

  const candidates = await db
    .select()
    .from(models)
    .where(inArray(models.slug, [...offered]))
    .orderBy(asc(models.createdAt), asc(models.id));
  const preferredModel = preferred ? candidates.find((model) => model.slug === preferred) : null;
  if (preferredModel && isTitleGenerationModel(preferredModel)) return preferredModel.slug;
  return candidates.find((model) => isTitleGenerationModel(model))?.slug ?? null;
}

// --- Chain of Thought and system prompt --------------------------------------------------------

/** Whether reasoning and tool activity use the combined Chain of Thought UI; on by default. */
export async function getChainOfThoughtEnabled(db: Database, workspace: string) {
  return (await readWorkspaceSettings(db, workspace))?.enableChainOfThought ?? true;
}

export function setChainOfThoughtEnabled(db: Database, workspace: string, enabled: boolean) {
  return updateWorkspaceSettings(db, workspace, { enableChainOfThought: enabled });
}

/** The system prompt switches; everything on when never changed. */
export async function getSystemPromptSettings(
  db: Database,
  workspace: string,
): Promise<SystemPromptSettings> {
  const settings = await readWorkspaceSettings(db, workspace);
  return {
    enabled: settings?.systemPromptEnabled ?? true,
    modelIdentity: settings?.systemPromptModelIdentity ?? true,
  };
}

/** Sets whether chats send the system prompt and whether it names the model. */
export function setSystemPromptSettings(
  db: Database,
  workspace: string,
  settings: SystemPromptSettings,
) {
  return updateWorkspaceSettings(db, workspace, {
    systemPromptEnabled: settings.enabled,
    systemPromptModelIdentity: settings.modelIdentity,
  });
}

/**
 * What the system prompt of one chat request names, or `null` when the workspace switched the
 * prompt off. `model` is the identity from the global `models` catalogue, absent when it has no
 * record. The chat run builds the text with `chatSystemPrompt`. Callers authorize the chat first.
 */
export async function resolveSystemPrompt(
  db: Database,
  workspace: string,
  modelSlug: string,
): Promise<null | { model?: ChatModelIdentity }> {
  const settings = await getSystemPromptSettings(db, workspace);
  if (!settings.enabled) return null;
  if (!settings.modelIdentity) return {};

  const [row] = await db
    .select({ name: models.name, author: authors.name })
    .from(models)
    .leftJoin(authors, eq(authors.id, models.author))
    .where(eq(models.slug, modelSlug));
  return {
    model: {
      slug: modelSlug,
      ...(row ? { name: row.name } : {}),
      ...(row?.author ? { author: row.author } : {}),
    },
  };
}

// --- Chat tools --------------------------------------------------------------------------------

/**
 * The effective tool selection for a chat: its own override when present, otherwise the
 * workspace defaults. `source` tells the UI whether toggling creates a per-chat override.
 */
export async function getChatTools(db: Database, userId: string, chatId: string) {
  const { chat } = await requireChatAccess(db, userId, chatId);
  return readChatSelection(db, chat);
}

/** Sets a chat's tool override. Managers only (the creator, or the owner for workspace chats). */
export async function setChatTools(
  db: Database,
  userId: string,
  chatId: string,
  selection: WorkspaceToolSelection,
) {
  await db.transaction(async (tx) => {
    const { chat } = await requireChatManager(tx, userId, chatId, "update");
    await writeChatSelection(tx, chat, selection);
  });
}

/** An MCP server selected for a run. The bearer token is loaded separately (`mcpBearerToken`). */
export type ResolvedMcpServer = {
  id: string;
  workspace: string;
  name: string;
  url: string;
  transport: "http";
  auth: McpServerAuth;
  codeMode: boolean;
};

async function resolveSelection(
  db: Database,
  chat: Pick<Chat, "id" | "builtinToolSets" | "disabledBuiltinToolSets">,
  workspace: string,
) {
  const own = await readChatStoredSelection(db, chat);
  return own ? effectiveSelection(own) : await readWorkspaceSelection(db, workspace);
}

/**
 * A chat's effective tool selection as the `/api/chat` run acts on it: the enabled built-in
 * ids plus the selected MCP server records, in selection order. Callers authorize the chat first.
 */
export async function resolveChatTools(
  db: Database,
  chat: Pick<Chat, "id" | "builtinToolSets" | "disabledBuiltinToolSets">,
  workspace: string,
): Promise<{ builtinToolSets: string[]; mcpServers: ResolvedMcpServer[] }> {
  const selection = await resolveSelection(db, chat, workspace);
  if (selection.mcpServers.length === 0) {
    return { builtinToolSets: selection.builtinToolSets, mcpServers: [] };
  }
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.workspace, workspace), inArray(mcpServers.id, selection.mcpServers)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolved: ResolvedMcpServer[] = [];
  for (const id of selection.mcpServers) {
    const row = byId.get(id);
    if (!row) continue;
    resolved.push({
      id: row.id,
      workspace,
      name: row.name,
      url: row.url,
      transport: row.transport,
      auth: row.auth,
      codeMode: row.codeMode,
    });
  }
  return { builtinToolSets: selection.builtinToolSets, mcpServers: resolved };
}

/**
 * Whether the Web Search tool is on for a chat and which workspace owns its Exa credential.
 * Callers authorize the chat first.
 */
export async function resolveWebSearch(
  db: Database,
  chat: Pick<Chat, "id" | "builtinToolSets" | "disabledBuiltinToolSets">,
  workspace: string,
): Promise<{ enabled: boolean; workspace: string | null }> {
  const selection = await resolveSelection(db, chat, workspace);
  const enabled = selection.builtinToolSets.includes(WEB_SEARCH_TOOL_ID);
  return { enabled, workspace: enabled ? workspace : null };
}
