import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import { isChatVisibleToWorkspace } from "../chatroom";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../helpers";
import { secrets, workspaceTelemetrySecretNamespace } from "../secrets";
import {
  buildOtlpExport,
  deliveryUrl,
  isSampled,
  parseDestinationEndpoint,
  type OtlpBundle,
} from "../../src/telemetry/otlp";
import { loadBlob, loadChain, loadToolset, type LoadedBlob } from "../../src/telemetry/store";
import { telemetryDestinationKindSchema } from "../../src/telemetry/validators";

const HEADERS_SECRET = "headers";
const MAX_DESTINATIONS = 20;
/** Newest messages exported per request; bounds query reads for very long conversations. */
const EXPORT_MESSAGE_LIMIT = 100;
const DELIVERY_TIMEOUT_MS = 10_000;
/** Destination rows are patched at most this often on repeated success to avoid write contention. */
const DELIVERY_RECORD_INTERVAL_MS = 10_000;
const MAX_ERROR_LENGTH = 300;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const destinationView = v.object({
  _id: v.id("telemetry_destinations"),
  kind: telemetryDestinationKindSchema,
  name: v.string(),
  endpoint: v.string(),
  enabled: v.boolean(),
  privacyMode: v.boolean(),
  samplingRate: v.number(),
  includeApiKeys: v.array(v.id("api_keys")),
  excludeApiKeys: v.array(v.id("api_keys")),
  /** Header values are write-only; this only reports whether any are stored. */
  hasHeaders: v.boolean(),
  lastDeliveryAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
});

const destinationFields = {
  name: v.string(),
  endpoint: v.string(),
  enabled: v.boolean(),
  privacyMode: v.boolean(),
  samplingRate: v.number(),
  includeApiKeys: v.array(v.id("api_keys")),
  excludeApiKeys: v.array(v.id("api_keys")),
};

type DestinationDoc = Doc<"telemetry_destinations">;
type DestinationSettings = {
  name: string;
  endpoint: string;
  enabled: boolean;
  privacyMode: boolean;
  samplingRate: number;
  includeApiKeys: Id<"api_keys">[];
  excludeApiKeys: Id<"api_keys">[];
};

function toView(destination: DestinationDoc) {
  return {
    _id: destination._id,
    kind: destination.kind,
    name: destination.name,
    endpoint: destination.endpoint,
    enabled: destination.enabled,
    privacyMode: destination.privacyMode,
    samplingRate: destination.samplingRate,
    includeApiKeys: destination.includeApiKeys,
    excludeApiKeys: destination.excludeApiKeys,
    hasHeaders: destination.secretName !== undefined,
    lastDeliveryAt: destination.lastDeliveryAt,
    lastError: destination.lastError,
  };
}

async function normalizeSettings(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  settings: DestinationSettings,
): Promise<DestinationSettings> {
  const name = settings.name.trim();
  if (!name) throw new Error("Destination name is required.");
  if (name.length > 80) throw new Error("Destination name is too long.");

  const endpoint = settings.endpoint.trim();
  if (!parseDestinationEndpoint(endpoint)) {
    throw new Error(
      "Endpoint must be an https URL without credentials (http is allowed for localhost only).",
    );
  }

  if (!(settings.samplingRate >= 0 && settings.samplingRate <= 1)) {
    throw new Error("Sampling rate must be between 0 and 1.");
  }

  const includeApiKeys = [...new Set(settings.includeApiKeys)];
  const excludeApiKeys = [...new Set(settings.excludeApiKeys)];
  for (const id of [...includeApiKeys, ...excludeApiKeys]) {
    const key = await ctx.db.get("api_keys", id);
    if (!key || key.workspace !== workspace) throw new Error("Unknown API key.");
  }

  return { ...settings, name, endpoint, includeApiKeys, excludeApiKeys };
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers).map(([name, value]) => [name.trim(), value] as const);
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) throw new Error(`Invalid header name: ${name || "(empty)"}.`);
    if (/[\r\n]/.test(value)) throw new Error(`Invalid value for header ${name}.`);
  }
  return Object.fromEntries(entries);
}

async function readHeaders(
  ctx: Pick<QueryCtx, "runQuery">,
  workspace: Id<"workspaces">,
  destination: DestinationDoc,
): Promise<Record<string, string>> {
  if (destination.secretName === undefined) return {};
  try {
    const stored = await secrets.get(ctx, {
      namespace: workspaceTelemetrySecretNamespace(workspace, destination._id),
      name: destination.secretName,
    });
    if (!stored.ok) return {};
    const parsed: unknown = JSON.parse(stored.value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Export destinations for the workspace. Header values are never returned. */
export const listDestinations = ownedWorkspaceQuery({
  args: {},
  returns: v.array(destinationView),
  handler: async (ctx) => {
    const destinations = await ctx.db
      .query("telemetry_destinations")
      .withIndex("by_workspace", (q) => q.eq("workspace", ctx.workspace._id))
      .take(MAX_DESTINATIONS + 1);
    return destinations.map(toView);
  },
});

/** Create an export destination; `headers` are stored encrypted in Secret Store. */
export const createDestination = ownedWorkspaceMutation({
  args: {
    kind: telemetryDestinationKindSchema,
    name: v.string(),
    endpoint: v.string(),
    headers: v.optional(v.record(v.string(), v.string())),
    enabled: v.optional(v.boolean()),
    privacyMode: v.optional(v.boolean()),
    samplingRate: v.optional(v.number()),
    includeApiKeys: v.optional(v.array(v.id("api_keys"))),
    excludeApiKeys: v.optional(v.array(v.id("api_keys"))),
  },
  returns: v.id("telemetry_destinations"),
  handler: async (ctx, args) => {
    const workspace = ctx.workspace._id;
    const existing = await ctx.db
      .query("telemetry_destinations")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
      .take(MAX_DESTINATIONS);
    if (existing.length >= MAX_DESTINATIONS) {
      throw new Error(`A workspace can have at most ${MAX_DESTINATIONS} export destinations.`);
    }

    const settings = await normalizeSettings(ctx, workspace, {
      name: args.name,
      endpoint: args.endpoint,
      enabled: args.enabled ?? true,
      privacyMode: args.privacyMode ?? false,
      samplingRate: args.samplingRate ?? 1,
      includeApiKeys: args.includeApiKeys ?? [],
      excludeApiKeys: args.excludeApiKeys ?? [],
    });
    const headers = args.headers ? validateHeaders(args.headers) : {};
    const hasHeaders = Object.keys(headers).length > 0;

    const id = await ctx.db.insert("telemetry_destinations", {
      workspace,
      kind: args.kind,
      ...settings,
      secretName: hasHeaders ? HEADERS_SECRET : undefined,
    });
    if (hasHeaders) {
      await secrets.put(ctx, {
        namespace: workspaceTelemetrySecretNamespace(workspace, id),
        name: HEADERS_SECRET,
        value: JSON.stringify(headers),
      });
    }
    return id;
  },
});

/**
 * Update a destination. Omitted fields keep their value; `headers` omitted keeps the stored
 * headers, `{}` clears them, and any other map replaces them.
 */
export const updateDestination = ownedWorkspaceMutation({
  args: {
    destination: v.id("telemetry_destinations"),
    name: v.optional(v.string()),
    endpoint: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
    enabled: v.optional(v.boolean()),
    privacyMode: v.optional(v.boolean()),
    samplingRate: v.optional(v.number()),
    includeApiKeys: v.optional(v.array(v.id("api_keys"))),
    excludeApiKeys: v.optional(v.array(v.id("api_keys"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = ctx.workspace._id;
    const destination = await ctx.db.get("telemetry_destinations", args.destination);
    if (!destination || destination.workspace !== workspace) {
      throw new Error("Destination not found.");
    }

    const settings = await normalizeSettings(ctx, workspace, {
      name: args.name ?? destination.name,
      endpoint: args.endpoint ?? destination.endpoint,
      enabled: args.enabled ?? destination.enabled,
      privacyMode: args.privacyMode ?? destination.privacyMode,
      samplingRate: args.samplingRate ?? destination.samplingRate,
      includeApiKeys: args.includeApiKeys ?? destination.includeApiKeys,
      excludeApiKeys: args.excludeApiKeys ?? destination.excludeApiKeys,
    });

    const namespace = workspaceTelemetrySecretNamespace(workspace, destination._id);
    let secretName = destination.secretName;
    if (args.headers !== undefined) {
      const headers = validateHeaders(args.headers);
      if (Object.keys(headers).length > 0) {
        await secrets.put(ctx, { namespace, name: HEADERS_SECRET, value: JSON.stringify(headers) });
        secretName = HEADERS_SECRET;
      } else {
        await secrets.remove(ctx, { namespace, name: HEADERS_SECRET });
        secretName = undefined;
      }
    }

    await ctx.db.patch("telemetry_destinations", destination._id, { ...settings, secretName });
    return null;
  },
});

/** Delete a destination and its stored header secret. */
export const deleteDestination = ownedWorkspaceMutation({
  args: { destination: v.id("telemetry_destinations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = ctx.workspace._id;
    const destination = await ctx.db.get("telemetry_destinations", args.destination);
    if (!destination || destination.workspace !== workspace) {
      throw new Error("Destination not found.");
    }
    await secrets.remove(ctx, {
      namespace: workspaceTelemetrySecretNamespace(workspace, destination._id),
      name: HEADERS_SECRET,
    });
    await ctx.db.delete("telemetry_destinations", destination._id);
    return null;
  },
});

type DeliveryTarget = {
  id: Id<"telemetry_destinations">;
  kind: DestinationDoc["kind"];
  endpoint: string;
  headers: Record<string, string>;
  privacyMode: boolean;
};

type DeliveryPlan = { bundle: OtlpBundle; destinations: DeliveryTarget[] };

/**
 * Load a captured request with everything an export needs, plus the destinations that should
 * receive it. Returns null for a missing request, a request hidden from the owner (private
 * chats), or when no destination accepts it. Include/exclude, sampling, and the rest of the
 * selection run here so header secrets are only decrypted for destinations that will fire.
 */
export const loadDeliveryPlan = internalQuery({
  args: { request: v.id("telemetry_requests") },
  handler: async (ctx, args): Promise<DeliveryPlan | null> => {
    const request = await ctx.db.get("telemetry_requests", args.request);
    if (!request) return null;
    const workspace = request.workspace;

    // Same policy as owner telemetry reads: only gateway requests or chats the owner may see.
    const visible =
      request.chatId !== undefined
        ? await isChatVisibleToWorkspace(ctx, workspace, request.chatId)
        : request.source === "gateway";
    if (!visible) return null;

    const session = request.session
      ? await ctx.db.get("telemetry_sessions", request.session)
      : null;
    const sessionKey = session?.key;
    const samplingKey = sessionKey ?? request.requestId;

    const candidates = await ctx.db
      .query("telemetry_destinations")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
      .take(MAX_DESTINATIONS);
    const destinations: DeliveryTarget[] = [];
    for (const destination of candidates) {
      if (!destination.enabled) continue;
      if (request.apiKey && destination.excludeApiKeys.includes(request.apiKey)) continue;
      if (
        destination.includeApiKeys.length > 0 &&
        (!request.apiKey || !destination.includeApiKeys.includes(request.apiKey))
      ) {
        continue;
      }
      if (!(await isSampled(samplingKey, destination.samplingRate))) continue;
      destinations.push({
        id: destination._id,
        kind: destination.kind,
        endpoint: destination.endpoint,
        headers: await readHeaders(ctx, workspace, destination),
        privacyMode: destination.privacyMode,
      });
    }
    if (destinations.length === 0) return null;

    // Content is only loaded when some destination will actually include it.
    const needsContent = destinations.some((destination) => !destination.privacyMode);
    const chain = needsContent
      ? await loadChain(ctx, workspace, request.input, EXPORT_MESSAGE_LIMIT)
      : { nodes: [] };
    const output =
      needsContent && request.output
        ? (await loadChain(ctx, workspace, request.output, 1)).nodes[0]
        : undefined;

    const bundle: OtlpBundle = {
      request: {
        requestId: request.requestId,
        source: request.source,
        model: request.model,
        provider: request.provider,
        stream: request.stream,
        status: request.status,
        startedAt: request.startedAt,
        endedAt: request.endedAt,
        durationMs: request.durationMs,
        ttftMs: request.ttftMs,
        generationMs: request.generationMs,
        finishReason: request.finishReason,
        usage: request.usage,
        providerGenerationId: request.providerGenerationId,
        error: request.error,
        attempts: request.attempts,
        lineage: request.lineage,
        changes: request.changes,
      },
      sessionKey,
      params: await loadBlob(ctx, workspace, request.params),
      system: needsContent ? await loadBlob(ctx, workspace, request.system) : null,
      toolset: needsContent ? await loadToolset(ctx, workspace, request.toolset) : [],
      messages: chain.nodes,
      output,
    };
    return { bundle, destinations };
  },
});

/** One destination for the test action; header secrets are decrypted for the action only. */
export const loadDestinationForTest = internalQuery({
  args: { workspace: v.id("workspaces"), destination: v.id("telemetry_destinations") },
  handler: async (ctx, args): Promise<DeliveryTarget | null> => {
    const destination = await ctx.db.get("telemetry_destinations", args.destination);
    if (!destination || destination.workspace !== args.workspace) return null;
    return {
      id: destination._id,
      kind: destination.kind,
      endpoint: destination.endpoint,
      headers: await readHeaders(ctx, args.workspace, destination),
      privacyMode: destination.privacyMode,
    };
  },
});

/**
 * Record a delivery outcome on the destination. Repeated successes are throttled so a busy
 * Gateway does not contend on one row; any change of error state is written immediately.
 */
export const recordDelivery = internalMutation({
  args: { destination: v.id("telemetry_destinations"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const destination = await ctx.db.get("telemetry_destinations", args.destination);
    if (!destination) return null;
    const now = Date.now();

    if (args.error !== undefined) {
      if (destination.lastError !== args.error) {
        await ctx.db.patch("telemetry_destinations", destination._id, { lastError: args.error });
      }
      return null;
    }

    const recent =
      destination.lastDeliveryAt !== undefined &&
      now - destination.lastDeliveryAt < DELIVERY_RECORD_INTERVAL_MS;
    if (recent && destination.lastError === undefined) return null;
    await ctx.db.patch("telemetry_destinations", destination._id, {
      lastDeliveryAt: now,
      lastError: undefined,
    });
    return null;
  },
});

type SendResult = { ok: true } | { ok: false; error: string };

/** POST one payload. Failures become results; header values never appear in error text. */
async function send(target: DeliveryTarget, payload: unknown): Promise<SendResult> {
  // Convex runs actions in a serverless isolate; use only standard fetch/abort primitives.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(deliveryUrl(target.kind, target.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify(payload),
      // A redirect would forward the payload to an unvalidated host.
      redirect: "manual",
      signal: abort.signal,
    });
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    const message = abort.signal.aborted
      ? "Delivery timed out."
      : error instanceof Error
        ? error.message
        : "Delivery failed.";
    return { ok: false, error: message.slice(0, MAX_ERROR_LENGTH) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fill content stored in file storage; unreadable files leave the blob without content. */
async function hydrate(blob: LoadedBlob | null | undefined): Promise<void> {
  if (!blob || blob.content !== undefined || !blob.storageUrl) return;
  try {
    const response = await fetch(blob.storageUrl);
    if (response.ok) blob.content = await response.text();
  } catch {
    // Export proceeds without this content.
  }
}

/**
 * Export a captured request to every matching destination. Scheduled by capture after the
 * request row is written; never throws, so a broken destination cannot affect capture.
 */
export const deliver = internalAction({
  args: { request: v.id("telemetry_requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const plan: DeliveryPlan | null = await ctx.runQuery(
        internal.observability.telemetryExport.loadDeliveryPlan,
        { request: args.request },
      );
      if (!plan) return null;

      const { bundle } = plan;
      if (plan.destinations.some((destination) => !destination.privacyMode)) {
        await Promise.all([
          hydrate(bundle.system),
          hydrate(bundle.output?.message),
          ...(bundle.toolset ?? []).map(hydrate),
          ...(bundle.messages ?? []).map((node) => hydrate(node.message)),
        ]);
      }

      await Promise.all(
        plan.destinations.map(async (target) => {
          try {
            const payload = await buildOtlpExport(bundle, { privacyMode: target.privacyMode });
            const result = await send(target, payload);
            await ctx.runMutation(internal.observability.telemetryExport.recordDelivery, {
              destination: target.id,
              error: result.ok ? undefined : result.error,
            });
          } catch (error) {
            console.error("Telemetry export failed", error);
          }
        }),
      );
    } catch (error) {
      console.error("Telemetry export failed", error);
    }
    return null;
  },
});

/** Send a synthetic span to a destination (owner only) and report the outcome. */
export const testDestination = action({
  args: { workspace: v.id("workspaces"), destination: v.id("telemetry_destinations") },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    // The owner-only list rejects members and outsiders before anything is decrypted.
    const owned = await ctx.runQuery(api.observability.telemetryExport.listDestinations, {
      workspace: args.workspace,
    });
    if (!owned.some((destination) => destination._id === args.destination)) {
      throw new Error("Destination not found.");
    }
    const target: DeliveryTarget | null = await ctx.runQuery(
      internal.observability.telemetryExport.loadDestinationForTest,
      args,
    );
    if (!target) throw new Error("Destination not found.");

    const now = Date.now();
    const payload = await buildOtlpExport(
      {
        request: {
          requestId: `radium-test-${now}`,
          source: "gateway",
          model: "radium/test",
          provider: "radium",
          stream: false,
          status: "ok",
          startedAt: now - 250,
          endedAt: now,
          durationMs: 250,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          attempts: [],
          lineage: { kind: "root" },
        },
      },
      { privacyMode: true },
    );
    const result = await send(target, payload);
    await ctx.runMutation(internal.observability.telemetryExport.recordDelivery, {
      destination: target.id,
      error: result.ok ? undefined : result.error,
    });
    return result;
  },
});
