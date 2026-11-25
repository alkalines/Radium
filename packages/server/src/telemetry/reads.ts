import { and, desc, eq, gte, inArray, lt, or, type SQL } from "drizzle-orm";
import {
  buildBranchLanes,
  sharedPrefixDepth,
  summarizeRequests,
  type BranchLane,
  type LineageParent,
} from "contracts/telemetry/reads";
import type {
  TelemetryAttempt,
  TelemetryChanges,
  TelemetryLineage,
  TelemetryRequestStatus,
  TelemetrySettings,
  TelemetrySource,
  TelemetryUsage,
} from "contracts/telemetry/validators";
import { toBase64Url } from "radium-crypto";
import { visibleWorkspaceChats } from "../chatroom/access";
import type { StoredJson } from "../db/columns";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import type { Runtime } from "../runtime";
import { visibleCompletionCosts } from "../usage/completions";
import { workspaceAccess, type WorkspaceAccess } from "../workspaces/access";
import { updateWorkspaceSettings } from "../workspaces/settings";
import { telemetrySettingsFor } from "./capture";
import { telemetryRequests, telemetrySessions } from "./schema";
import {
  isChainAncestor,
  loadBlobs,
  loadChain,
  loadToolsets,
  nodeDepths,
  type WireBlob,
  type WireNode,
  type WireSealed,
} from "./store";

/**
 * Owner telemetry reads and settings (Convex `observability/telemetry.ts`). Only the workspace
 * owner reads telemetry, and never more than the owner could see in Chatroom: a request or
 * session with a chat is visible only when the owner passes the chat access function for it
 * (`visibleWorkspaceChats`), so a member's personal chat and a shared chat without the owner stay
 * hidden; one without a chat only when it is Gateway traffic (`source = 'gateway'`), so a
 * Chatroom row whose chat was deleted (`chat` set null) stays hidden too. Unknown, foreign,
 * member-, outsider- and archived-workspace ids and hidden rows are the same `NOT_FOUND`.
 *
 * Times are ms epoch numbers; absent values are `null`; sealed bytes are base64url.
 */

export const MAX_RETENTION_DAYS = 3650;
export const MAX_REQUEST_PAGE = 50;
export const MAX_SESSION_PAGE = 25;
export const MESSAGE_PAGE_DEFAULT = 20;
export const MESSAGE_PAGE_MAX = 50;
export const SESSION_WINDOW_DEFAULT = 300;
export const SESSION_WINDOW_MAX = 500;
/** Requests per session counted for list rows. */
const SESSION_REQUEST_SCAN = 100;
/** One beyond the summary window so the result can report truncation. */
const SUMMARY_WINDOW = 2000;
/** Rows a filtered request page scans at most; a short page then continues from the window end. */
const FILTER_SCAN_WINDOW = 1000;
/** Subagent sessions listed per session. */
const CHILD_SESSIONS = 25;

type RequestRow = typeof telemetryRequests.$inferSelect;
type SessionRow = typeof telemetrySessions.$inferSelect;
type RequestChange = "system" | "toolset" | "params" | "model";

/** Keyset cursor of a page: the last row's `(startedAt, id)`. */
export type TelemetryCursor = { at: number; id: string };

/** The owner whose view a read applies. */
type Owner = { workspace: string; userId: string };

function ownerOf(access: WorkspaceAccess): Owner {
  return { workspace: access.workspace.id, userId: access.workspace.ownerId };
}

// ---------------------------------------------------------------------------------------------
// Visibility

type Attributed = { source: TelemetrySource; chat: string | null };

/** Chats among `rows` the owner may see. */
async function visibleChatsOf(db: Database, owner: Owner, rows: readonly Attributed[]) {
  const chats = await visibleWorkspaceChats(
    db,
    owner.userId,
    owner.workspace,
    rows.flatMap((row) => (row.chat === null ? [] : [row.chat])),
  );
  return (row: Attributed) => (row.chat !== null ? chats.has(row.chat) : row.source === "gateway");
}

async function isVisible(db: Database, owner: Owner, row: Attributed) {
  return (await visibleChatsOf(db, owner, [row]))(row);
}

/**
 * The owner of `workspace` as `userId`, or `NOT_FOUND` with `message`: members, outsiders,
 * unknown and archived workspaces alike.
 */
async function requireOwner(db: Database, userId: string, workspace: string, message: string) {
  const access = await workspaceAccess(db, userId, workspace);
  if (!access || access.role !== "owner") throw new AppError("NOT_FOUND", message);
  return ownerOf(access);
}

/** A request the caller owns and may see; anything else is "Request not found.". */
export async function requireVisibleRequest(db: Database, userId: string, id: string) {
  const message = "Request not found.";
  const [request] = await db.select().from(telemetryRequests).where(eq(telemetryRequests.id, id));
  if (!request) throw new AppError("NOT_FOUND", message);
  const owner = await requireOwner(db, userId, request.workspace, message);
  if (!(await isVisible(db, owner, request))) throw new AppError("NOT_FOUND", message);
  return { request, owner };
}

/** A session the caller owns and may see; anything else is "Session not found.". */
export async function requireVisibleSession(db: Database, userId: string, id: string) {
  const message = "Session not found.";
  const [session] = await db.select().from(telemetrySessions).where(eq(telemetrySessions.id, id));
  if (!session) throw new AppError("NOT_FOUND", message);
  const owner = await requireOwner(db, userId, session.workspace, message);
  if (!(await isVisible(db, owner, session))) throw new AppError("NOT_FOUND", message);
  return { session, owner };
}

function before(
  cursor: TelemetryCursor | null | undefined,
  table: typeof telemetryRequests | typeof telemetrySessions,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor.at);
  return or(lt(table.startedAt, at), and(eq(table.startedAt, at), lt(table.id, cursor.id)));
}

// ---------------------------------------------------------------------------------------------
// Settings

export type TelemetrySettingsView = {
  enabled: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
  /** Days captured requests are kept; null keeps them until deleted. */
  retentionDays: number | null;
};

export async function getSettings(db: Database, workspace: string): Promise<TelemetrySettingsView> {
  const settings: TelemetrySettings = await telemetrySettingsFor(db, workspace);
  return {
    enabled: settings.enabled,
    recordInputs: settings.recordInputs,
    recordOutputs: settings.recordOutputs,
    retentionDays: settings.retentionDays ?? null,
  };
}

/**
 * Configures capture. Disabling capture also clears the content flags, so re-enabling never
 * silently resumes recording prompts. `retentionDays` 1..3650, `null` keeps forever, omitted
 * keeps the stored value. Capture reads these per request (`telemetrySettingsFor`, uncached), so
 * a change applies to the next request; the Gateway key cache holds only per-key settings.
 */
export async function setSettings(
  db: Database,
  workspace: string,
  input: {
    enabled: boolean;
    recordInputs: boolean;
    recordOutputs: boolean;
    retentionDays?: number | null;
  },
): Promise<null> {
  const days = input.retentionDays;
  if (
    days !== undefined &&
    days !== null &&
    (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS)
  ) {
    throw new AppError(
      "BAD_REQUEST",
      `Retention must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}.`,
    );
  }
  await updateWorkspaceSettings(db, workspace, {
    telemetryEnabled: input.enabled,
    telemetryRecordInputs: input.enabled && input.recordInputs,
    telemetryRecordOutputs: input.enabled && input.recordOutputs,
    ...(days !== undefined ? { telemetryRetentionDays: days } : {}),
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Request rows

/** List row of a request (Convex `summarizeRequest`). */
export type RequestSummary = {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ttftMs: number | null;
  model: string;
  provider: string | null;
  source: TelemetrySource;
  status: TelemetryRequestStatus;
  stream: boolean;
  finishReason: string | null;
  usage: TelemetryUsage | null;
  requestedServiceTier: string | null;
  servedServiceTier: string | null;
  estimatedCost: number | null;
  reportedCost: number | null;
  upstreamInferenceCost: number | null;
  /** Historical plaintext error message; new errors are sealed (`request.sealedError`). */
  error: string | null;
  chatId: string | null;
  sessionId: string | null;
  sessionKey: string | null;
  lineage: TelemetryLineage;
  changedFields: RequestChange[];
  /** Message depth of the last client message; 0 when the request had none. */
  inputDepth: number;
  attempts: number;
  recordsInputs: boolean;
  recordsOutputs: boolean;
  imported: boolean;
  /** Cost of the linked completion when the owner may see it; null on session timelines. */
  cost: number | null;
};

function changedFields(request: RequestRow): RequestChange[] {
  const changes = request.changes;
  if (!changes) return [];
  const fields: RequestChange[] = [];
  if (changes.model) fields.push("model");
  if (changes.system) fields.push("system");
  if (changes.toolset) fields.push("toolset");
  if (changes.params) fields.push("params");
  return fields;
}

/** Summaries of `requests` (already visible), with what they reference loaded in batches. */
async function summarize(
  db: Database,
  owner: Owner,
  requests: readonly RequestRow[],
  options: { cost: boolean },
): Promise<RequestSummary[]> {
  const sessionIds = [...new Set(requests.flatMap((row) => (row.session ? [row.session] : [])))];
  const [sessions, depths, costs] = await Promise.all([
    sessionIds.length > 0
      ? db
          .select({ id: telemetrySessions.id, key: telemetrySessions.key })
          .from(telemetrySessions)
          .where(inArray(telemetrySessions.id, sessionIds))
      : [],
    nodeDepths(db, owner.workspace, requests.map((row) => row.input)),
    options.cost
      ? visibleCompletionCosts(
          db,
          owner.userId,
          owner.workspace,
          requests.flatMap((row) => (row.chatCompletion ? [row.chatCompletion] : [])),
        )
      : new Map<string, number | null>(),
  ]);
  const keys = new Map(sessions.map((row) => [row.id, row.key]));
  return requests.map((request) => ({
    id: request.id,
    startedAt: request.startedAt.getTime(),
    endedAt: request.endedAt.getTime(),
    durationMs: request.durationMs,
    ttftMs: request.ttftMs,
    model: request.model,
    provider: request.provider,
    source: request.source,
    status: request.status,
    stream: request.stream,
    finishReason: request.finishReason,
    usage: request.usage,
    requestedServiceTier: request.requestedServiceTier,
    servedServiceTier: request.servedServiceTier,
    estimatedCost: request.estimatedCost,
    reportedCost: request.reportedCost,
    upstreamInferenceCost: request.upstreamInferenceCost,
    error: request.errorMessage,
    chatId: request.chat,
    sessionId: request.session,
    sessionKey: request.session ? (keys.get(request.session) ?? null) : null,
    lineage: request.lineage,
    changedFields: changedFields(request),
    inputDepth: request.input ? (depths.get(request.input) ?? 0) : 0,
    attempts: request.attempts.length,
    recordsInputs: request.recordsInputs,
    recordsOutputs: request.recordsOutputs,
    imported: request.legacyTraceId !== null,
    cost: request.chatCompletion ? (costs.get(request.chatCompletion) ?? null) : null,
  }));
}

/** The request's lineage parent in the same workspace, with what prefix depth needs of it. */
async function lineageParent(
  db: Database,
  owner: Owner,
  request: RequestRow,
): Promise<{ parent: RequestRow | null; info: LineageParent | null }> {
  const parentId = request.lineage.request;
  if (!parentId) return { parent: null, info: null };
  const [parent] = await db
    .select()
    .from(telemetryRequests)
    .where(and(eq(telemetryRequests.id, parentId), eq(telemetryRequests.workspace, owner.workspace)));
  if (!parent) return { parent: null, info: null };
  const depth = parent.input
    ? ((await nodeDepths(db, owner.workspace, [parent.input])).get(parent.input) ?? 0)
    : 0;
  return { parent, info: { inputDepth: depth, hasOutput: parent.output !== null } };
}

/**
 * Newest-first request rows, optionally narrowed to a session, status or requested model. Hidden
 * rows are dropped after paging, so a page can be shorter than `limit`; with a status or model
 * filter one page scans at most {@link FILTER_SCAN_WINDOW} rows and may come back short (even
 * empty) with a `nextCursor`. `nextCursor` is null on the last page.
 */
export async function listRequests(
  db: Database,
  access: WorkspaceAccess,
  input: {
    cursor?: TelemetryCursor | null;
    limit: number;
    session?: string;
    status?: TelemetryRequestStatus;
    model?: string;
  },
): Promise<{ page: RequestSummary[]; nextCursor: TelemetryCursor | null }> {
  const owner = ownerOf(access);
  const limit = Math.min(Math.max(1, input.limit), MAX_REQUEST_PAGE);
  if (input.session !== undefined) {
    const [session] = await db
      .select()
      .from(telemetrySessions)
      .where(
        and(eq(telemetrySessions.id, input.session), eq(telemetrySessions.workspace, owner.workspace)),
      );
    if (!session || !(await isVisible(db, owner, session))) {
      throw new AppError("NOT_FOUND", "Session not found.");
    }
  }

  const scope = and(
    eq(telemetryRequests.workspace, owner.workspace),
    input.session !== undefined ? eq(telemetryRequests.session, input.session) : undefined,
    before(input.cursor, telemetryRequests),
  );
  const order = [desc(telemetryRequests.startedAt), desc(telemetryRequests.id)];
  const filtered = input.status !== undefined || input.model !== undefined;

  let rows: RequestRow[];
  if (filtered) {
    const window = db
      .select()
      .from(telemetryRequests)
      .where(scope)
      .orderBy(...order)
      .limit(FILTER_SCAN_WINDOW)
      .as("window");
    rows = await db
      .select()
      .from(window)
      .where(
        and(
          input.status !== undefined ? eq(window.status, input.status) : undefined,
          input.model !== undefined ? eq(window.model, input.model) : undefined,
        ),
      )
      .orderBy(desc(window.startedAt), desc(window.id))
      .limit(limit);
  } else {
    rows = await db.select().from(telemetryRequests).where(scope).orderBy(...order).limit(limit);
  }

  let next: { startedAt: Date; id: string } | undefined;
  if (rows.length === limit) {
    next = rows.at(-1);
  } else if (filtered) {
    // A short filtered page: continue after the scan window when it was full.
    [next] = await db
      .select({ startedAt: telemetryRequests.startedAt, id: telemetryRequests.id })
      .from(telemetryRequests)
      .where(scope)
      .orderBy(...order)
      .offset(FILTER_SCAN_WINDOW - 1)
      .limit(1);
  }

  const visible = await visibleChatsOf(db, owner, rows);
  return {
    page: await summarize(db, owner, rows.filter(visible), { cost: true }),
    nextCursor: next ? { at: next.startedAt.getTime(), id: next.id } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// One request

/** The stored request as the detail view reads it. */
export type RequestView = {
  id: string;
  workspace: string;
  requestId: string;
  source: TelemetrySource;
  model: string;
  provider: string | null;
  stream: boolean;
  status: TelemetryRequestStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ttftMs: number | null;
  generationMs: number | null;
  finishReason: string | null;
  usage: TelemetryUsage | null;
  requestedServiceTier: string | null;
  servedServiceTier: string | null;
  estimatedCost: number | null;
  reportedCost: number | null;
  upstreamInferenceCost: number | null;
  providerGenerationId: string | null;
  chatId: string | null;
  sessionId: string | null;
  canceled: boolean;
  /** Attempt messages are sealed with the error (`sealedError`); historical rows may carry them. */
  attempts: TelemetryAttempt[];
  lineage: TelemetryLineage;
  changes: TelemetryChanges | null;
  recordsInputs: boolean;
  recordsOutputs: boolean;
  /** Historical plaintext error. */
  error: { message: string; status: number | null } | null;
  /** `{ error, attempts }` sealed to the owner key (`table telemetry_requests`, field `error`). */
  sealedError: WireSealed | null;
  legacyContent: StoredJson<LegacyBox> | null;
  legacyTraceId: string | null;
};

function requestView(request: RequestRow): RequestView {
  return {
    id: request.id,
    workspace: request.workspace,
    requestId: request.requestId,
    source: request.source,
    model: request.model,
    provider: request.provider,
    stream: request.stream,
    status: request.status,
    startedAt: request.startedAt.getTime(),
    endedAt: request.endedAt.getTime(),
    durationMs: request.durationMs,
    ttftMs: request.ttftMs,
    generationMs: request.generationMs,
    finishReason: request.finishReason,
    usage: request.usage,
    requestedServiceTier: request.requestedServiceTier,
    servedServiceTier: request.servedServiceTier,
    estimatedCost: request.estimatedCost,
    reportedCost: request.reportedCost,
    upstreamInferenceCost: request.upstreamInferenceCost,
    providerGenerationId: request.providerGenerationId,
    chatId: request.chat,
    sessionId: request.session,
    canceled: request.canceled,
    attempts: request.attempts,
    lineage: request.lineage,
    changes: request.changes,
    recordsInputs: request.recordsInputs,
    recordsOutputs: request.recordsOutputs,
    error:
      request.errorMessage !== null
        ? { message: request.errorMessage, status: request.errorStatus }
        : null,
    sealedError:
      request.sealedErrorEpoch !== null
        ? {
            epoch: request.sealedErrorEpoch,
            requestId: request.sealedErrorRequestId!,
            capsule: toBase64Url(request.sealedErrorCapsule!),
            envelope: toBase64Url(request.sealedErrorEnvelope!),
            storageUrl: null,
          }
        : null,
    legacyContent: request.legacyContent,
    legacyTraceId: request.legacyTraceId,
  };
}

type BlobChange = { from: WireBlob | null; to: WireBlob | null };

export type RequestDetail = {
  request: RequestView;
  summary: RequestSummary;
  session: { id: string; key: string; parentKey: string | null } | null;
  related: { id: string; startedAt: number; model: string; status: TelemetryRequestStatus } | null;
  /** Messages deeper than this depth are new in this request. */
  prefixDepth: number;
  system: WireBlob | null;
  params: WireBlob | null;
  headers: WireBlob | null;
  tools: WireBlob[];
  output: WireNode | null;
  changes: {
    previous: string;
    model: { from: string; to: string } | null;
    system: BlobChange | null;
    params: BlobChange | null;
    tools: { from: WireBlob[]; to: WireBlob[] } | null;
  } | null;
  legacy: {
    traceId: string;
    input: WireBlob | null;
    output: WireBlob | null;
    spans: WireBlob | null;
  } | null;
};

/**
 * One request with its configuration blobs, tools, output and the differences from the previous
 * request in its session resolved to before/after values.
 */
export async function getRequest(
  runtime: Pick<Runtime, "drivers">,
  userId: string,
  id: string,
): Promise<RequestDetail> {
  const { db } = runtime.drivers;
  const { request, owner } = await requireVisibleRequest(db, userId, id);
  const changes = request.changes;
  const [[summary], session, lineage, blobs, toolsets, output] = await Promise.all([
    summarize(db, owner, [request], { cost: true }),
    request.session
      ? db
          .select({
            id: telemetrySessions.id,
            key: telemetrySessions.key,
            parentKey: telemetrySessions.parentKey,
          })
          .from(telemetrySessions)
          .where(eq(telemetrySessions.id, request.session))
          .then((rows) => rows[0] ?? null)
      : null,
    lineageParent(db, owner, request),
    loadBlobs(runtime, owner.workspace, [
      request.system,
      request.params,
      request.headers,
      changes?.system?.from,
      changes?.system?.to,
      changes?.params?.from,
      changes?.params?.to,
      request.legacyInput,
      request.legacyOutput,
      request.legacySpans,
    ]),
    loadToolsets(runtime, owner.workspace, [
      request.toolset,
      changes?.toolset?.from,
      changes?.toolset?.to,
    ]),
    loadChain(runtime, owner.workspace, request.output, 1),
  ]);
  const blob = (blobId: string | null | undefined) => (blobId ? (blobs.get(blobId) ?? null) : null);
  const tools = (toolset: string | null | undefined) =>
    toolset ? (toolsets.get(toolset) ?? []) : [];
  const change = (value: { from?: string; to?: string } | undefined) =>
    value ? { from: blob(value.from), to: blob(value.to) } : null;

  const parent = lineage.parent;
  const related =
    parent && (await isVisible(db, owner, parent))
      ? {
          id: parent.id,
          startedAt: parent.startedAt.getTime(),
          model: parent.model,
          status: parent.status,
        }
      : null;

  return {
    request: requestView(request),
    summary: summary!,
    session,
    related,
    prefixDepth: sharedPrefixDepth(request.lineage, lineage.info),
    system: blob(request.system),
    params: blob(request.params),
    headers: blob(request.headers),
    tools: tools(request.toolset),
    output: output.nodes.at(-1) ?? null,
    changes: changes
      ? {
          previous: changes.previous,
          model: changes.model ?? null,
          system: change(changes.system),
          params: change(changes.params),
          tools: changes.toolset
            ? { from: tools(changes.toolset.from), to: tools(changes.toolset.to) }
            : null,
        }
      : null,
    legacy:
      request.legacyTraceId !== null
        ? {
            traceId: request.legacyTraceId,
            input: blob(request.legacyInput),
            output: blob(request.legacyOutput),
            spans: blob(request.legacySpans),
          }
        : null,
  };
}

/**
 * The request's input chain, newest page first: pass `nextCursor` to read older messages. Each
 * page is oldest-first; `isNew` marks messages first seen in this request. A cursor must lie on
 * this request's own chain.
 */
export async function getRequestMessages(
  runtime: Pick<Runtime, "drivers">,
  userId: string,
  input: { request: string; cursor?: string | null; limit?: number },
): Promise<{
  nodes: Array<WireNode & { isNew: boolean }>;
  prefixDepth: number;
  total: number;
  more: boolean;
  nextCursor: string | null;
}> {
  const { db } = runtime.drivers;
  const { request, owner } = await requireVisibleRequest(db, userId, input.request);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? MESSAGE_PAGE_DEFAULT), 1), MESSAGE_PAGE_MAX);

  let leaf = request.input;
  if (input.cursor) {
    if (!request.input || !(await isChainAncestor(db, owner.workspace, request.input, input.cursor))) {
      throw new AppError("BAD_REQUEST", "Invalid message cursor.");
    }
    leaf = input.cursor;
  }

  const [{ info }, chain, depths] = await Promise.all([
    lineageParent(db, owner, request),
    loadChain(runtime, owner.workspace, leaf, limit),
    nodeDepths(db, owner.workspace, [request.input]),
  ]);
  const prefixDepth = sharedPrefixDepth(request.lineage, info);
  return {
    nodes: chain.nodes.map((node) => ({ ...node, isNew: node.depth > prefixDepth })),
    prefixDepth,
    total: request.input ? (depths.get(request.input) ?? 0) : 0,
    more: chain.more,
    nextCursor: chain.nextLeaf,
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions

export type SessionSummary = {
  id: string;
  key: string;
  parentKey: string | null;
  chatId: string | null;
  startedAt: number;
  lastRequestAt: number;
  /** Visible requests, counted up to 100. */
  requestCount: number;
  requestCountCapped: boolean;
};

/**
 * Newest-first sessions with their latest activity and a capped count of the owner-visible
 * requests. Hidden sessions are dropped after paging, so a page can be shorter than `limit`.
 */
export async function listSessions(
  db: Database,
  access: WorkspaceAccess,
  input: { cursor?: TelemetryCursor | null; limit: number },
): Promise<{ page: SessionSummary[]; nextCursor: TelemetryCursor | null }> {
  const owner = ownerOf(access);
  const limit = Math.min(Math.max(1, input.limit), MAX_SESSION_PAGE);
  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(eq(telemetrySessions.workspace, owner.workspace), before(input.cursor, telemetrySessions)),
    )
    .orderBy(desc(telemetrySessions.startedAt), desc(telemetrySessions.id))
    .limit(limit);
  const sessions = rows.filter(await visibleChatsOf(db, owner, rows));

  const requests = await Promise.all(
    sessions.map((session) =>
      db
        .select({
          startedAt: telemetryRequests.startedAt,
          source: telemetryRequests.source,
          chat: telemetryRequests.chat,
        })
        .from(telemetryRequests)
        .where(eq(telemetryRequests.session, session.id))
        .orderBy(desc(telemetryRequests.startedAt), desc(telemetryRequests.id))
        .limit(SESSION_REQUEST_SCAN + 1),
    ),
  );
  const visible = await visibleChatsOf(db, owner, requests.flat());
  const last = rows.at(-1);
  return {
    page: sessions.map((session, index) => {
      const shown = requests[index]!.filter(visible);
      return {
        id: session.id,
        key: session.key,
        parentKey: session.parentKey,
        chatId: session.chat,
        startedAt: session.startedAt.getTime(),
        lastRequestAt: (shown[0]?.startedAt ?? session.startedAt).getTime(),
        requestCount: Math.min(shown.length, SESSION_REQUEST_SCAN),
        requestCountCapped: shown.length > SESSION_REQUEST_SCAN,
      };
    }),
    nextCursor:
      rows.length === limit && last ? { at: last.startedAt.getTime(), id: last.id } : null,
  };
}

export type SessionDetail = {
  session: {
    id: string;
    key: string;
    parentKey: string | null;
    chatId: string | null;
    startedAt: number;
  };
  parentSession: { id: string; key: string } | null;
  children: Array<{ id: string; key: string }>;
  requests: Array<RequestSummary & { prefixDepth: number; newMessages: number }>;
  lanes: BranchLane<string>[];
  truncated: boolean;
};

/**
 * A session's chronological timeline of its newest `limit` visible requests and their branch
 * lanes, with its parent and subagent sessions (visible ones only).
 */
export async function getSession(
  db: Database,
  userId: string,
  input: { session: string; limit?: number },
): Promise<SessionDetail> {
  const { session, owner } = await requireVisibleSession(db, userId, input.session);
  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? SESSION_WINDOW_DEFAULT), 1),
    SESSION_WINDOW_MAX,
  );

  const newest = await db
    .select()
    .from(telemetryRequests)
    .where(eq(telemetryRequests.session, session.id))
    .orderBy(desc(telemetryRequests.startedAt), desc(telemetryRequests.id))
    .limit(limit + 1);
  const isShown = await visibleChatsOf(db, owner, newest);
  const window = newest.slice(0, limit).reverse().filter(isShown);
  const byId = new Map(window.map((request) => [request.id, request]));

  // Lineage parents outside the window.
  const outside = [
    ...new Set(
      window.flatMap((request) => {
        const parent = request.lineage.request;
        return parent && !byId.has(parent) ? [parent] : [];
      }),
    ),
  ];
  const outsideRows =
    outside.length > 0
      ? await db
          .select()
          .from(telemetryRequests)
          .where(
            and(eq(telemetryRequests.workspace, owner.workspace), inArray(telemetryRequests.id, outside)),
          )
      : [];
  const parents = new Map([...byId, ...outsideRows.map((row) => [row.id, row] as const)]);
  const depths = await nodeDepths(
    db,
    owner.workspace,
    [...parents.values()].map((row) => row.input),
  );
  const depthOf = (row: RequestRow) => (row.input ? (depths.get(row.input) ?? 0) : 0);

  const summaries = await summarize(db, owner, window, { cost: false });
  const timeline = window.map((request, index) => {
    const parentId = request.lineage.request;
    const parent = parentId ? parents.get(parentId) : undefined;
    const info = parent ? { inputDepth: depthOf(parent), hasOutput: parent.output !== null } : null;
    const prefixDepth = sharedPrefixDepth(request.lineage, info);
    const summary = summaries[index]!;
    return { ...summary, prefixDepth, newMessages: Math.max(0, summary.inputDepth - prefixDepth) };
  });

  const lanes = buildBranchLanes(
    timeline.map((entry) => ({
      id: entry.id,
      lineage: entry.lineage,
      forkDepth: entry.prefixDepth,
    })),
  );

  const [parentRows, childRows] = await Promise.all([
    session.parentKey
      ? db
          .select()
          .from(telemetrySessions)
          .where(
            and(
              eq(telemetrySessions.workspace, owner.workspace),
              eq(telemetrySessions.key, session.parentKey),
            ),
          )
      : ([] as SessionRow[]),
    db
      .select()
      .from(telemetrySessions)
      .where(
        and(eq(telemetrySessions.workspace, owner.workspace), eq(telemetrySessions.parentKey, session.key)),
      )
      .limit(CHILD_SESSIONS),
  ]);
  const sessionShown = await visibleChatsOf(db, owner, [...parentRows, ...childRows]);
  const parentSession = parentRows.find(sessionShown);

  return {
    session: {
      id: session.id,
      key: session.key,
      parentKey: session.parentKey,
      chatId: session.chat,
      startedAt: session.startedAt.getTime(),
    },
    parentSession: parentSession ? { id: parentSession.id, key: parentSession.key } : null,
    children: childRows.filter(sessionShown).map((child) => ({ id: child.id, key: child.key })),
    requests: timeline,
    lanes,
    truncated: newest.length > limit,
  };
}

// ---------------------------------------------------------------------------------------------
// Summary

export type TelemetrySummary = {
  requests: number;
  errors: number;
  aborted: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationP50: number | null;
  durationP95: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
  topModels: Array<{ model: string; requests: number; totalTokens: number }>;
  /** More than 2000 requests matched; the aggregates cover the newest 2000. */
  truncated: boolean;
};

/** Bounded aggregates over the owner-visible requests since `since` (ms epoch). */
export async function getSummary(
  db: Database,
  access: WorkspaceAccess,
  since: number,
): Promise<TelemetrySummary> {
  const owner = ownerOf(access);
  const scanned = await db
    .select({
      model: telemetryRequests.model,
      status: telemetryRequests.status,
      durationMs: telemetryRequests.durationMs,
      ttftMs: telemetryRequests.ttftMs,
      usage: telemetryRequests.usage,
      source: telemetryRequests.source,
      chat: telemetryRequests.chat,
    })
    .from(telemetryRequests)
    .where(
      and(
        eq(telemetryRequests.workspace, owner.workspace),
        gte(telemetryRequests.startedAt, new Date(since)),
      ),
    )
    .orderBy(desc(telemetryRequests.startedAt), desc(telemetryRequests.id))
    .limit(SUMMARY_WINDOW + 1);
  const window = scanned.slice(0, SUMMARY_WINDOW);
  const visible = window.filter(await visibleChatsOf(db, owner, window));
  const summary = summarizeRequests(
    visible.map((row) => ({
      model: row.model,
      status: row.status,
      durationMs: row.durationMs,
      ttftMs: row.ttftMs ?? undefined,
      usage: row.usage ?? undefined,
    })),
  );
  return {
    ...summary,
    durationP50: summary.durationP50 ?? null,
    durationP95: summary.durationP95 ?? null,
    ttftP50: summary.ttftP50 ?? null,
    ttftP95: summary.ttftP95 ?? null,
    truncated: scanned.length > SUMMARY_WINDOW,
  };
}
