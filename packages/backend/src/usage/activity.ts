import { v } from "convex/values";
import { query, type QueryCtx } from "../../convex/_generated/server";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  filterVisibleCompletions,
  isChatVisibleToWorkspace,
  type AttributedCompletion,
} from "../../convex/chatroom";
import { requireOwnedWorkspace } from "../../convex/workspaces";
import { folderKey, projectFolders } from "../acp/browser";
import { inferModelAuthor, modelKey } from "../acp/models";
import { agentModelName, normalizeAcpUsage } from "./agent_usage";
import { isTurnCovered, localAgentName, utcDay } from "./local_contract";

/** Rows aggregated per source; older rows in a busier window are dropped and flagged. */
const WINDOW_LIMIT = 2000;

/**
 * Owner-visible Gateway completions, newest first. Reads `readLimit` rows from each ownership
 * index, then applies Chatroom privacy before callers count, truncate or aggregate.
 */
export async function completionsForWorkspace(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  since?: number,
  readLimit = 200,
  outputLimit = readLimit,
) {
  // Keep the legacy index in the read path until ownership backfill verification is complete.
  const current =
    since !== undefined
      ? await ctx.db
          .query("chat_completions")
          .withIndex("by_workspace", (q) =>
            q.eq("bill.workspace", workspace._id).gte("_creationTime", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("chat_completions")
          .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace._id))
          .order("desc")
          .take(readLimit);

  const legacy = workspace.legacyBalance
    ? since !== undefined
      ? await ctx.db
          .query("chat_completions")
          .withIndex("by_balance", (q) =>
            q.eq("bill.balance", workspace.legacyBalance!).gte("_creationTime", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("chat_completions")
          .withIndex("by_balance", (q) => q.eq("bill.balance", workspace.legacyBalance!))
          .order("desc")
          .take(readLimit)
    : [];
  // Migrated rows can match both indexes; deduplicate before applying private-chat visibility.
  const byId = new Map(current.map((completion) => [completion._id, completion]));
  for (const completion of legacy) byId.set(completion._id, completion);
  const visible = await filterVisibleCompletions(ctx, workspace, [
    ...byId.values(),
  ] as AttributedCompletion[]);
  return visible.sort((a, b) => b._creationTime - a._creationTime).slice(0, outputLimit);
}

/**
 * Totals shared by every breakdown row: `requests` are Gateway calls, `turns` ACP prompt turns
 * Radium priced, `sessions` distinct local CLI sessions (ccusage).
 */
type Totals = { requests: number; turns: number; sessions: number; tokens: number; cost: number };

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
  private readonly rows = new Map<string, Omit<Totals, "sessions"> & { sessions: Set<string> }>();

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

  entries(): Array<[string, Totals]> {
    return [...this.rows].map(([key, { sessions, ...totals }]) => [
      key,
      { ...totals, sessions: sessions.size },
    ]);
  }
}

/** Project buckets besides real Projects: unfiled sessions, Gateway calls with no chat. */
const NO_PROJECT = "none";
const OUTSIDE_CHATROOM = "outside";

/**
 * The ACP agent a ccusage source belongs to, so a CLI's sessions share one harness row whether they
 * ran through Radium or not: a definition whose id is the source (`opencode`) or starts with it
 * (registry `claude-acp`, `codex-acp`), or whose command is that CLI.
 */
function agentForSource(definitions: Doc<"acp_agents">[], source: string) {
  return definitions.find(
    (definition) =>
      definition.agentId === source ||
      definition.agentId.startsWith(`${source}-`) ||
      definition.command.split(/[\\/]/).pop() === source,
  )?.agentId;
}

/**
 * Aggregated workspace usage for the owner only; members have no general Gateway access. Gateway
 * completions and, unless `sources` is `gateway`, agent usage (ACP turns and coding-CLI usage
 * ccusage reads on Workers, wherever the session ran), broken down by day, model, harness (the
 * built-in Radium agent, direct Gateway API clients, each agent) and Project (current filing, or a
 * CLI session's folder; `none` for unfiled sessions, `outside` for Gateway calls without a chat).
 *
 * An ACP session's usage comes from its local rows once ccusage has read them and from Radium's
 * priced turns otherwise (`isTurnCovered`), per session, so CLIs ccusage cannot read still count
 * and nothing counts twice. Rows from other users' private chats are excluded. `project` narrows
 * every figure. Costs are historical estimates, never billing.
 */
export const getActivity = query({
  args: {
    workspace: v.id("workspaces"),
    since: v.number(),
    sources: v.optional(v.union(v.literal("all"), v.literal("gateway"))),
    project: v.optional(v.union(v.id("projects"), v.literal(NO_PROJECT))),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const includeAgents = args.sources !== "gateway";

    // Read one beyond the response cap so the owner can see that this window was truncated.
    const completions = await completionsForWorkspace(ctx, workspace, args.since, WINDOW_LIMIT + 1);
    const agentRows = includeAgents
      ? await ctx.db
          .query("acp_usage")
          .withIndex("by_workspace", (q) =>
            q.eq("workspace", workspace._id).gte("_creationTime", args.since),
          )
          .order("desc")
          .take(WINDOW_LIMIT + 1)
      : [];
    const localRows = includeAgents
      ? await ctx.db
          .query("local_usage")
          .withIndex("by_workspace_and_day", (q) =>
            q.eq("workspace", workspace._id).gte("day", utcDay(args.since)),
          )
          .order("desc")
          .take(WINDOW_LIMIT + 1)
      : [];
    const truncated =
      completions.length > WINDOW_LIMIT ||
      agentRows.length > WINDOW_LIMIT ||
      localRows.length > WINDOW_LIMIT;

    const visibility = new Map<string, boolean>();
    const chats = new Map<Id<"aisdk_chats">, Doc<"aisdk_chats"> | null>();
    // Project filing is read from the chat now, so moving a chat moves its history too.
    async function projectOf(chatId: Id<"aisdk_chats"> | undefined) {
      if (!chatId) return OUTSIDE_CHATROOM;
      if (!chats.has(chatId)) chats.set(chatId, await ctx.db.get(chatId));
      return chats.get(chatId)?.project ?? NO_PROJECT;
    }

    // Each local session resolves once: the Radium chat bound to it (hidden when that chat is
    // private to someone else), else an indexed agent session whose folder is a Project folder.
    type LocalSession = { chat?: Id<"aisdk_chats">; agentId?: string; project: string };
    const localSessions = new Map<string, LocalSession | null>();
    let folders: Map<string, Id<"projects">> | undefined;
    async function resolveLocalSession(worker: string, sessionId: string) {
      const key = `${worker}\0${sessionId}`;
      if (localSessions.has(key)) return localSessions.get(key)!;
      let resolved: LocalSession | null;
      const bound = await ctx.db
        .query("acp_sessions")
        .withIndex("by_worker_and_sessionId", (q) =>
          q.eq("workspace", workspace._id).eq("worker", worker).eq("sessionId", sessionId),
        )
        .first();
      const indexed = bound
        ? null
        : await ctx.db
            .query("acp_agent_sessions")
            .withIndex("by_worker_and_sessionId", (q) =>
              q.eq("workspace", workspace._id).eq("worker", worker).eq("sessionId", sessionId),
            )
            .first();
      const chat = bound?.chat ?? indexed?.chat;
      if (chat) {
        resolved = (await isChatVisibleToWorkspace(ctx, workspace._id, chat, visibility))
          ? { chat, agentId: bound?.agentId ?? indexed?.agentId, project: await projectOf(chat) }
          : null;
      } else {
        folders ??= await projectFolders(ctx, workspace._id);
        resolved = {
          ...(indexed ? { agentId: indexed.agentId } : {}),
          project: (indexed && folders.get(folderKey(worker, indexed.cwd))) || NO_PROJECT,
        };
      }
      localSessions.set(key, resolved);
      return resolved;
    }

    const localByChat = new Map<Id<"aisdk_chats">, Doc<"local_usage">[]>();
    const localEntries: Array<{ row: Doc<"local_usage">; session: LocalSession }> = [];
    for (const row of localRows.slice(0, WINDOW_LIMIT)) {
      const session = await resolveLocalSession(row.worker, row.sessionId);
      if (!session) continue;
      localEntries.push({ row, session });
      if (session.chat)
        localByChat.set(session.chat, [...(localByChat.get(session.chat) ?? []), row]);
    }

    // Radium's own turn reports count only where ccusage has not read the session yet.
    const turns: Doc<"acp_usage">[] = [];
    for (const turn of agentRows.slice(0, WINDOW_LIMIT)) {
      if (isTurnCovered(localByChat.get(turn.chat) ?? [], turn.endedAt)) continue;
      if (await isChatVisibleToWorkspace(ctx, workspace._id, turn.chat, visibility))
        turns.push(turn);
    }

    // Gateway models group by their Radium model; agent usage joins them through a model slug.
    const gatewayModels = new Map<Id<"models">, Doc<"models"> | null>();
    const modelsBySlug = new Map<string, Doc<"models"> | null>();
    const modelNames = new Map<string, string>();
    async function slugModel(slug: string) {
      if (!modelsBySlug.has(slug)) {
        const found = await ctx.db
          .query("models")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .first();
        modelsBySlug.set(slug, found);
      }
      const radiumModel = modelsBySlug.get(slug);
      if (radiumModel) modelNames.set(radiumModel._id, radiumModel.name);
      return radiumModel?._id ?? `slug:${slug}`;
    }

    const entries: Entry[] = [];
    const keyTotals = new Breakdown();
    // Keep historical credit traffic separate from current BYOK estimates.
    const usageTypes = {
      byok: { requests: 0, cost: 0 },
      legacyCredits: { requests: 0, cost: 0 },
    };

    for (const completion of completions.slice(0, WINDOW_LIMIT)) {
      const project = await projectOf(completion.chatId);
      if (args.project && project !== args.project) continue;

      const { usage, pricing } = completion.response;
      const modelId = completion.request.model;
      if (!gatewayModels.has(modelId)) gatewayModels.set(modelId, await ctx.db.get(modelId));
      const model = gatewayModels.get(modelId);
      if (model) modelNames.set(model._id, model.name);

      const entry: Entry = {
        time: completion._creationTime,
        source: "gateway",
        harness: completion.chatId ? "radium" : "api",
        project,
        model: modelId,
        cost: pricing.cost,
        pending: false,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details.reasoning_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details.cached_tokens ?? 0,
        writtenCacheTokens: usage.prompt_tokens_details.written_cache_tokens ?? 0,
      };
      entries.push(entry);

      let keyId = "unattributed";
      if (completion.bill.apiKey) keyId = `api:${completion.bill.apiKey}`;
      else if (completion.bill.key) keyId = `legacy:${completion.bill.key}`;
      keyTotals.add(keyId, entry);

      const usageType = completion.request.byok ? usageTypes.byok : usageTypes.legacyCredits;
      usageType.requests += 1;
      usageType.cost += pricing.cost ?? 0;
    }

    for (const turn of turns) {
      const project = await projectOf(turn.chat);
      if (args.project && project !== args.project) continue;

      let model = `agent:${turn.agentId}:${turn.model ? modelKey(turn.model.id) : "unknown"}`;
      if (turn.pricing.slug) model = await slugModel(turn.pricing.slug);
      if (!modelNames.has(model)) {
        modelNames.set(
          model,
          turn.pricing.modelName ?? (turn.model ? agentModelName(turn.model) : "Unknown model"),
        );
      }

      const tokens = turn.tokens ? normalizeAcpUsage(turn.tokens) : undefined;
      entries.push({
        time: turn._creationTime,
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

    const definitions = localEntries.length
      ? await ctx.db
          .query("acp_agents")
          .withIndex("by_workspace_and_agentId", (q) => q.eq("workspace", workspace._id))
          .take(100)
      : [];
    for (const { row, session } of localEntries) {
      const agentId = session.agentId ?? agentForSource(definitions, row.agent);
      if (args.project && session.project !== args.project) continue;
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
      const models = row.models.length
        ? row.models
        : [
            {
              model: "",
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              cost: undefined,
            },
          ];

      for (const [index, usage] of models.entries()) {
        const author = usage.model ? inferModelAuthor(usage.model, usage.model) : null;
        let model = `local:${usage.model ? modelKey(usage.model) : "unknown"}`;
        if (author) model = await slugModel(`${author.slug}/${usage.model}`);
        if (!modelNames.has(model)) modelNames.set(model, usage.model || "Unknown model");

        const extra = index === 0 ? reasoning : 0;
        entries.push({
          time: Date.parse(`${row.day}T00:00:00Z`),
          source: "local",
          session: `${row.worker}\0${row.agent}\0${row.sessionId}`,
          harness: agentId ? `acp:${agentId}` : `local:${row.agent}`,
          project: session.project,
          model,
          cost: usage.cost ?? usage.estimatedCost,
          // Still waiting for a models.dev lookup: shown as pricing, not unknown.
          pending: usage.cost === undefined && usage.estimatedCost === undefined && !!row.priceKey,
          promptTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
          completionTokens: usage.outputTokens + extra,
          reasoningTokens: extra,
          cachedTokens: usage.cacheReadTokens,
          writtenCacheTokens: usage.cacheCreationTokens,
        });
      }
    }

    const summary = {
      spend: 0,
      gatewayCost: 0,
      /** Agents: ACP turns and coding-CLI usage, wherever the session ran. */
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
    const daily = new Map<
      string,
      {
        date: string;
        cost: number;
        gatewayCost: number;
        agentCost: number;
        requests: number;
        turns: number;
        models: Record<string, number>;
      }
    >();
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

    const keyNames = new Map<string, string>();
    for (const [id] of topKeys) {
      if (id.startsWith("legacy:")) {
        const key = await ctx.db.get("keys", id.slice("legacy:".length) as Id<"keys">);
        if (key) keyNames.set(id, key.name);
      } else if (id.startsWith("api:")) {
        const key = await ctx.db.get("api_keys", id.slice("api:".length) as Id<"api_keys">);
        if (key) keyNames.set(id, key.name);
      }
    }

    const harnesses = [];
    for (const [id, totals] of byHarness.entries()) {
      let kind: "radium" | "api" | "agent" = id === "radium" ? "radium" : "api";
      let name = id === "radium" ? "Radium agent" : "Gateway API";
      let agentId: string | undefined;
      if (id.startsWith("acp:")) {
        kind = "agent";
        agentId = id.slice("acp:".length);
        const definition = await ctx.db
          .query("acp_agents")
          .withIndex("by_workspace_and_agentId", (q) =>
            q.eq("workspace", workspace._id).eq("agentId", agentId!),
          )
          .first();
        name = definition?.name ?? agentId;
      } else if (id.startsWith("local:")) {
        // A CLI no ACP agent definition matches.
        kind = "agent";
        name = localAgentName(id.slice("local:".length));
      }
      harnesses.push({ id, kind, ...(agentId ? { agentId } : {}), name, ...totals });
    }

    const projectNames: Record<string, string> = {
      [NO_PROJECT]: "No project",
      [OUTSIDE_CHATROOM]: "Outside Chatroom",
    };
    const projects = [];
    for (const [id, totals] of byProject.entries()) {
      let name = projectNames[id];
      let color: string | undefined;
      let icon: string | undefined;
      if (name === undefined) {
        const project = await ctx.db.get(id as Id<"projects">);
        name = project?.name ?? "Deleted project";
        color = project?.color;
        icon = project?.icon;
      }
      projects.push({
        id,
        name,
        ...(color ? { color } : {}),
        ...(icon ? { icon } : {}),
        ...totals,
      });
    }

    return {
      summary,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: topModels
        .map(([id, totals]) => ({ id, name: modelNames.get(id) ?? "Unknown model", ...totals }))
        .sort((a, b) => b.tokens - a.tokens),
      harnesses: harnesses.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      projects: projects.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
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
  },
});
