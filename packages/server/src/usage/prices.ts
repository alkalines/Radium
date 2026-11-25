import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { MODELS_DEV_API_URL, type ModelsDevApi } from "contracts/models_dev";
import type { StoredLocalUsageModel } from "contracts/usage/local_contract";
import type { ProviderPricing } from "contracts/workspaces/provider";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { isWorkspaceProviderEnabled, workspaceProviderRecords } from "../gateway/providers";
import { dispatchJobs, enqueueJob } from "../jobs/outbox";
import type { Runtime } from "../runtime";
import {
  matchModelsDev,
  normalizeAcpUsage,
  workspaceQuote,
  type AgentModel,
  type WorkspaceProviderModels,
} from "./agent-pricing";
import { estimateCompletionCost } from "./pricing";
import {
  acpModelPrices,
  acpUsage,
  localUsage,
  type AgentTurnPricing,
  type ModelsDevMatch,
} from "./schema";

/**
 * Pricing of agent usage that Radium did not see as Gateway traffic: ACP turns (`acp_usage`) and
 * the models ccusage could not price in local CLI rows (`local_usage`). Rates come from the
 * workspace's enabled providers, else from a cached models.dev match (`acp_model_prices`). A
 * model never looked up holds its usage as `pending` until the `usage:prices` task fetches the
 * catalogue once for every queued model and releases the waiting rows. Estimates, never charges.
 */

/** Outbox job: price one recorded ACP turn (`payload: { turn }`). */
export const PRICE_TURN_JOB = "usage.priceTurn";
/** Outbox job: price the unpriced models of one local usage row (`payload: { row }`). */
export const PRICE_LOCAL_ROW_JOB = "usage.priceLocalRow";
/** Outbox job: price the turns and rows that waited for one model's lookup (`payload: { priceKey }`). */
export const REPRICE_PENDING_JOB = "usage.repricePending";

/** A matched models.dev price is refreshed weekly; a failed or empty lookup is retried daily. */
const MATCH_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const NO_MATCH_RETRY_MS = 24 * 60 * 60 * 1000;
/** Queued model choices matched per store transaction, and batches per task run. */
const RESOLVE_BATCH = 50;
const RESOLVE_BATCHES_PER_RUN = 20;
/** Waiting turns or rows repriced per transaction. */
const REPRICE_BATCH = 100;
const MODELS_DEV_TIMEOUT_MS = 20_000;

type AcpUsageRow = typeof acpUsage.$inferSelect;
type LocalUsageRow = typeof localUsage.$inferSelect;
type PriceRow = typeof acpModelPrices.$inferSelect;

/** Rates found for one agent model choice, and where they came from. */
type ResolvedQuote = {
  provider: string;
  slug: string;
  pricing: ProviderPricing;
  source: NonNullable<AgentTurnPricing["source"]>;
  modelName?: string;
};

/**
 * Rates for agent model choices within one transaction, cached per workspace and model.
 * Workspace provider rates win (the owner's configured Radium models); a model Radium does not
 * define uses its cached models.dev match. A model never looked up yet is queued for one lookup
 * and resolves as `pending` with the `acp_model_prices` id its usage waits under; matches past
 * their refresh age are queued again in the background. `agentKey` is the ACP agent id, or
 * `local:<ccusage source>` for local CLI rows.
 */
function quoteResolver(tx: Database, now: number) {
  const providers = new Map<string, WorkspaceProviderModels>();
  const prices = new Map<string, PriceRow>();

  const priceRow = async (workspace: string, agentKey: string, model: string) =>
    (
      await tx
        .select()
        .from(acpModelPrices)
        .where(
          and(
            eq(acpModelPrices.workspace, workspace),
            eq(acpModelPrices.agentId, agentKey),
            eq(acpModelPrices.model, model),
          ),
        )
    )[0];

  async function resolve(
    workspace: string,
    agentKey: string,
    model: AgentModel,
  ): Promise<ResolvedQuote | { pending: string } | undefined> {
    const cacheKey = `${workspace}\0${agentKey}\0${model.id}`;
    let price = prices.get(cacheKey) ?? (await priceRow(workspace, agentKey, model.id));

    // A choice whose name or description changed (a `default` alias now pointing elsewhere)
    // drops its match, so neither the routing hint nor the price below comes from the old model,
    // and is looked up again.
    if (
      price &&
      (price.name !== model.name || (price.description ?? "") !== (model.description ?? ""))
    ) {
      const [updated] = await tx
        .update(acpModelPrices)
        .set({
          name: model.name,
          description: model.description || null,
          match: null,
          checkedAt: null,
          queued: true,
        })
        .where(eq(acpModelPrices.id, price.id))
        .returning();
      price = updated ?? price;
      prices.set(cacheKey, price);
    }

    let workspaceProviders = providers.get(workspace);
    if (!workspaceProviders) {
      workspaceProviders = (await workspaceProviderRecords(tx, workspace))
        .filter(isWorkspaceProviderEnabled)
        .map((record) => ({ slug: record.provider.slug, models: record.provider.models }));
      providers.set(workspace, workspaceProviders);
    }
    const configured = workspaceQuote(workspaceProviders, model, agentKey, price?.match?.slug);
    if (configured) return { ...configured, source: "workspace", modelName: price?.match?.name };

    // A model Radium does not price is looked up on models.dev once, then refreshed in the
    // background; only its first lookup holds usage back.
    const retryAfter = price?.match ? MATCH_REFRESH_MS : NO_MATCH_RETRY_MS;
    if (!price) {
      // Concurrent pricing of the same new model inserts one row; the other reads it.
      const [inserted] = await tx
        .insert(acpModelPrices)
        .values({
          workspace,
          agentId: agentKey,
          model: model.id,
          name: model.name,
          description: model.description || null,
          queued: true,
        })
        .onConflictDoNothing({
          target: [acpModelPrices.workspace, acpModelPrices.agentId, acpModelPrices.model],
        })
        .returning();
      price = inserted ?? (await priceRow(workspace, agentKey, model.id))!;
    } else if (
      !price.queued &&
      price.checkedAt !== null &&
      now - price.checkedAt.getTime() > retryAfter
    ) {
      await tx
        .update(acpModelPrices)
        .set({ queued: true })
        .where(eq(acpModelPrices.id, price.id));
      price = { ...price, queued: true };
    }
    prices.set(cacheKey, price);

    if (price.match) return { ...price.match, source: "models.dev", modelName: price.match.name };
    if (price.checkedAt === null) return { pending: price.id };
    return undefined;
  }

  return { resolve };
}

/**
 * Price pending turns (`quoteResolver`). The list-price estimate wins over the cost the agent
 * reports: subscription and subsidized plans report 0 or a discounted figure, while owners compare
 * harnesses at API rates. A USD agent cost fills in only when no estimate is possible; other
 * currencies are kept but never converted. The caller holds the turns' row locks.
 */
async function priceTurns(tx: Database, turns: AcpUsageRow[], now: number) {
  const resolver = quoteResolver(tx, now);
  for (const turn of turns) {
    if (turn.pricing.status !== "pending") continue;
    const model: AgentModel | undefined =
      turn.modelId !== null && turn.modelName !== null
        ? {
            id: turn.modelId,
            name: turn.modelName,
            ...(turn.modelDescription ? { description: turn.modelDescription } : {}),
          }
        : undefined;
    const resolved = model ? await resolver.resolve(turn.workspace, turn.agentId, model) : undefined;
    if (resolved && "pending" in resolved) {
      await tx.update(acpUsage).set({ priceKey: resolved.pending }).where(eq(acpUsage.id, turn.id));
      continue;
    }

    const reportedCost =
      turn.agentCostCurrency?.toUpperCase() === "USD" && turn.agentCostAmount !== null
        ? turn.agentCostAmount
        : undefined;
    const estimatedCost =
      turn.tokens && resolved
        ? estimateCompletionCost(normalizeAcpUsage(turn.tokens), resolved.pricing).estimatedCost
        : undefined;
    const cost = estimatedCost ?? reportedCost;
    const pricing: AgentTurnPricing = {
      status: cost === undefined ? "unknown" : "priced",
      ...(resolved
        ? { source: resolved.source, provider: resolved.provider, slug: resolved.slug }
        : {}),
      ...(resolved?.modelName ? { modelName: resolved.modelName } : {}),
      ...(estimatedCost !== undefined ? { estimatedCost } : {}),
      ...(reportedCost !== undefined ? { reportedCost } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
    await tx.update(acpUsage).set({ priceKey: null, pricing }).where(eq(acpUsage.id, turn.id));
  }
}

/**
 * Fill the costs ccusage could not price in local rows: the same rates as ACP turns, keyed by
 * `local:<source>`. ccusage drops the provider from model ids, so the source is tried as the
 * routing provider first (`opencode/glm-5.3-flash-free` is an OpenCode Zen model on models.dev).
 * ccusage's own costs are never replaced. The caller holds the rows' locks, so a concurrent
 * report never loses its models to an older pricing read.
 */
async function priceLocalRows(tx: Database, rows: LocalUsageRow[], now: number) {
  const resolver = quoteResolver(tx, now);
  for (const row of rows) {
    let priceKey: string | null = null;
    const models: StoredLocalUsageModel[] = [];
    for (const usage of row.models) {
      if (usage.cost !== undefined) {
        models.push(usage);
        continue;
      }
      const resolved = await resolver.resolve(row.workspace, `local:${row.agent}`, {
        id: `${row.agent}/${usage.model}`,
        name: usage.model,
      });
      if (resolved && "pending" in resolved) {
        priceKey = resolved.pending;
        models.push(usage);
        continue;
      }
      const estimatedCost = resolved
        ? estimateCompletionCost(
            {
              prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
              completion_tokens: usage.outputTokens,
              completion_tokens_details: {},
              prompt_tokens_details: {
                cached_tokens: usage.cacheReadTokens,
                written_cache_tokens: usage.cacheCreationTokens,
              },
            },
            resolved.pricing,
          ).estimatedCost
        : undefined;
      models.push(estimatedCost === undefined ? usage : { ...usage, estimatedCost });
    }
    await tx.update(localUsage).set({ models, priceKey }).where(eq(localUsage.id, row.id));
  }
}

const turnPayload = z.object({ turn: z.string() });
const rowPayload = z.object({ row: z.string() });
const priceKeyPayload = z.object({ priceKey: z.string() });

/** Outbox handler of {@link PRICE_TURN_JOB}: prices one recorded turn. */
export async function runPriceTurnJob(runtime: Runtime, payload: unknown) {
  const { turn } = turnPayload.parse(payload);
  await runtime.drivers.db.transaction(async (tx) => {
    const turns = await tx.select().from(acpUsage).where(eq(acpUsage.id, turn)).for("update");
    await priceTurns(tx, turns, Date.now());
  });
}

/** Outbox handler of {@link PRICE_LOCAL_ROW_JOB}: prices the unpriced models of one local row. */
export async function runPriceLocalRowJob(runtime: Runtime, payload: unknown) {
  const { row } = rowPayload.parse(payload);
  await runtime.drivers.db.transaction(async (tx) => {
    const rows = await tx.select().from(localUsage).where(eq(localUsage.id, row)).for("update");
    await priceLocalRows(tx, rows, Date.now());
  });
}

/**
 * Outbox handler of {@link REPRICE_PENDING_JOB}: the turns and local rows that waited for one
 * model's first lookup, in bounded transactions walking each table once by id.
 */
export async function runRepricePendingJob(runtime: Runtime, payload: unknown) {
  const { priceKey } = priceKeyPayload.parse(payload);
  const { db } = runtime.drivers;
  for (let after = ""; ; ) {
    const turns = await db.transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(acpUsage)
        .where(and(eq(acpUsage.priceKey, priceKey), gt(acpUsage.id, after)))
        .orderBy(asc(acpUsage.id))
        .limit(REPRICE_BATCH)
        .for("update");
      await priceTurns(tx, batch, Date.now());
      return batch;
    });
    if (turns.length < REPRICE_BATCH) break;
    after = turns.at(-1)!.id;
  }
  for (let after = ""; ; ) {
    const rows = await db.transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(localUsage)
        .where(and(eq(localUsage.priceKey, priceKey), gt(localUsage.id, after)))
        .orderBy(asc(localUsage.id))
        .limit(REPRICE_BATCH)
        .for("update");
      await priceLocalRows(tx, batch, Date.now());
      return batch;
    });
    if (rows.length < REPRICE_BATCH) break;
    after = rows.at(-1)!.id;
  }
}

/** The models.dev catalogue through `runtime.fetch`, or `null` when it cannot be read. */
async function fetchModelsDev(fetchFn: typeof fetch): Promise<ModelsDevApi | null> {
  try {
    const response = await fetchFn(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("models.dev answered with an error");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("models.dev answered with an unexpected body");
    }
    return body as ModelsDevApi;
  } catch {
    console.error("usage.models_dev_unavailable");
    return null;
  }
}

/** One queued model choice's lookup result. */
export type ModelPriceResult = {
  id: string;
  /** The name and description the lookup matched; a row changed since keeps its queue place. */
  name: string;
  description: string | null;
  /** Whether the catalogue was read; a failed read keeps the previous match. */
  fetched: boolean;
  match: ModelsDevMatch | null;
};

/**
 * Store lookup results and queue the release of the turns and local rows that waited for them.
 * A failed fetch keeps the previous match (stale rates beat none); the row is retried after a
 * day. A row whose name or description changed after it was read is left queued for the next
 * run, so a match is never stored for the wrong model.
 *
 * @returns the queued reprice job ids, for `dispatchJobs` after commit.
 */
export async function storeModelPrices(
  tx: Database,
  results: ModelPriceResult[],
  now = Date.now(),
): Promise<(string | null)[]> {
  const jobs: (string | null)[] = [];
  for (const result of results) {
    const [row] = await tx
      .update(acpModelPrices)
      .set({
        queued: false,
        checkedAt: new Date(now),
        ...(result.fetched ? { match: result.match } : {}),
      })
      .where(
        and(
          eq(acpModelPrices.id, result.id),
          eq(acpModelPrices.name, result.name),
          sql`${acpModelPrices.description} is not distinct from ${result.description}`,
        ),
      )
      .returning({ id: acpModelPrices.id });
    if (!row) continue;
    jobs.push(await enqueueJob(tx, { kind: REPRICE_PENDING_JOB, payload: { priceKey: row.id } }));
  }
  return jobs;
}

function safeMatch(api: ModelsDevApi, model: AgentModel, agentKey: string) {
  try {
    return matchModelsDev(api, model, agentKey);
  } catch {
    // A malformed catalogue entry is no match, not a failed run.
    return null;
  }
}

/**
 * Fetch the models.dev catalogue once for every queued model choice and store the matches
 * (the `usage:prices` task). Walks the queue in batches by creation; nothing queued costs one
 * indexed read and no fetch. Concurrent runs are harmless: a second one stores the same matches.
 *
 * @returns how many queued choices were looked up.
 */
export async function resolveModelPrices(runtime: Runtime): Promise<number> {
  const { db } = runtime.drivers;
  const queuedAfter = (after: { createdAt: Date; id: string } | null) =>
    db
      .select()
      .from(acpModelPrices)
      .where(
        and(
          eq(acpModelPrices.queued, true),
          after
            ? or(
                gt(acpModelPrices.createdAt, after.createdAt),
                and(eq(acpModelPrices.createdAt, after.createdAt), gt(acpModelPrices.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(acpModelPrices.createdAt), asc(acpModelPrices.id))
      .limit(RESOLVE_BATCH);

  let rows = await queuedAfter(null);
  if (rows.length === 0) return 0;
  const api = await fetchModelsDev(runtime.fetch);

  let resolved = 0;
  for (let batch = 0; batch < RESOLVE_BATCHES_PER_RUN && rows.length > 0; batch++) {
    const results = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      fetched: api !== null,
      match: api
        ? safeMatch(
            api,
            { id: row.model, name: row.name, ...(row.description ? { description: row.description } : {}) },
            row.agentId,
          )
        : null,
    }));
    const jobs = await db.transaction((tx) => storeModelPrices(tx, results));
    runtime.defer(dispatchJobs(runtime, jobs));
    resolved += rows.length;
    if (rows.length < RESOLVE_BATCH) break;
    rows = await queuedAfter(rows.at(-1)!);
  }
  return resolved;
}
