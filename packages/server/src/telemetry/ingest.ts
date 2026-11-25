import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Id } from "contracts/wire";
import type {
  TelemetryAttempt,
  TelemetryBlobKind,
  TelemetryChanges,
  TelemetryLineage,
  TelemetryRequestStatus,
  TelemetrySource,
  TelemetryUsage,
} from "contracts/telemetry/validators";
import { chatVisibleInWorkspace } from "../chatroom/access";
import { newId } from "../db/ids";
import type { Database } from "../drivers/types";
import { apiKeys } from "../gateway/schema";
import { workspaceAccess } from "../workspaces/access";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
  telemetryToolsetTools,
} from "./schema";
import { queueRequestExport } from "./export";

/**
 * Write path of Gateway telemetry capture (`capture.ts` is the only caller). Rows are content
 * addressed and every function is idempotent, so concurrent requests that share blobs or a
 * conversation prefix converge on the same rows: blobs by `insert … on conflict do nothing`,
 * nodes by a transaction lock on the parent they hang off, requests by `(workspace, request_id)`.
 * Arguments are server-derived, but ownership claims (user, API key, chat) are still checked
 * against app-owned rows before anything is attributed to a workspace.
 */

/**
 * A node this request reuses no longer exists: telemetry GC collected it after capture looked it
 * up (or the id was never the workspace's). Capture stores the request once more.
 */
export class TelemetryReferenceGone extends Error {
  override name = "TelemetryReferenceGone";
}

/** Content sealed to the workspace owner key under a capsule of one request. */
export type SealedContent = {
  epoch: number;
  /** The capturing request: part of the AAD and kept so deduplicated content outlives it. */
  requestId: string;
  capsule: Uint8Array;
  envelope: Uint8Array;
};

/**
 * A sealed blob: the envelope inline, or (above `INLINE_ENVELOPE_LIMIT`) already written to the
 * object store at `storageKey`.
 */
export type SealedBlob =
  | SealedContent
  | (Omit<SealedContent, "envelope"> & { storageKey: string });

export type BlobInput = {
  hash: string;
  kind: TelemetryBlobKind;
  /** UTF-8 byte length of the canonical JSON, even when the content is not stored. */
  size: number;
  /** Absent when content recording is off or the workspace has no key. */
  sealed?: SealedBlob;
  /** Tool blob ids of a `toolset`, in request order; the tools must already exist. */
  members?: string[];
};

export type NodeInput = {
  hash: string;
  blob: string;
  origin: "input" | "output";
};

/** Hashes per statement: bounds parameters and the size of the `in` lists. */
const LOOKUP_BATCH = 500;
/** Rows per insert statement: nodes carry 7 columns, toolset members 4. */
const NODE_ROWS = 500;
const MEMBER_ROWS = 1000;
/** Most recent requests considered when relating a conversation to earlier ones. */
const LINEAGE_CANDIDATES = 20;

const blobRecorded = sql<boolean>`(
  ${telemetryBlobs.content} is not null
  or ${telemetryBlobs.storageKey} is not null
  or ${telemetryBlobs.sealedEpoch} is not null
  or ${telemetryBlobs.legacyContent} is not null
)`;

function* chunks<Item>(items: readonly Item[], size: number) {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

async function nodeByHash(db: Database, workspace: string, hash: string) {
  const [node] = await db
    .select({ id: telemetryNodes.id, depth: telemetryNodes.depth })
    .from(telemetryNodes)
    .where(and(eq(telemetryNodes.workspace, workspace), eq(telemetryNodes.hash, hash)));
  return node;
}

/**
 * Longest prefix of a chain whose nodes already exist. `hashes[i]` is the node hash at depth
 * `i + 1`. Nodes are only ever inserted after their parent, so existence is monotone in prefix
 * length and a binary search needs O(log n) index lookups.
 */
export async function deepestExistingPrefix(
  db: Database,
  workspace: string,
  hashes: readonly string[],
): Promise<{ depth: number; node?: string }> {
  let low = 0;
  let high = hashes.length;
  let node: string | undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const found = await nodeByHash(db, workspace, hashes[middle - 1]!);
    if (found) {
      low = middle;
      node = found.id;
    } else {
      high = middle - 1;
    }
  }
  return { depth: low, node };
}

/**
 * Which blob hashes are already stored, and whether their content is. Lets capture skip sealing
 * content the workspace already has.
 */
export async function existingBlobs(
  db: Database,
  workspace: string,
  hashes: readonly string[],
): Promise<Array<{ hash: string; id: string; recorded: boolean }>> {
  const found: Array<{ hash: string; id: string; recorded: boolean }> = [];
  for (const batch of chunks(hashes, LOOKUP_BATCH)) {
    found.push(
      ...(await db
        .select({ hash: telemetryBlobs.hash, id: telemetryBlobs.id, recorded: blobRecorded })
        .from(telemetryBlobs)
        .where(and(eq(telemetryBlobs.workspace, workspace), inArray(telemetryBlobs.hash, batch)))),
    );
  }
  return found;
}

function sealedColumns(sealed: SealedBlob | undefined) {
  return {
    sealedEpoch: sealed?.epoch,
    sealedRequestId: sealed?.requestId,
    sealedCapsule: sealed?.capsule,
    sealedEnvelope: sealed && "envelope" in sealed ? sealed.envelope : undefined,
    storageKey: sealed && "storageKey" in sealed ? sealed.storageKey : undefined,
  };
}

/**
 * Upsert blobs by `(workspace, hash)` and return every blob's id. A blob first stored without
 * content is upgraded when content arrives later; content never replaces content that is already
 * stored. Toolset member rows are written once, in the transaction that first inserts the toolset.
 * Rows go in hash order so concurrent batches wait on each other in one direction only.
 * `unusedKeys` are the object-store keys of inputs that ended up stored nowhere (the blob was
 * already recorded); the caller deletes those objects.
 */
export async function ingestBlobs(
  db: Database,
  workspace: string,
  blobs: readonly BlobInput[],
): Promise<{ ids: Array<{ hash: string; id: string }>; unusedKeys: string[] }> {
  if (blobs.length === 0) return { ids: [], unusedKeys: [] };
  const sorted = [...blobs].sort((left, right) => (left.hash < right.hash ? -1 : 1));

  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(telemetryBlobs)
      .values(
        sorted.map((blob) => ({
          workspace,
          hash: blob.hash,
          kind: blob.kind,
          size: blob.size,
          ...sealedColumns(blob.sealed),
        })),
      )
      .onConflictDoNothing({ target: [telemetryBlobs.workspace, telemetryBlobs.hash] })
      .returning({ id: telemetryBlobs.id, hash: telemetryBlobs.hash });
    const ids = new Map(inserted.map((row) => [row.hash, row.id]));

    const members = sorted.flatMap((blob) => {
      const toolset = ids.get(blob.hash);
      return toolset === undefined
        ? []
        : (blob.members ?? []).map((tool, position) => ({ toolset, tool, position }));
    });
    for (const batch of chunks(members, MEMBER_ROWS)) {
      await tx.insert(telemetryToolsetTools).values(batch);
    }

    const rest = sorted.filter((blob) => !ids.has(blob.hash));
    for (const existing of await existingBlobs(
      tx,
      workspace,
      rest.map((blob) => blob.hash),
    )) {
      ids.set(existing.hash, existing.id);
    }
    const unusedKeys: string[] = [];
    for (const blob of rest) {
      const id = ids.get(blob.hash);
      if (id === undefined) throw new Error("Telemetry blob was not stored.");
      if (blob.sealed === undefined) continue;
      // Conditional, so a concurrent upgrade or a recorded blob is never overwritten.
      const upgraded = await tx
        .update(telemetryBlobs)
        .set(sealedColumns(blob.sealed))
        .where(and(eq(telemetryBlobs.id, id), sql`not ${blobRecorded}`))
        .returning({ id: telemetryBlobs.id });
      if (upgraded.length === 0 && "storageKey" in blob.sealed) {
        unusedKeys.push(blob.sealed.storageKey);
      }
    }

    return {
      ids: sorted.map((blob) => ({ hash: blob.hash, id: ids.get(blob.hash)! })),
      unusedKeys,
    };
  });
}

/**
 * Append a run of messages below the node with `parentHash` (or at the root when absent) and
 * return the last node of the run. Existing nodes are kept as they are, so replays and
 * concurrent requests that share a prefix converge on the same rows; the first writer's
 * `origin` wins. `forked` reports whether the first node this run inserted joined a parent
 * that already had another child, i.e. the conversation diverged from stored history there.
 *
 * Inserters of children of one parent are serialized by a transaction advisory lock on that
 * parent: a chain cannot skip an already existing node with `on conflict` (its children would
 * reference a row that was never inserted), and `forked` must see the sibling a concurrent run
 * has just committed.
 */
export async function ingestNodes(
  db: Database,
  workspace: string,
  run: { parentHash?: string; nodes: readonly NodeInput[] },
): Promise<{ node: string; forked: boolean }> {
  if (run.nodes.length === 0) throw new Error("Telemetry node run is empty.");

  return await db.transaction(async (tx) => {
    const declared =
      run.parentHash === undefined ? undefined : await nodeByHash(tx, workspace, run.parentHash);
    if (run.parentHash !== undefined && !declared) {
      throw new TelemetryReferenceGone("Telemetry parent node not found.");
    }
    let held = await lockChildren(tx, workspace, declared?.id);

    // The run can start deeper than declared when a concurrent request stored part of it; then
    // the lock moves down to the node the run really extends.
    for (;;) {
      const existing = new Map<string, { id: string; depth: number }>();
      for (const batch of chunks(run.nodes, LOOKUP_BATCH)) {
        const rows = await tx
          .select({
            id: telemetryNodes.id,
            hash: telemetryNodes.hash,
            depth: telemetryNodes.depth,
          })
          .from(telemetryNodes)
          .where(
            and(
              eq(telemetryNodes.workspace, workspace),
              inArray(
                telemetryNodes.hash,
                batch.map((node) => node.hash),
              ),
            ),
          );
        for (const row of rows) existing.set(row.hash, row);
      }

      let last = declared;
      let first = 0;
      while (first < run.nodes.length && existing.has(run.nodes[first]!.hash)) {
        last = existing.get(run.nodes[first]!.hash);
        first++;
      }
      if (first === run.nodes.length) return { node: last!.id, forked: false };

      const key = childrenLock(workspace, last?.id);
      if (key !== held) {
        held = await lockChildren(tx, workspace, last?.id);
        continue;
      }

      const forked =
        last !== undefined &&
        (
          await tx
            .select({ id: telemetryNodes.id })
            .from(telemetryNodes)
            .where(eq(telemetryNodes.parent, last.id))
            .limit(1)
        ).length > 0;

      let parent = last?.id;
      let depth = last?.depth ?? 0;
      const rows = run.nodes.slice(first).map((node) => {
        depth += 1;
        const row = {
          id: newId(),
          workspace,
          hash: node.hash,
          parent,
          blob: node.blob,
          depth,
          origin: node.origin,
        };
        parent = row.id;
        return row;
      });
      for (const batch of chunks(rows, NODE_ROWS)) {
        await tx.insert(telemetryNodes).values(batch);
      }
      return { node: rows.at(-1)!.id, forked };
    }
  });
}

function childrenLock(workspace: string, parent: string | undefined) {
  return `telemetry-children:${workspace}:${parent ?? ""}`;
}

async function lockChildren(tx: Database, workspace: string, parent: string | undefined) {
  const key = childrenLock(workspace, parent);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  return key;
}

type RequestRow = typeof telemetryRequests.$inferSelect;

/** Prefer a request from the same session, else the most recent one. */
function preferSession<Row extends { session: string | null }>(
  rows: Row[],
  session: string | undefined,
) {
  return rows.find((row) => session !== undefined && row.session === session) ?? rows[0];
}

/** Newest requests that sent (`input`) or produced (`output`) `node`, newest first. */
function requestsAt(db: Database, column: "input" | "output", node: string) {
  const target = telemetryRequests[column];
  return db
    .select({
      id: telemetryRequests.id,
      session: telemetryRequests.session,
      output: telemetryRequests.output,
    })
    .from(telemetryRequests)
    .where(eq(target, node))
    .orderBy(desc(telemetryRequests.createdAt), desc(telemetryRequests.id))
    .limit(LINEAGE_CANDIDATES);
}

/**
 * Relate this request's conversation to earlier requests. `prefix` is the deepest chain node
 * that existed before this request inserted its own, so it marks where the conversation
 * rejoined stored history.
 */
async function classifyLineage(
  db: Database,
  args: {
    session: string | undefined;
    sessionHasRequests: boolean;
    previous: RequestRow | undefined;
    input: { id: string } | undefined;
    prefix: { id: string; depth: number } | undefined;
    /** The request's first new node joined `prefix` while it already had another child. */
    forked: boolean;
  },
): Promise<TelemetryLineage> {
  const request = (id: string | undefined) => id as Id<"telemetry_requests"> | undefined;
  if (!args.input) return { kind: "root" };
  if (!args.prefix) return { kind: args.sessionHasRequests ? "compacted" : "root" };

  const prefix = args.prefix;
  const atLeaf = prefix.id === args.input.id;

  if (atLeaf) {
    const resent = preferSession(await requestsAt(db, "input", prefix.id), args.session);
    if (resent) return { kind: "retry", request: request(resent.id), depth: prefix.depth };
  }

  const produced = preferSession(await requestsAt(db, "output", prefix.id), args.session);
  if (produced) {
    // Continuing from an output that another request already continued is a rollback/edit.
    return {
      kind: args.forked ? "branch" : "continue",
      request: request(produced.id),
      depth: prefix.depth,
    };
  }

  if (!atLeaf) {
    const extended = preferSession(await requestsAt(db, "input", prefix.id), args.session);
    if (extended) {
      return {
        kind: extended.output ? "rewrite" : args.forked ? "branch" : "continue",
        request: request(extended.id),
        depth: prefix.depth,
      };
    }
  }

  return { kind: "branch", request: request(args.previous?.id), depth: prefix.depth };
}

function classifyChanges(
  previous: RequestRow | undefined,
  current: {
    system?: string;
    toolset?: string;
    params?: string;
    model: string;
  },
): TelemetryChanges | undefined {
  if (!previous) return undefined;

  const changes: Omit<TelemetryChanges, "previous"> = {};
  for (const field of ["system", "toolset", "params"] as const) {
    const from = previous[field] ?? undefined;
    if (from !== current[field]) {
      changes[field] = {
        from: from as Id<"telemetry_blobs"> | undefined,
        to: current[field] as Id<"telemetry_blobs"> | undefined,
      };
    }
  }
  if (previous.model !== current.model) {
    changes.model = { from: previous.model, to: current.model };
  }
  return Object.keys(changes).length > 0
    ? { previous: previous.id as Id<"telemetry_requests">, ...changes }
    : undefined;
}

export type FinishRequestInput = {
  workspace: string;
  /** Idempotency key: one Gateway request. */
  requestId: string;
  source: TelemetrySource;
  apiKey?: string;
  userId: string;
  chatId?: string;
  session?: { key: string; parentKey?: string };
  /** Model slug the client requested. */
  model: string;
  provider?: string;
  credential?: string;
  stream: boolean;
  status: TelemetryRequestStatus;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ttftMs?: number;
  generationMs?: number;
  finishReason?: string;
  usage?: TelemetryUsage;
  requestedServiceTier?: string;
  servedServiceTier?: string;
  estimatedCost?: number;
  reportedCost?: number;
  upstreamInferenceCost?: number;
  providerGenerationId?: string;
  chatCompletion?: string;
  sealedError?: SealedContent;
  canceled?: boolean;
  /** Attempt `message`s are sealed separately and never stored here. */
  attempts: TelemetryAttempt[];
  input?: string;
  output?: string;
  /** Deepest chain node found before this request stored its own. */
  prefix?: string;
  /** The first inserted input node forked from existing history at `prefix`. */
  forked?: boolean;
  system?: string;
  toolset?: string;
  params?: string;
  headers?: string;
  recordsInputs: boolean;
  recordsOutputs: boolean;
};

async function requestByRequestId(db: Database, workspace: string, requestId: string) {
  const [row] = await db
    .select({ id: telemetryRequests.id })
    .from(telemetryRequests)
    .where(
      and(eq(telemetryRequests.workspace, workspace), eq(telemetryRequests.requestId, requestId)),
    );
  return row?.id;
}

/** The workspace's nodes among `ids`; any id of another workspace (or unknown) is refused. */
async function workspaceNodes(db: Database, workspace: string, ids: Array<string | undefined>) {
  const wanted = [...new Set(ids.filter((id) => id !== undefined))];
  if (wanted.length === 0) return new Map<string, { id: string; depth: number }>();
  const rows = await db
    .select({ id: telemetryNodes.id, depth: telemetryNodes.depth })
    .from(telemetryNodes)
    .where(and(eq(telemetryNodes.workspace, workspace), inArray(telemetryNodes.id, wanted)));
  if (rows.length !== wanted.length) throw new TelemetryReferenceGone("Telemetry node mismatch.");
  return new Map(rows.map((row) => [row.id, row]));
}

/** The claims arrive from the capture caller; they must match app-owned rows. */
async function checkClaims(db: Database, input: FinishRequestInput) {
  if (!(await workspaceAccess(db, input.userId, input.workspace))) {
    throw new Error("Telemetry user mismatch.");
  }
  if (input.apiKey) {
    const [key] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, input.apiKey), eq(apiKeys.workspace, input.workspace)));
    if (!key) throw new Error("Telemetry key mismatch.");
  }
  if (input.chatId) {
    if (!(await chatVisibleInWorkspace(db, input.userId, input.chatId, input.workspace))) {
      throw new Error("Telemetry chat mismatch.");
    }
  } else if (input.source === "chatroom") {
    throw new Error("Chatroom telemetry requires chat attribution.");
  }
}

async function findOrCreateSession(db: Database, input: FinishRequestInput) {
  if (!input.session) return undefined;
  const { key, parentKey } = input.session;
  const [created] = await db
    .insert(telemetrySessions)
    .values({
      workspace: input.workspace,
      key,
      parentKey,
      chat: input.chatId,
      source: input.source,
      startedAt: new Date(input.startedAt),
    })
    .onConflictDoNothing({ target: [telemetrySessions.workspace, telemetrySessions.key] })
    .returning({ id: telemetrySessions.id });
  if (created) return created.id;
  const [found] = await db
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .where(and(eq(telemetrySessions.workspace, input.workspace), eq(telemetrySessions.key, key)));
  if (!found) throw new Error("Telemetry session was not stored.");
  return found.id;
}

/** What {@link finishRequest} stored: the row, whether this call inserted it, its export job. */
export type FinishedRequest = {
  id: string;
  /** False when the request was already stored (a retried or concurrent call). */
  inserted: boolean;
  /** The `telemetry.export` job queued with the row, for `dispatchJobs` after commit. */
  exportJob: string | null;
};

/**
 * Record one finished Gateway request, idempotent by `(workspace, requestId)`: a retried call
 * returns the existing row's id. The caller ingests blobs and nodes first; `prefix` is the
 * deepest chain node found before its own nodes were inserted. The insert queues the request's
 * privacy-mode export in the same transaction (`export.ts`), so the job exists exactly when the
 * row does and a retried call never queues a second one.
 */
export async function finishRequest(
  db: Database,
  input: FinishRequestInput,
): Promise<FinishedRequest> {
  const existing = await requestByRequestId(db, input.workspace, input.requestId);
  if (existing) return { id: existing, inserted: false, exportJob: null };

  await checkClaims(db, input);
  const nodes = await workspaceNodes(db, input.workspace, [input.input, input.prefix, input.output]);

  return await db.transaction(async (tx) => {
    const session = await findOrCreateSession(tx, input);
    const startedAt = new Date(input.startedAt);

    let previous: RequestRow | undefined;
    let sessionHasRequests = false;
    if (session) {
      [previous] = await tx
        .select()
        .from(telemetryRequests)
        .where(
          and(eq(telemetryRequests.session, session), lte(telemetryRequests.startedAt, startedAt)),
        )
        .orderBy(desc(telemetryRequests.startedAt), desc(telemetryRequests.id))
        .limit(1);
      sessionHasRequests =
        previous !== undefined ||
        (
          await tx
            .select({ id: telemetryRequests.id })
            .from(telemetryRequests)
            .where(eq(telemetryRequests.session, session))
            .limit(1)
        ).length > 0;
    }

    const lineage = await classifyLineage(tx, {
      session,
      sessionHasRequests,
      previous,
      input: input.input === undefined ? undefined : nodes.get(input.input),
      prefix: input.prefix === undefined ? undefined : nodes.get(input.prefix),
      forked: input.forked ?? false,
    });
    const changes = classifyChanges(previous, input);

    const [inserted] = await tx
      .insert(telemetryRequests)
      .values({
        workspace: input.workspace,
        requestId: input.requestId,
        source: input.source,
        apiKey: input.apiKey,
        userId: input.userId,
        chat: input.chatId,
        session,
        model: input.model,
        provider: input.provider,
        credential: input.credential,
        stream: input.stream,
        status: input.status,
        startedAt,
        endedAt: new Date(input.endedAt),
        durationMs: input.durationMs,
        ttftMs: input.ttftMs,
        generationMs: input.generationMs,
        finishReason: input.finishReason,
        usage: input.usage,
        requestedServiceTier: input.requestedServiceTier,
        servedServiceTier: input.servedServiceTier,
        estimatedCost: input.estimatedCost,
        reportedCost: input.reportedCost,
        upstreamInferenceCost: input.upstreamInferenceCost,
        providerGenerationId: input.providerGenerationId,
        chatCompletion: input.chatCompletion,
        sealedErrorEpoch: input.sealedError?.epoch,
        sealedErrorRequestId: input.sealedError?.requestId,
        sealedErrorCapsule: input.sealedError?.capsule,
        sealedErrorEnvelope: input.sealedError?.envelope,
        canceled: input.canceled ?? false,
        attempts: input.attempts.map(({ message: _message, ...attempt }) => attempt),
        input: input.input,
        output: input.output,
        system: input.system,
        toolset: input.toolset,
        params: input.params,
        headers: input.headers,
        recordsInputs: input.recordsInputs,
        recordsOutputs: input.recordsOutputs,
        lineage,
        changes,
      })
      .onConflictDoNothing({
        target: [telemetryRequests.workspace, telemetryRequests.requestId],
      })
      .returning({ id: telemetryRequests.id });
    if (inserted) {
      return {
        id: inserted.id,
        inserted: true,
        exportJob: await queueRequestExport(tx, input.workspace, inserted.id),
      };
    }

    // A concurrent call with the same request id won.
    const winner = await requestByRequestId(tx, input.workspace, input.requestId);
    if (!winner) throw new Error("Telemetry request was not stored.");
    return { id: winner, inserted: false, exportJob: null };
  });
}
