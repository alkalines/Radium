import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { inferModelAuthor, modelKey } from "contracts/acp/models";
import { isTurnCovered, localAgentName, utcDay } from "contracts/usage/local_contract";
import {
  acpAgentDefinitions,
  acpAgentNames,
  acpChatSessionIds,
  acpSessionsBySessionId,
  agentSessionsBySessionId,
} from "../acp/sessions";
import { visibleWorkspaceChats, type Chat } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { credentialDisplayName } from "../gateway/credentials";
import { apiKeys, models, workspaceCredentials } from "../gateway/schema";
import type { WorkspaceAccess } from "../workspaces/access";
import { listProjects } from "../workspaces/projects";
import { agentModelName, normalizeAcpUsage } from "./agent-pricing";
import { isGatewayCompletionWithoutChat } from "./completions";
import type { completionUsage } from "./pricing";
import {
  acpUsage,
  chatCompletions,
  localUsage,
  type CompletionPricingDetails,
} from "./schema";

/**
 * Owner usage reads (Convex `observability.usage`): Gateway completions, ACP turns and local CLI
 * usage, always through Chatroom privacy. Costs are historical operational estimates, never
 * billing. Times on the wire are ms since epoch.
 */

/** Rows aggregated per source; older rows in a busier window are dropped and flagged. */
const WINDOW_LIMIT = 2000;
/** Distinct Gateway client session ids resolved to an agent session per read. */
const SESSION_LOOKUP_LIMIT = 200;
/** Agent definitions read to match a ccusage source to its agent. */
const DEFINITIONS_LIMIT = 100;

/** Project buckets besides real Projects: unfiled sessions, Gateway calls with no chat. */
const NO_PROJECT = "none";
const OUTSIDE_CHATROOM = "outside";

type CompletionRow = typeof chatCompletions.$inferSelect;
type AcpUsageRow = typeof acpUsage.$inferSelect;
type LocalUsageRow = typeof localUsage.$inferSelect;

/**
 * Owner-visible Gateway completions of `workspace`, newest first. Reads `readLimit` rows, then
 * applies Chatroom privacy before callers count, truncate or aggregate: a row with a chat counts
 * only when `userId` may see that chat; a row without one only when it is Gateway traffic
 * (`isGatewayCompletionWithoutChat`). Also returns the visible chats it checked.
 */
async function completionsForWorkspace(
  db: Database,
  userId: string,
  workspace: string,
  since: number | undefined,
  readLimit: number,
  outputLimit = readLimit,
): Promise<{ completions: CompletionRow[]; chats: Map<string, Chat> }> {
  const rows = await db
    .select()
    .from(chatCompletions)
    .where(
      and(
        eq(chatCompletions.workspace, workspace),
        since !== undefined ? gte(chatCompletions.createdAt, new Date(since)) : undefined,
      ),
    )
    .orderBy(desc(chatCompletions.createdAt), desc(chatCompletions.id))
    .limit(readLimit);
  const chats = await visibleWorkspaceChats(
    db,
    userId,
    workspace,
    rows.flatMap((row) => (row.chat !== null ? [row.chat] : [])),
  );
  const visible = rows.filter((row) =>
    row.chat !== null ? chats.has(row.chat) : isGatewayCompletionWithoutChat(row),
  );
  return { completions: visible.slice(0, outputLimit), chats };
}

/** A completion's usage in the OpenAI shape (`completionUsage`). */
function completionUsageOf(row: CompletionRow): completionUsage {
  return {
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    completion_tokens_details: row.usageDetails.completion_tokens_details,
    prompt_tokens_details: row.usageDetails.prompt_tokens_details,
  };
}

/** One recent completion of {@link getUsage}. */
export type RecentCompletion = {
  id: string;
  createdAt: number;
  provider: string;
  byok: boolean;
  cost: number | null;
  usage: { prompt_tokens: number; completion_tokens: number };
};

/** Recent owner-visible usage estimates (Convex `getUsage`); not a balance or billing read. */
export async function getUsage(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  limit = 50,
): Promise<{
  completions: number;
  spentRecent: number;
  unknownCostRequests: number;
  recent: RecentCompletion[];
}> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { completions } = await completionsForWorkspace(
    db,
    userId,
    access.workspace.id,
    undefined,
    bounded * 2,
    bounded,
  );
  const recent = completions.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.getTime(),
    provider: row.provider,
    byok: row.byok,
    cost: row.cost,
    usage: { prompt_tokens: row.promptTokens, completion_tokens: row.completionTokens },
  }));
  return {
    completions: recent.length,
    spentRecent: recent.reduce((total, row) => total + (row.cost ?? 0), 0),
    unknownCostRequests: recent.filter((row) => row.cost === null).length,
    recent,
  };
}

/** One generation of {@link getGenerations}: request metadata, tokens, timings and cost. */
export type Generation = {
  id: string;
  createdAt: number;
  apiKey: { name: string; preview: string | null } | null;
  request: {
    provider: string;
    /** Null when the credential was removed or the row predates pools. */
    credentialName: string | null;
    byok: boolean;
    streamed: boolean;
    canceled: boolean;
    model: { id: string; name: string; slug: string } | null;
  };
  response: {
    genId: string;
    providerGenId: string;
    usage: completionUsage;
    pricing: CompletionPricingDetails & {
      cost: number | null;
      estimatedCost: number | null;
      reportedCost: number | null;
    };
    moderation_latency: number | null;
    ttft: number;
    gen_time: number;
    finish_reason: string;
    servedServiceTier: string | null;
  };
};

/** Per-generation usage metadata for the workspace owner (Convex `getGenerations`). */
export async function getGenerations(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  limit = 100,
): Promise<Generation[]> {
  const workspace = access.workspace.id;
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { completions } = await completionsForWorkspace(
    db,
    userId,
    workspace,
    undefined,
    bounded * 2,
    bounded,
  );
  const ids = (pick: (row: CompletionRow) => string | null) => [
    ...new Set(completions.flatMap((row) => (pick(row) !== null ? [pick(row)!] : []))),
  ];
  const modelIds = ids((row) => row.model);
  const keyIds = ids((row) => row.apiKey);
  const credentialIds = ids((row) => row.credential);
  const [modelRows, keyRows, credentialRows] = await Promise.all([
    modelIds.length
      ? db
          .select({ id: models.id, name: models.name, slug: models.slug })
          .from(models)
          .where(inArray(models.id, modelIds))
      : [],
    keyIds.length
      ? db
          .select({ id: apiKeys.id, name: apiKeys.name, preview: apiKeys.preview })
          .from(apiKeys)
          .where(and(eq(apiKeys.workspace, workspace), inArray(apiKeys.id, keyIds)))
      : [],
    credentialIds.length
      ? db
          .select({
            id: workspaceCredentials.id,
            label: workspaceCredentials.label,
            preview: workspaceCredentials.preview,
          })
          .from(workspaceCredentials)
          .where(
            and(
              eq(workspaceCredentials.workspace, workspace),
              inArray(workspaceCredentials.id, credentialIds),
            ),
          )
      : [],
  ]);
  const modelById = new Map(modelRows.map((row) => [row.id, row]));
  const keyById = new Map(keyRows.map((row) => [row.id, row]));
  const credentialById = new Map(credentialRows.map((row) => [row.id, row]));

  return completions.map((row) => {
    const key = row.apiKey !== null ? keyById.get(row.apiKey) : undefined;
    const credential = row.credential !== null ? credentialById.get(row.credential) : undefined;
    return {
      id: row.id,
      createdAt: row.createdAt.getTime(),
      apiKey: key ? { name: key.name, preview: key.preview } : null,
      request: {
        provider: row.provider,
        credentialName: credential ? credentialDisplayName(credential) : null,
        byok: row.byok,
        streamed: row.streamed,
        canceled: row.canceled,
        model: modelById.get(row.model) ?? null,
      },
      response: {
        genId: row.genId,
        providerGenId: row.providerGenId,
        usage: completionUsageOf(row),
        pricing: {
          ...row.pricingDetails,
          cost: row.cost,
          estimatedCost: row.estimatedCost,
          reportedCost: row.reportedCost,
        },
        moderation_latency: row.moderationLatency,
        ttft: row.ttft,
        gen_time: row.genTime,
        finish_reason: row.finishReason,
        servedServiceTier: row.servedServiceTier,
      },
    };
  });
}

/**
 * Totals shared by every breakdown row: `requests` are Gateway calls, `turns` ACP prompt turns
 * Radium priced, `sessions` distinct local CLI sessions (ccusage).
 */
export type UsageTotals = {
  requests: number;
  turns: number;
  sessions: number;
  tokens: number;
  cost: number;
};

/** One usage fact, already attributed to its harness, project and model. */
type Entry = {
  time: number;
  source: "gateway" | "agent" | "local";
  /** Local only: the session this model's tokens belong to, counted once per breakdown row. */
  session?: string;
  harness: string;
  project: string;
  model: string;
  cost: number | undefined;
  pending: boolean;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  writtenCacheTokens: number;
};

/** Breakdown accumulator; local sessions are a set so a multi-model, multi-day session counts once. */
class Breakdown {
  private readonly rows = new Map<string, Omit<UsageTotals, "sessions"> & { sessions: Set<string> }>();

  add(key: string, entry: Entry) {
    const totals = this.rows.get(key) ?? {
      requests: 0,
      turns: 0,
      sessions: new Set<string>(),
      tokens: 0,
      cost: 0,
    };
    if (entry.source === "gateway") totals.requests += 1;
    else if (entry.source === "agent") totals.turns += 1;
    else if (entry.session) totals.sessions.add(entry.session);
    totals.tokens += entry.promptTokens + entry.completionTokens;
    totals.cost += entry.cost ?? 0;
    this.rows.set(key, totals);
  }

  entries(): Array<[string, UsageTotals]> {
    return [...this.rows].map(([key, { sessions, ...totals }]) => [
      key,
      { ...totals, sessions: sessions.size },
    ]);
  }
}

/** A directory without trailing separators; the root keeps its own. */
function bareDirectory(directory: string) {
  return directory.replace(/[\\/]+$/, "") || directory;
}

/**
 * Matches an agent session's `cwd` to a Project folder on the same Worker. Agents report a
 * directory without its trailing separator while a Project folder may keep one, so neither counts.
 */
function folderKey(worker: string, directory: string) {
  return `${worker}\0${bareDirectory(directory)}`;
}

/**
 * The ACP agent a ccusage source belongs to, so a CLI's sessions share one harness row whether they
 * ran through Radium or not: a definition whose id is the source (`opencode`) or starts with it
 * (registry `claude-acp`, `codex-acp`), or whose command is that CLI.
 */
function agentForSource(
  definitions: Array<{ agentId: string; command: string }>,
  source: string,
) {
  return definitions.find(
    (definition) =>
      definition.agentId === source ||
      definition.agentId.startsWith(`${source}-`) ||
      definition.command.split(/[\\/]/).pop() === source,
  )?.agentId;
}

export type ActivityInput = {
  /** ms since epoch. */
  since: number;
  sources?: "all" | "gateway";
  /** A Project id, or `none` for unfiled usage. */
  project?: string;
};

export type ActivitySummary = {
  spend: number;
  gatewayCost: number;
  /** Agents: ACP turns and coding-CLI usage, wherever the session ran. */
  agentCost: number;
  unknownCostRequests: number;
  unknownCostTurns: number;
  pendingTurns: number;
  requests: number;
  agentTurns: number;
  localSessions: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  writtenCacheTokens: number;
};

export type ActivityDay = {
  /** UTC `YYYY-MM-DD`. */
  date: string;
  cost: number;
  gatewayCost: number;
  agentCost: number;
  requests: number;
  turns: number;
  /** Usage facts per model id. */
  models: Record<string, number>;
};

export type UsageActivity = {
  summary: ActivitySummary;
  daily: ActivityDay[];
  models: Array<{ id: string; name: string } & UsageTotals>;
  harnesses: Array<
    {
      id: string;
      kind: "radium" | "api" | "agent";
      agentId: string | null;
      name: string;
    } & UsageTotals
  >;
  projects: Array<
    { id: string; name: string; color: string | null; icon: string | null } & UsageTotals
  >;
  apiKeys: Array<{ id: string; name: string; requests: number; cost: number }>;
  usageTypes: {
    byok: { requests: number; cost: number };
    legacyCredits: { requests: number; cost: number };
  };
  truncated: boolean;
};

/** An agent session as attribution sees it: its visible chat, agent and Project. */
type AgentSession = { chat?: string; agentId?: string; project: string };

/**
 * Aggregated workspace usage for the owner only (Convex `getActivity`); members have no general
 * Gateway access. Gateway completions and, unless `sources` is `gateway`, agent usage (ACP turns
 * and coding-CLI usage ccusage reads on Workers, wherever the session ran), broken down by day,
 * model, harness (the built-in Radium agent, direct Gateway API clients, each agent) and Project
 * (current filing, or a CLI session's folder; `none` for unfiled sessions, `outside` for Gateway
 * calls without a chat).
 *
 * An ACP session's usage comes from its local rows once ccusage has read them and from Radium's
 * priced turns otherwise (`isTurnCovered`), per session, so CLIs ccusage cannot read still count
 * and nothing counts twice. Rows from chats the owner cannot see (other users' personal chats,
 * shared chats without them) are excluded. `project` narrows every figure.
 *
 * Every lookup is batched: the window's rows are read once per source, then the chats, sessions,
 * definitions, models, keys and Projects they name, each in one query.
 */
export async function getActivity(
  db: Database,
  access: WorkspaceAccess,
  userId: string,
  input: ActivityInput,
): Promise<UsageActivity> {
  const workspace = access.workspace.id;
  const includeAgents = input.sources !== "gateway";
  const since = new Date(input.since);

  // Read one beyond the response cap so the owner can see that this window was truncated.
  const [{ completions, chats: completionChats }, agentRows, localRows] = await Promise.all([
    completionsForWorkspace(db, userId, workspace, input.since, WINDOW_LIMIT + 1),
    includeAgents
      ? db
          .select()
          .from(acpUsage)
          .where(and(eq(acpUsage.workspace, workspace), gte(acpUsage.createdAt, since)))
          .orderBy(desc(acpUsage.createdAt), desc(acpUsage.id))
          .limit(WINDOW_LIMIT + 1)
      : ([] as AcpUsageRow[]),
    includeAgents
      ? db
          .select()
          .from(localUsage)
          .where(
            and(eq(localUsage.workspace, workspace), gte(localUsage.day, utcDay(input.since))),
          )
          .orderBy(desc(localUsage.day), desc(localUsage.createdAt), desc(localUsage.id))
          .limit(WINDOW_LIMIT + 1)
      : ([] as LocalUsageRow[]),
  ]);
  const truncated =
    completions.length > WINDOW_LIMIT ||
    agentRows.length > WINDOW_LIMIT ||
    localRows.length > WINDOW_LIMIT;
  const windowCompletions = completions.slice(0, WINDOW_LIMIT);
  const windowTurns = agentRows.slice(0, WINDOW_LIMIT);
  const windowLocal = localRows.slice(0, WINDOW_LIMIT);

  // Direct Gateway calls a coding agent tagged with its session id. They are exact, so for that
  // session and UTC day they replace the agent's own records (ccusage rows, turn reports).
  const gatewayDays = new Map<string, Set<string>>();
  for (const completion of windowCompletions) {
    if (completion.chat !== null || !completion.clientSession) continue;
    const days = gatewayDays.get(completion.clientSession) ?? new Set<string>();
    days.add(utcDay(completion.createdAt.getTime()));
    gatewayDays.set(completion.clientSession, days);
  }
  const viaGateway = (sessionId: string | undefined, day: string) =>
    !!sessionId && !!gatewayDays.get(sessionId)?.has(day);

  // A Gateway call with no Radium session may still match a terminal session ccusage read.
  const localSources = new Map<string, LocalUsageRow>();
  for (const row of windowLocal) localSources.set(row.sessionId, row);
  // Clients may send a fresh `prompt_cache_key` per call, so only the newest distinct ids are
  // looked up; ids a local row names are always looked up.
  const clientSessions = new Set<string>();
  let lookups = 0;
  for (const completion of windowCompletions) {
    const session = completion.clientSession;
    if (completion.chat !== null || !session) continue;
    if (
      clientSessions.has(session) ||
      localSources.has(session) ||
      lookups++ < SESSION_LOOKUP_LIMIT
    ) {
      clientSessions.add(session);
    }
  }
  const sessionIds = [
    ...new Set([
      ...windowLocal
        .filter((row) => !viaGateway(row.sessionId, row.day))
        .map((row) => row.sessionId),
      ...clientSessions,
    ]),
  ];

  const needsAgents = windowLocal.length > 0 || clientSessions.size > 0;
  const [bound, indexed, definitions, projects] = await Promise.all([
    acpSessionsBySessionId(db, workspace, sessionIds),
    agentSessionsBySessionId(db, workspace, sessionIds),
    needsAgents ? acpAgentDefinitions(db, workspace, DEFINITIONS_LIMIT) : [],
    listProjects(db, access, userId),
  ]);
  const group = <Row extends { sessionId: string }>(rows: Row[]) => {
    const bySession = new Map<string, Row[]>();
    for (const row of rows) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
    return bySession;
  };
  const boundBySession = group(bound);
  const indexedBySession = group(indexed);

  // Every chat a session or turn names, checked once with the access rule.
  const visibleChats = new Map(completionChats);
  const unchecked = new Set<string>();
  for (const row of [...bound, ...indexed]) if (row.chat) unchecked.add(row.chat);
  for (const turn of windowTurns) unchecked.add(turn.chat);
  for (const chat of completionChats.keys()) unchecked.delete(chat);
  for (const [id, chat] of await visibleWorkspaceChats(db, userId, workspace, unchecked)) {
    visibleChats.set(id, chat);
  }
  const turnSessions = await acpChatSessionIds(
    db,
    workspace,
    [...new Set(windowTurns.map((turn) => turn.chat))].filter((chat) => visibleChats.has(chat)),
  );

  const folders = new Map<string, string>();
  for (const project of projects) {
    for (const folder of project.folders ?? []) {
      const key = folderKey(folder.workerId, folder.directory);
      if (!folders.has(key)) folders.set(key, project.id);
    }
  }
  // Project filing is read from the chat now, so moving a chat moves its history too.
  const projectOf = (chat: string | null) =>
    chat === null ? OUTSIDE_CHATROOM : (visibleChats.get(chat)?.project ?? NO_PROJECT);

  // Each agent session resolves once: the Radium chat bound to it (hidden when the owner cannot
  // see that chat), else an indexed agent session whose folder is a Project folder. Local rows
  // know their Worker; Gateway calls carry only the session id.
  const agentSessions = new Map<string, AgentSession | null>();
  function resolveSession(sessionId: string, worker?: string): AgentSession | null {
    const key = `${worker ?? ""}\0${sessionId}`;
    const cached = agentSessions.get(key);
    if (cached !== undefined) return cached;
    const onWorker = (row: { worker: string }) => worker === undefined || row.worker === worker;
    const boundRow = boundBySession.get(sessionId)?.find(onWorker);
    const indexedRow = boundRow ? undefined : indexedBySession.get(sessionId)?.find(onWorker);
    const chat = boundRow?.chat ?? indexedRow?.chat ?? undefined;
    let resolved: AgentSession | null;
    if (chat) {
      resolved = visibleChats.has(chat)
        ? { chat, agentId: boundRow?.agentId ?? indexedRow?.agentId, project: projectOf(chat) }
        : null;
    } else {
      resolved = {
        ...(indexedRow ? { agentId: indexedRow.agentId } : {}),
        project:
          (indexedRow && folders.get(folderKey(indexedRow.worker, indexedRow.cwd))) || NO_PROJECT,
      };
    }
    agentSessions.set(key, resolved);
    return resolved;
  }

  function harnessOf(session: AgentSession, source?: string) {
    const agentId = session.agentId ?? (source ? agentForSource(definitions, source) : undefined);
    if (agentId) return `acp:${agentId}`;
    return source ? `local:${source}` : undefined;
  }

  const localByChat = new Map<string, Array<{ day: string; syncedAt: number }>>();
  const localEntries: Array<{ row: LocalUsageRow; session: AgentSession }> = [];
  for (const row of windowLocal) {
    if (viaGateway(row.sessionId, row.day)) continue;
    const session = resolveSession(row.sessionId, row.worker);
    if (!session) continue;
    localEntries.push({ row, session });
    if (session.chat) {
      localByChat.set(session.chat, [
        ...(localByChat.get(session.chat) ?? []),
        { day: row.day, syncedAt: row.syncedAt.getTime() },
      ]);
    }
  }

  // Radium's own turn reports count only where neither ccusage nor the Gateway has the session.
  const turns: AcpUsageRow[] = [];
  for (const turn of windowTurns) {
    const endedAt = turn.endedAt.getTime();
    if (isTurnCovered(localByChat.get(turn.chat) ?? [], endedAt)) continue;
    if (!visibleChats.has(turn.chat)) continue;
    if (viaGateway(turnSessions.get(turn.chat)?.sessionId, utcDay(endedAt))) continue;
    turns.push(turn);
  }

  // Gateway models group by their Radium model; agent usage joins them through a model slug.
  const slugs = new Set<string>();
  for (const turn of turns) if (turn.pricing.slug) slugs.add(turn.pricing.slug);
  for (const { row } of localEntries) {
    for (const usage of row.models) {
      const author = usage.model ? inferModelAuthor(usage.model, usage.model) : null;
      if (author) slugs.add(`${author.slug}/${usage.model}`);
    }
  }
  const gatewayModelIds = [...new Set(windowCompletions.map((row) => row.model))];
  const modelRows =
    gatewayModelIds.length || slugs.size
      ? await db
          .select({ id: models.id, name: models.name, slug: models.slug })
          .from(models)
          .where(
            or(
              gatewayModelIds.length ? inArray(models.id, gatewayModelIds) : undefined,
              slugs.size ? inArray(models.slug, [...slugs]) : undefined,
            ),
          )
      : [];
  const modelsById = new Map(modelRows.map((row) => [row.id, row]));
  const modelsBySlug = new Map(modelRows.map((row) => [row.slug, row]));
  const modelNames = new Map<string, string>();
  function slugModel(slug: string) {
    const radiumModel = modelsBySlug.get(slug);
    if (radiumModel) modelNames.set(radiumModel.id, radiumModel.name);
    return radiumModel?.id ?? `slug:${slug}`;
  }

  const entries: Entry[] = [];
  const keyTotals = new Breakdown();
  // Keep historical credit traffic separate from current BYOK estimates.
  const usageTypes = {
    byok: { requests: 0, cost: 0 },
    legacyCredits: { requests: 0, cost: 0 },
  };

  for (const completion of windowCompletions) {
    let project = projectOf(completion.chat);
    let harness = completion.chat !== null ? "radium" : "api";
    // An agent's Gateway calls join that agent's session: its harness row and Project.
    if (completion.chat === null && completion.clientSession) {
      const local = localSources.get(completion.clientSession);
      const session = clientSessions.has(completion.clientSession)
        ? resolveSession(completion.clientSession)
        : undefined;
      // The session's chat is hidden from the owner: its calls are hidden like its turns, not
      // shown as plain API traffic.
      if (session === null) continue;
      const agentHarness =
        session && (session.agentId || local) ? harnessOf(session, local?.agent) : undefined;
      if (session && agentHarness) {
        harness = agentHarness;
        project = session.project;
      }
    }
    if (input.project && project !== input.project) continue;

    const model = modelsById.get(completion.model);
    if (model) modelNames.set(model.id, model.name);
    const details = completion.usageDetails;
    const entry: Entry = {
      time: completion.createdAt.getTime(),
      source: "gateway",
      harness,
      project,
      model: completion.model,
      cost: completion.cost ?? undefined,
      pending: false,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      reasoningTokens: details.completion_tokens_details.reasoning_tokens ?? 0,
      cachedTokens: details.prompt_tokens_details.cached_tokens ?? 0,
      writtenCacheTokens: details.prompt_tokens_details.written_cache_tokens ?? 0,
    };
    entries.push(entry);
    keyTotals.add(completion.apiKey !== null ? `api:${completion.apiKey}` : "unattributed", entry);

    const usageType = completion.byok ? usageTypes.byok : usageTypes.legacyCredits;
    usageType.requests += 1;
    usageType.cost += completion.cost ?? 0;
  }

  for (const turn of turns) {
    const project = projectOf(turn.chat);
    if (input.project && project !== input.project) continue;

    const agentModel =
      turn.modelId !== null && turn.modelName !== null
        ? { id: turn.modelId, name: turn.modelName }
        : undefined;
    let model = `agent:${turn.agentId}:${agentModel ? modelKey(agentModel.id) : "unknown"}`;
    if (turn.pricing.slug) model = slugModel(turn.pricing.slug);
    if (!modelNames.has(model)) {
      modelNames.set(
        model,
        turn.pricing.modelName ?? (agentModel ? agentModelName(agentModel) : "Unknown model"),
      );
    }

    const tokens = turn.tokens ? normalizeAcpUsage(turn.tokens) : undefined;
    entries.push({
      time: turn.createdAt.getTime(),
      source: "agent",
      harness: `acp:${turn.agentId}`,
      project,
      model,
      cost: turn.pricing.cost,
      pending: turn.pricing.status === "pending",
      promptTokens: tokens?.prompt_tokens ?? 0,
      completionTokens: tokens?.completion_tokens ?? 0,
      reasoningTokens: tokens?.completion_tokens_details.reasoning_tokens ?? 0,
      cachedTokens: tokens?.prompt_tokens_details.cached_tokens ?? 0,
      writtenCacheTokens: tokens?.prompt_tokens_details.written_cache_tokens ?? 0,
    });
  }

  for (const { row, session } of localEntries) {
    const harness = harnessOf(session, row.agent)!;
    if (input.project && session.project !== input.project) continue;
    // ccusage's total also counts reasoning tokens its per-model rows leave out.
    const modelTokens = row.models.reduce(
      (sum, model) =>
        sum +
        model.inputTokens +
        model.outputTokens +
        model.cacheReadTokens +
        model.cacheCreationTokens,
      0,
    );
    const reasoning = Math.max(0, row.totalTokens - modelTokens);
    const rowModels = row.models.length
      ? row.models
      : [
          {
            model: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: undefined,
            estimatedCost: undefined,
          },
        ];

    for (const [index, usage] of rowModels.entries()) {
      const author = usage.model ? inferModelAuthor(usage.model, usage.model) : null;
      let model = `local:${usage.model ? modelKey(usage.model) : "unknown"}`;
      if (author) model = slugModel(`${author.slug}/${usage.model}`);
      if (!modelNames.has(model)) modelNames.set(model, usage.model || "Unknown model");

      const extra = index === 0 ? reasoning : 0;
      entries.push({
        time: Date.parse(`${row.day}T00:00:00Z`),
        source: "local",
        session: `${row.worker}\0${row.agent}\0${row.sessionId}`,
        harness,
        project: session.project,
        model,
        cost: usage.cost ?? usage.estimatedCost,
        // Still waiting for a models.dev lookup: shown as pricing, not unknown.
        pending:
          usage.cost === undefined && usage.estimatedCost === undefined && row.priceKey !== null,
        promptTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
        completionTokens: usage.outputTokens + extra,
        reasoningTokens: extra,
        cachedTokens: usage.cacheReadTokens,
        writtenCacheTokens: usage.cacheCreationTokens,
      });
    }
  }

  const summary: ActivitySummary = {
    spend: 0,
    gatewayCost: 0,
    agentCost: 0,
    unknownCostRequests: 0,
    unknownCostTurns: 0,
    pendingTurns: 0,
    requests: 0,
    agentTurns: 0,
    localSessions: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    writtenCacheTokens: 0,
  };
  const localSessionKeys = new Set<string>();
  const daily = new Map<string, ActivityDay>();
  const byModel = new Breakdown();
  const byHarness = new Breakdown();
  const byProject = new Breakdown();

  for (const entry of entries) {
    const cost = entry.cost ?? 0;
    summary.spend += cost;
    if (entry.source === "gateway") summary.gatewayCost += cost;
    else summary.agentCost += cost;

    if (entry.source === "gateway") {
      summary.requests += 1;
      if (entry.cost === undefined) summary.unknownCostRequests += 1;
    } else {
      if (entry.source === "agent") summary.agentTurns += 1;
      else if (entry.session) localSessionKeys.add(entry.session);
      if (entry.pending) summary.pendingTurns += 1;
      else if (entry.cost === undefined) summary.unknownCostTurns += 1;
    }
    summary.promptTokens += entry.promptTokens;
    summary.completionTokens += entry.completionTokens;
    summary.reasoningTokens += entry.reasoningTokens;
    summary.cachedTokens += entry.cachedTokens;
    summary.writtenCacheTokens += entry.writtenCacheTokens;

    const date = new Date(entry.time).toISOString().slice(0, 10);
    const day = daily.get(date) ?? {
      date,
      cost: 0,
      gatewayCost: 0,
      agentCost: 0,
      requests: 0,
      turns: 0,
      models: {},
    };
    day.cost += cost;
    if (entry.source === "gateway") {
      day.gatewayCost += cost;
      day.requests += 1;
    } else {
      day.agentCost += cost;
      if (entry.source === "agent") day.turns += 1;
    }
    day.models[entry.model] = (day.models[entry.model] ?? 0) + 1;
    daily.set(date, day);

    byModel.add(entry.model, entry);
    byHarness.add(entry.harness, entry);
    byProject.add(entry.project, entry);
  }
  summary.localSessions = localSessionKeys.size;

  const topModels = byModel
    .entries()
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 10);
  const topKeys = keyTotals
    .entries()
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 5);
  const harnessTotals = byHarness.entries();

  const topKeyIds = topKeys.flatMap(([id]) => (id.startsWith("api:") ? [id.slice(4)] : []));
  const agentIds = harnessTotals.flatMap(([id]) =>
    id.startsWith("acp:") ? [id.slice("acp:".length)] : [],
  );
  const [keyRows, agentNames] = await Promise.all([
    topKeyIds.length
      ? db
          .select({ id: apiKeys.id, name: apiKeys.name })
          .from(apiKeys)
          .where(and(eq(apiKeys.workspace, workspace), inArray(apiKeys.id, topKeyIds)))
      : [],
    acpAgentNames(db, workspace, agentIds),
  ]);
  const keyNames = new Map(keyRows.map((row) => [`api:${row.id}`, row.name]));

  const harnesses = harnessTotals.map(([id, totals]) => {
    let kind: "radium" | "api" | "agent" = id === "radium" ? "radium" : "api";
    let name = id === "radium" ? "Radium agent" : "Gateway API";
    let agentId: string | null = null;
    if (id.startsWith("acp:")) {
      kind = "agent";
      agentId = id.slice("acp:".length);
      name = agentNames.get(agentId) ?? agentId;
    } else if (id.startsWith("local:")) {
      // A CLI no ACP agent definition matches.
      kind = "agent";
      name = localAgentName(id.slice("local:".length));
    }
    return { id, kind, agentId, name, ...totals };
  });

  const projectById = new Map(projects.map((project) => [project.id as string, project]));
  const projectNames: Record<string, string> = {
    [NO_PROJECT]: "No project",
    [OUTSIDE_CHATROOM]: "Outside Chatroom",
  };
  const projectRows = byProject.entries().map(([id, totals]) => {
    const project = projectById.get(id);
    return {
      id,
      name: projectNames[id] ?? project?.name ?? "Deleted project",
      color: project?.color ?? null,
      icon: project?.icon ?? null,
      ...totals,
    };
  });

  return {
    summary,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: topModels
      .map(([id, totals]) => ({ id, name: modelNames.get(id) ?? "Unknown model", ...totals }))
      .sort((a, b) => b.tokens - a.tokens),
    harnesses: harnesses.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    projects: projectRows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    apiKeys: topKeys
      .map(([id, totals]) => ({
        id,
        name: id === "unattributed" ? "Radium Chatroom" : (keyNames.get(id) ?? "Deleted key"),
        requests: totals.requests,
        cost: totals.cost,
      }))
      .sort((a, b) => b.requests - a.requests),
    usageTypes,
    truncated,
  };
}
