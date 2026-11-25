import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { LoadedBlob, LoadedNode } from "contracts/telemetry/store";
import type { TelemetryAttempt } from "contracts/telemetry/validators";
import { visibleWorkspaceChats } from "../chatroom/access";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { workspaceApiKeyIds } from "../gateway/keys";
import { getSecret, putSecret, removeSecret, type SecretLocation } from "../gateway/secrets";
import { enqueueJob } from "../jobs/outbox";
import { kvSet } from "../kv";
import type { Runtime } from "../runtime";
import { workspaces } from "../workspaces/schema";
import { canonicalJson } from "./canonical";
import type { DecomposedRequest } from "./decompose";
import {
  buildOtlpExport,
  deliveryUrl,
  isSampled,
  parseDestinationEndpoint,
  type OtlpBundle,
  type OtlpRequest,
} from "./otlp";
import { telemetryDestinations, telemetryRequests, telemetrySessions } from "./schema";

/**
 * Telemetry export (Convex `observability/telemetryExport.ts`): owner-managed OTLP/webhook
 * destinations and delivery of captured requests to them.
 *
 * Content is sealed to the owner key at rest, so the server can only export it while it still
 * holds the plaintext: destinations with privacy mode off are sent from memory by capture right
 * after the request row commits ({@link deliverFromMemory}); privacy-mode destinations get the
 * metadata-only span from the `telemetry.export` outbox job queued in the row's transaction
 * ({@link runExportJob}).
 *
 * Delivery is at most once per (request, destination): before posting, a sender claims
 * `telemetry:delivered:<request>:<destination>` in Valkey with `SET NX`, so a retried or
 * duplicated job, a job reclaimed after a crash, or a second capture of the same request never
 * posts twice. A failed post is recorded on the destination (`last_error`) and not retried, as in
 * Convex; a crash between the claim and the post loses that delivery.
 */

export const EXPORT_JOB = "telemetry.export";
/** Destinations per workspace; the list and every delivery plan read at most this many. */
export const MAX_DESTINATIONS = 20;
export const MAX_DESTINATION_NAME = 80;
export const MAX_HEADERS = 32;
const HEADERS_SECRET = "headers";
const DELIVERY_TIMEOUT_MS = 10_000;
/** Destination rows are written at most this often on repeated success. */
const DELIVERY_RECORD_INTERVAL_MS = 10_000;
/** How long a delivery claim outlives the job that could repeat it (outbox backoff is ≤ 1 h). */
const DELIVERY_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** Newest input messages sent with a content export (Convex `deliverFromMemory`). */
const CONTENT_MESSAGES = 100;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const HEADERS_UNAVAILABLE = "Destination headers are unavailable.";

type DestinationRow = typeof telemetryDestinations.$inferSelect;
type DestinationKind = DestinationRow["kind"];
type RequestRow = typeof telemetryRequests.$inferSelect;

/** A destination as the owner sees it; header values are write-only (`hasHeaders`). */
export type DestinationView = {
  id: string;
  kind: DestinationKind;
  name: string;
  endpoint: string;
  enabled: boolean;
  privacyMode: boolean;
  samplingRate: number;
  includeApiKeys: string[];
  excludeApiKeys: string[];
  hasHeaders: boolean;
  /** ms epoch. */
  lastDeliveryAt: number | null;
  lastError: string | null;
};

export type DestinationSettings = {
  name: string;
  endpoint: string;
  enabled: boolean;
  privacyMode: boolean;
  samplingRate: number;
  includeApiKeys: string[];
  excludeApiKeys: string[];
};

export type CreateDestinationInput = Partial<Omit<DestinationSettings, "name" | "endpoint">> & {
  kind: DestinationKind;
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
};

export type UpdateDestinationInput = Partial<DestinationSettings> & {
  destination: string;
  /** Omitted keeps the stored headers, `{}` clears them, anything else replaces them. */
  headers?: Record<string, string>;
};

export type SendResult = { ok: true } | { ok: false; error: string };

type DeliveryTarget = {
  id: string;
  kind: DestinationKind;
  endpoint: string;
  headers: Record<string, string>;
};

/** `workspace:<id>:telemetry:<destination>` (Convex `workspaceTelemetrySecretNamespace`). */
function headersLocation(workspace: string, destination: string): SecretLocation {
  return { namespace: `workspace:${workspace}:telemetry:${destination}`, name: HEADERS_SECRET };
}

function toView(row: DestinationRow): DestinationView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    endpoint: row.endpoint,
    enabled: row.enabled,
    privacyMode: row.privacyMode,
    samplingRate: row.samplingRate,
    includeApiKeys: row.includeApiKeys,
    excludeApiKeys: row.excludeApiKeys,
    hasHeaders: row.secretName !== null,
    lastDeliveryAt: row.lastDeliveryAt?.getTime() ?? null,
    lastError: row.lastError,
  };
}

async function normalizeSettings(
  db: Database,
  workspace: string,
  settings: DestinationSettings,
): Promise<DestinationSettings> {
  const name = settings.name.trim();
  if (!name) throw new AppError("BAD_REQUEST", "Destination name is required.");
  if (name.length > MAX_DESTINATION_NAME) {
    throw new AppError("BAD_REQUEST", "Destination name is too long.");
  }

  const endpoint = settings.endpoint.trim();
  if (!parseDestinationEndpoint(endpoint)) {
    throw new AppError(
      "BAD_REQUEST",
      "Endpoint must be an https URL without credentials (http is allowed for localhost only).",
    );
  }

  if (!(settings.samplingRate >= 0 && settings.samplingRate <= 1)) {
    throw new AppError("BAD_REQUEST", "Sampling rate must be between 0 and 1.");
  }

  const includeApiKeys = [...new Set(settings.includeApiKeys)];
  const excludeApiKeys = [...new Set(settings.excludeApiKeys)];
  const wanted = [...new Set([...includeApiKeys, ...excludeApiKeys])];
  const known = await workspaceApiKeyIds(db, workspace, wanted);
  if (wanted.some((id) => !known.has(id))) throw new AppError("BAD_REQUEST", "Unknown API key.");

  return { ...settings, name, endpoint, includeApiKeys, excludeApiKeys };
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers).map(([name, value]) => [name.trim(), value] as const);
  if (entries.length > MAX_HEADERS) throw new AppError("BAD_REQUEST", "Too many headers.");
  for (const [name, value] of entries) {
    // The name is the caller's own input; the value never appears in a message.
    if (!HEADER_NAME.test(name)) {
      throw new AppError("BAD_REQUEST", `Invalid header name: ${name || "(empty)"}.`);
    }
    if (/[\r\n]/.test(value)) throw new AppError("BAD_REQUEST", `Invalid value for header ${name}.`);
  }
  return Object.fromEntries(entries);
}

/** The workspace's destinations, oldest first. Header values are never returned. */
export async function listDestinations(db: Database, workspace: string): Promise<DestinationView[]> {
  const rows = await db
    .select()
    .from(telemetryDestinations)
    .where(eq(telemetryDestinations.workspace, workspace))
    .orderBy(asc(telemetryDestinations.createdAt), asc(telemetryDestinations.id))
    .limit(MAX_DESTINATIONS);
  return rows.map(toView);
}

/**
 * Creates a destination; `headers` go to the Secret Store in the same transaction. The
 * per-workspace cap holds under concurrent creates through a workspace advisory lock.
 */
export async function createDestination(
  runtime: Pick<Runtime, "drivers" | "secrets">,
  workspace: string,
  input: CreateDestinationInput,
): Promise<{ id: string }> {
  const { db } = runtime.drivers;
  const settings = await normalizeSettings(db, workspace, {
    name: input.name,
    endpoint: input.endpoint,
    enabled: input.enabled ?? true,
    privacyMode: input.privacyMode ?? true,
    samplingRate: input.samplingRate ?? 1,
    includeApiKeys: input.includeApiKeys ?? [],
    excludeApiKeys: input.excludeApiKeys ?? [],
  });
  const headers = input.headers ? validateHeaders(input.headers) : {};
  const hasHeaders = Object.keys(headers).length > 0;

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`telemetry-destinations:${workspace}`}, 0))`,
    );
    const [existing] = await tx
      .select({ total: count() })
      .from(telemetryDestinations)
      .where(eq(telemetryDestinations.workspace, workspace));
    if (existing!.total >= MAX_DESTINATIONS) {
      throw new AppError(
        "BAD_REQUEST",
        `A workspace can have at most ${MAX_DESTINATIONS} export destinations.`,
      );
    }
    const [row] = await tx
      .insert(telemetryDestinations)
      .values({
        workspace,
        kind: input.kind,
        ...settings,
        secretName: hasHeaders ? HEADERS_SECRET : null,
      })
      .returning({ id: telemetryDestinations.id });
    if (hasHeaders) {
      await putSecret(tx, runtime.secrets, headersLocation(workspace, row!.id), JSON.stringify(headers));
    }
    return { id: row!.id };
  });
}

async function requireDestination(tx: Database, workspace: string, destination: string) {
  const [row] = await tx
    .select()
    .from(telemetryDestinations)
    .where(
      and(eq(telemetryDestinations.id, destination), eq(telemetryDestinations.workspace, workspace)),
    )
    .for("update");
  if (!row) throw new AppError("NOT_FOUND", "Destination not found.");
  return row;
}

/** Updates a destination; omitted fields keep their value. */
export async function updateDestination(
  runtime: Pick<Runtime, "drivers" | "secrets">,
  workspace: string,
  input: UpdateDestinationInput,
): Promise<null> {
  const { db } = runtime.drivers;
  const headers = input.headers === undefined ? undefined : validateHeaders(input.headers);
  await db.transaction(async (tx) => {
    const row = await requireDestination(tx, workspace, input.destination);
    const settings = await normalizeSettings(tx, workspace, {
      name: input.name ?? row.name,
      endpoint: input.endpoint ?? row.endpoint,
      enabled: input.enabled ?? row.enabled,
      privacyMode: input.privacyMode ?? row.privacyMode,
      samplingRate: input.samplingRate ?? row.samplingRate,
      includeApiKeys: input.includeApiKeys ?? row.includeApiKeys,
      excludeApiKeys: input.excludeApiKeys ?? row.excludeApiKeys,
    });

    let secretName = row.secretName;
    if (headers !== undefined) {
      const location = headersLocation(workspace, row.id);
      if (Object.keys(headers).length > 0) {
        await putSecret(tx, runtime.secrets, location, JSON.stringify(headers));
        secretName = HEADERS_SECRET;
      } else {
        await removeSecret(tx, location);
        secretName = null;
      }
    }
    await tx
      .update(telemetryDestinations)
      .set({ ...settings, secretName })
      .where(eq(telemetryDestinations.id, row.id));
  });
  return null;
}

/** Deletes a destination and its stored headers. */
export async function deleteDestination(
  db: Database,
  workspace: string,
  destination: string,
): Promise<null> {
  await db.transaction(async (tx) => {
    const row = await requireDestination(tx, workspace, destination);
    await removeSecret(tx, headersLocation(workspace, row.id));
    await tx.delete(telemetryDestinations).where(eq(telemetryDestinations.id, row.id));
  });
  return null;
}

/**
 * The destination's stored headers; `null` when they exist but cannot be read (retired key,
 * damaged row). Such a destination is skipped rather than sent to without its credentials.
 */
async function readHeaders(
  runtime: Pick<Runtime, "drivers" | "secrets">,
  destination: DestinationRow,
): Promise<Record<string, string> | null> {
  if (destination.secretName === null) return {};
  try {
    const stored = await getSecret(
      runtime.drivers.db,
      runtime.secrets,
      headersLocation(destination.workspace, destination.id),
    );
    if (!stored.ok) return null;
    const parsed: unknown = JSON.parse(stored.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Records a delivery outcome. Repeated successes write at most every
 * {@link DELIVERY_RECORD_INTERVAL_MS} so a busy Gateway does not contend on one row; a change of
 * error state is written at once. `error` is one of the fixed strings of {@link send}.
 */
async function recordDelivery(db: Database, destination: string, error: string | null) {
  if (error !== null) {
    await db
      .update(telemetryDestinations)
      .set({ lastError: error })
      .where(
        and(
          eq(telemetryDestinations.id, destination),
          sql`${telemetryDestinations.lastError} is distinct from ${error}`,
        ),
      );
    return;
  }
  await db
    .update(telemetryDestinations)
    .set({ lastDeliveryAt: sql`now()`, lastError: null })
    .where(
      and(
        eq(telemetryDestinations.id, destination),
        or(
          sql`${telemetryDestinations.lastError} is not null`,
          isNull(telemetryDestinations.lastDeliveryAt),
          sql`${telemetryDestinations.lastDeliveryAt} < now() - ${`${DELIVERY_RECORD_INTERVAL_MS} milliseconds`}::interval`,
        ),
      ),
    );
}

/** POSTs one payload. Failures become fixed messages; header values never appear in them. */
async function send(
  runtime: Pick<Runtime, "fetch">,
  target: DeliveryTarget,
  payload: unknown,
): Promise<SendResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await runtime.fetch(deliveryUrl(target.kind, target.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: JSON.stringify(payload),
      // A redirect would forward the payload to an unvalidated host.
      redirect: "manual",
      signal: abort.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch {
    return { ok: false, error: abort.signal.aborted ? "Delivery timed out." : "Delivery failed." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends `payload` to `target` unless this (request, destination) was already claimed, then
 * records the outcome. Never throws.
 */
async function deliverOnce(
  runtime: Runtime,
  request: string,
  target: DeliveryTarget,
  payload: () => Promise<unknown>,
) {
  try {
    const claimed = await kvSet(
      runtime.drivers.kv,
      `telemetry:delivered:${request}:${target.id}`,
      "1",
      { ttlMs: DELIVERY_CLAIM_TTL_MS, onlyIfAbsent: true },
    );
    if (!claimed) return;
    const result = await send(runtime, target, await payload());
    await recordDelivery(runtime.drivers.db, target.id, result.ok ? null : result.error);
  } catch {
    console.error("Telemetry export failed");
  }
}

type DeliveryPlan = {
  request: RequestRow;
  sessionKey: string | undefined;
  targets: DeliveryTarget[];
};

/**
 * A captured request and the destinations (privacy mode on or off, per `privacyMode`) that should
 * receive it, or `null` when none do. Same policy as owner reads: only Gateway requests, or
 * requests whose chat the owner may see; never for an archived workspace. Include/exclude and
 * sampling run first, so header secrets are decrypted only for destinations that will fire.
 */
async function loadDeliveryPlan(
  runtime: Runtime,
  requestId: string,
  privacyMode: boolean,
): Promise<DeliveryPlan | null> {
  const { db } = runtime.drivers;
  const [row] = await db
    .select({
      request: telemetryRequests,
      ownerId: workspaces.ownerId,
      sessionKey: telemetrySessions.key,
    })
    .from(telemetryRequests)
    .innerJoin(
      workspaces,
      and(eq(workspaces.id, telemetryRequests.workspace), isNull(workspaces.archivedAt)),
    )
    .leftJoin(telemetrySessions, eq(telemetrySessions.id, telemetryRequests.session))
    .where(eq(telemetryRequests.id, requestId));
  if (!row) return null;
  const { request, ownerId } = row;

  const visible =
    request.chat !== null
      ? (await visibleWorkspaceChats(db, ownerId, request.workspace, [request.chat])).has(
          request.chat,
        )
      : request.source === "gateway";
  if (!visible) return null;

  const candidates = await db
    .select()
    .from(telemetryDestinations)
    .where(
      and(
        eq(telemetryDestinations.workspace, request.workspace),
        eq(telemetryDestinations.enabled, true),
        eq(telemetryDestinations.privacyMode, privacyMode),
      ),
    )
    .limit(MAX_DESTINATIONS);
  const sessionKey = row.sessionKey ?? undefined;
  const samplingKey = sessionKey ?? request.requestId;
  const targets: DeliveryTarget[] = [];
  for (const destination of candidates) {
    const apiKey = request.apiKey;
    if (apiKey && destination.excludeApiKeys.includes(apiKey)) continue;
    if (
      destination.includeApiKeys.length > 0 &&
      (!apiKey || !destination.includeApiKeys.includes(apiKey))
    ) {
      continue;
    }
    if (!(await isSampled(samplingKey, destination.samplingRate))) continue;
    const headers = await readHeaders(runtime, destination);
    if (!headers) {
      await recordDelivery(db, destination.id, HEADERS_UNAVAILABLE);
      continue;
    }
    targets.push({ id: destination.id, kind: destination.kind, endpoint: destination.endpoint, headers });
  }
  return targets.length > 0 ? { request, sessionKey, targets } : null;
}

/** The exported request metadata; attempt messages and errors are content (sealed at rest). */
function otlpRequest(request: RequestRow): OtlpRequest {
  return {
    requestId: request.requestId,
    source: request.source,
    model: request.model,
    provider: request.provider ?? undefined,
    stream: request.stream,
    status: request.status,
    startedAt: request.startedAt.getTime(),
    endedAt: request.endedAt.getTime(),
    durationMs: request.durationMs,
    ttftMs: request.ttftMs ?? undefined,
    generationMs: request.generationMs ?? undefined,
    finishReason: request.finishReason ?? undefined,
    usage: request.usage ?? undefined,
    providerGenerationId: request.providerGenerationId ?? undefined,
    requestedServiceTier: request.requestedServiceTier ?? undefined,
    servedServiceTier: request.servedServiceTier ?? undefined,
    estimatedCost: request.estimatedCost ?? undefined,
    reportedCost: request.reportedCost ?? undefined,
    upstreamInferenceCost: request.upstreamInferenceCost ?? undefined,
    attempts: request.attempts.map(({ message: _message, ...attempt }) => attempt),
    lineage: request.lineage,
    changes: request.changes ?? undefined,
  };
}

/** Whether the workspace has an enabled destination with the given privacy mode (one index probe). */
async function hasDestination(db: Database, workspace: string, privacyMode: boolean) {
  const [destination] = await db
    .select({ id: telemetryDestinations.id })
    .from(telemetryDestinations)
    .where(
      and(
        eq(telemetryDestinations.workspace, workspace),
        eq(telemetryDestinations.enabled, true),
        eq(telemetryDestinations.privacyMode, privacyMode),
      ),
    )
    .limit(1);
  return destination !== undefined;
}

/**
 * Queues the privacy-mode export of a just-inserted request, in its transaction, when the
 * workspace has an enabled privacy-mode destination. Returns the job id for `dispatchJobs`.
 */
export async function queueRequestExport(
  tx: Database,
  workspace: string,
  request: string,
): Promise<string | null> {
  if (!(await hasDestination(tx, workspace, true))) return null;
  return await enqueueJob(tx, {
    kind: EXPORT_JOB,
    payload: { request },
    dedupeKey: `${EXPORT_JOB}:${request}`,
  });
}

const exportPayload = z.object({ request: z.string().min(1).max(256) });

/**
 * Handler of the `telemetry.export` job: the metadata-only span to every matching privacy-mode
 * destination. Destination failures are recorded, not thrown; only a failure before any send
 * (loading the plan) makes the outbox retry, and claims keep a retry from posting twice.
 */
export async function runExportJob(runtime: Runtime, payload: unknown): Promise<void> {
  const requestId = exportPayload.parse(payload).request;
  const plan = await loadDeliveryPlan(runtime, requestId, true);
  if (!plan) return;
  const bundle: OtlpBundle = { request: otlpRequest(plan.request), sessionKey: plan.sessionKey };
  await Promise.all(
    plan.targets.map((target) =>
      deliverOnce(runtime, requestId, target, () => buildOtlpExport(bundle, { privacyMode: true })),
    ),
  );
}

/** What capture still holds in memory once the request row is stored. */
export type MemoryExport = {
  parts: DecomposedRequest;
  output: unknown;
  error?: { message: string; status?: number };
  attempts: TelemetryAttempt[];
  recordInputs: boolean;
  recordOutputs: boolean;
};

/**
 * Sends opt-in content from the active request to every matching destination with privacy mode
 * off (Convex `deliverFromMemory`); plaintext is never stored for it. Content follows the
 * workspace's recording settings. Never throws.
 */
export async function deliverFromMemory(
  runtime: Runtime,
  request: { id: string; workspace: string },
  input: MemoryExport,
): Promise<void> {
  const requestId = request.id;
  try {
    if (!(await hasDestination(runtime.drivers.db, request.workspace, false))) return;
    const plan = await loadDeliveryPlan(runtime, requestId, false);
    if (!plan) return;
    const blob = (kind: LoadedBlob["kind"], value: unknown): LoadedBlob => ({
      id: "" as LoadedBlob["id"],
      hash: "",
      kind,
      size: 0,
      content: canonicalJson(value),
      redacted: false,
    });
    const node = (value: unknown, index: number, origin: "input" | "output"): LoadedNode => ({
      id: "" as LoadedNode["id"],
      depth: index + 1,
      origin,
      message: blob("message", value),
    });
    const recordsContent = input.recordInputs || input.recordOutputs;
    const metadata = otlpRequest(plan.request);
    const bundle: OtlpBundle = {
      request: {
        ...metadata,
        error: recordsContent ? input.error : undefined,
        attempts: recordsContent ? input.attempts : metadata.attempts,
      },
      sessionKey: plan.sessionKey,
      params: input.recordInputs ? blob("params", input.parts.params) : null,
      system:
        input.recordInputs && input.parts.system.length > 0 ? blob("system", input.parts.system) : null,
      toolset: input.recordInputs ? input.parts.tools.map((tool) => blob("tool", tool)) : [],
      messages: input.recordInputs
        ? input.parts.chain.slice(-CONTENT_MESSAGES).map((message, index) => node(message, index, "input"))
        : [],
      output: input.recordOutputs && input.output ? node(input.output, 0, "output") : null,
    };
    await Promise.all(
      plan.targets.map((target) =>
        deliverOnce(runtime, requestId, target, () => buildOtlpExport(bundle, { privacyMode: false })),
      ),
    );
  } catch {
    console.error("Telemetry export failed");
  }
}

/** Sends a synthetic span to one destination (owner only) and reports the outcome. */
export async function testDestination(
  runtime: Runtime,
  workspace: string,
  destination: string,
): Promise<SendResult> {
  const [row] = await runtime.drivers.db
    .select()
    .from(telemetryDestinations)
    .where(
      and(eq(telemetryDestinations.id, destination), eq(telemetryDestinations.workspace, workspace)),
    );
  if (!row) throw new AppError("NOT_FOUND", "Destination not found.");
  const headers = await readHeaders(runtime, row);
  if (!headers) {
    await recordDelivery(runtime.drivers.db, row.id, HEADERS_UNAVAILABLE);
    return { ok: false, error: HEADERS_UNAVAILABLE };
  }

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
  const target = { id: row.id, kind: row.kind, endpoint: row.endpoint, headers };
  const result = await send(runtime, target, payload);
  await recordDelivery(runtime.drivers.db, row.id, result.ok ? null : result.error);
  return result;
}
