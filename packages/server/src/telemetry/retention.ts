import { and, asc, eq, inArray, isNull, lt, notExists, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../drivers/types";
import { dispatchJobs, enqueueJob } from "../jobs/outbox";
import type { Runtime } from "../runtime";
import { telemetryRetentionPage } from "../workspaces/settings";
import { requireVisibleRequest, requireVisibleSession } from "./reads";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
  telemetryToolsetTools,
} from "./schema";
import { queryRows } from "./store";

/**
 * Owner deletes, retention and garbage collection (Convex `observability/telemetryRetention.ts`).
 *
 * Blobs and nodes are content addressed and shared, so deleting a request only queues its
 * pointers for collection: a `telemetry.gc` outbox job, written in the delete's transaction,
 * carries the candidate blob and node ids (no queue table). The job deletes the candidates that
 * nothing references any more, walks up a conversation chain while each parent loses its last
 * child, releases the members of a deleted toolset, and deletes object-store envelopes of
 * deleted blobs after the row delete commits.
 *
 * GC never deletes a referenced row, and a concurrent capture never leaves a dangling pointer:
 * GC first locks its doomed rows (`for update`, which waits for any transaction that is inserting
 * a reference, since that holds `for key share` on the target), then re-checks "unreferenced" in
 * a new statement that sees everything committed before the lock, and deletes only rows that are
 * still unreferenced. A capture that references a row after GC locked it waits, and once GC
 * commits its foreign-key check fails; capture then stores the request again from scratch once
 * (`capture.ts`), recreating the content it needs. The `no action` foreign keys stay the safety
 * net.
 */

export const GC_JOB = "telemetry.gc";
const DAY_MS = 86_400_000;
/** Candidate ids per `telemetry.gc` job. */
const GC_IDS_PER_JOB = 1000;
/** Requests deleted per transaction. */
const REQUEST_BATCH = 500;
/** Request batches per workspace and retention run (10,000 requests). */
const RETENTION_BATCHES = 20;
const SESSION_BATCH = 200;
/** Workspaces with a retention period read per settings page. */
const SETTINGS_PAGE = 200;
/** Collection rounds per job; a chain needs one round per fork point it passes. */
const NODE_ROUNDS = 100;
/** Blob rounds: candidates, then the tools of deleted toolsets. */
const BLOB_ROUNDS = 3;

const gcPayload = z.object({
  workspace: z.string().min(1).max(256),
  nodes: z.array(z.string().max(256)).max(GC_IDS_PER_JOB),
  blobs: z.array(z.string().max(256)).max(GC_IDS_PER_JOB),
});

/** The pointers of a deleted request. */
const requestRefs = {
  input: telemetryRequests.input,
  output: telemetryRequests.output,
  system: telemetryRequests.system,
  toolset: telemetryRequests.toolset,
  params: telemetryRequests.params,
  headers: telemetryRequests.headers,
  legacyInput: telemetryRequests.legacyInput,
  legacyOutput: telemetryRequests.legacyOutput,
  legacySpans: telemetryRequests.legacySpans,
};
type RequestRefs = { [Key in keyof typeof requestRefs]: string | null };

function* chunks<Item>(items: readonly Item[], size: number) {
  for (let start = 0; start < items.length; start += size) yield items.slice(start, start + size);
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** Queues collection of what `deleted` requests pointed at; returns the job ids. */
async function queueCollection(
  tx: Database,
  workspace: string,
  deleted: readonly RequestRefs[],
): Promise<string[]> {
  const nodeIds = new Set<string>();
  const blobIds = new Set<string>();
  for (const row of deleted) {
    for (const node of [row.input, row.output]) if (node) nodeIds.add(node);
    for (const blob of [
      row.system,
      row.toolset,
      row.params,
      row.headers,
      row.legacyInput,
      row.legacyOutput,
      row.legacySpans,
    ]) {
      if (blob) blobIds.add(blob);
    }
  }
  return await queueGc(tx, workspace, [...nodeIds], [...blobIds]);
}

async function queueGc(
  tx: Database,
  workspace: string,
  nodes: readonly string[],
  blobs: readonly string[],
): Promise<string[]> {
  const jobs: string[] = [];
  const nodeChunks = [...chunks(nodes, GC_IDS_PER_JOB)];
  const blobChunks = [...chunks(blobs, GC_IDS_PER_JOB)];
  for (let index = 0; index < Math.max(nodeChunks.length, blobChunks.length); index++) {
    const id = await enqueueJob(tx, {
      kind: GC_JOB,
      payload: { workspace, nodes: nodeChunks[index] ?? [], blobs: blobChunks[index] ?? [] },
    });
    if (id) jobs.push(id);
  }
  return jobs;
}

/** Deletes the given requests of `workspace` and queues collection; returns how many and jobs. */
async function deleteRequestRows(tx: Database, workspace: string, ids: readonly string[]) {
  if (ids.length === 0) return { deleted: 0, jobs: [] as string[] };
  const deleted = await tx
    .delete(telemetryRequests)
    .where(and(eq(telemetryRequests.workspace, workspace), inArray(telemetryRequests.id, [...ids])))
    .returning(requestRefs);
  return { deleted: deleted.length, jobs: await queueCollection(tx, workspace, deleted) };
}

/**
 * Deletes sessions among `ids` that have no request left. The rows are locked first, so a
 * capture inserting a request into one of them commits before the "no requests" check (and is
 * seen) or waits for this transaction and stores its request again in a new session.
 */
async function deleteEmptySessions(tx: Database, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const locked = await tx
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .where(inArray(telemetrySessions.id, [...ids]))
    .orderBy(asc(telemetrySessions.id))
    .for("update", { skipLocked: true });
  if (locked.length === 0) return 0;
  const removed = await tx
    .delete(telemetrySessions)
    .where(
      and(
        inArray(
          telemetrySessions.id,
          locked.map((row) => row.id),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(telemetryRequests)
            .where(eq(telemetryRequests.session, telemetrySessions.id)),
        ),
      ),
    )
    .returning({ id: telemetrySessions.id });
  return removed.length;
}

/** Owner only; a hidden request is "Request not found." like a missing one. */
export async function deleteRequest(runtime: Runtime, userId: string, id: string): Promise<null> {
  const { db } = runtime.drivers;
  const { request, owner } = await requireVisibleRequest(db, userId, id);
  const { jobs } = await db.transaction((tx) => deleteRequestRows(tx, owner.workspace, [request.id]));
  runtime.defer(dispatchJobs(runtime, jobs));
  return null;
}

/**
 * Owner only. Deletes the session's requests that have no chat or belong to the session's own
 * (already authorized) chat, in bounded transactions, then the session once nothing is left in
 * it. Requests of other chats in the same session stay, and so does the session.
 */
export async function deleteSession(runtime: Runtime, userId: string, id: string): Promise<null> {
  const { db } = runtime.drivers;
  const { session, owner } = await requireVisibleSession(db, userId, id);
  const ownChat =
    session.chat === null
      ? isNull(telemetryRequests.chat)
      : or(isNull(telemetryRequests.chat), eq(telemetryRequests.chat, session.chat));
  const jobs: string[] = [];
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: telemetryRequests.id })
        .from(telemetryRequests)
        .where(and(eq(telemetryRequests.session, session.id), ownChat))
        .orderBy(asc(telemetryRequests.startedAt), asc(telemetryRequests.id))
        .limit(REQUEST_BATCH)
        .for("update", { skipLocked: true });
      return await deleteRequestRows(
        tx,
        owner.workspace,
        rows.map((row) => row.id),
      );
    });
    jobs.push(...batch.jobs);
    if (batch.deleted < REQUEST_BATCH) break;
  }
  await db.transaction((tx) => deleteEmptySessions(tx, [session.id]));
  runtime.defer(dispatchJobs(runtime, jobs));
  return null;
}

/**
 * One retention pass (the hourly `telemetry:retention` task): for each workspace with
 * `telemetry_retention_days`, deletes requests started before the cutoff (up to
 * {@link RETENTION_BATCHES} batches; a backlog drains over the next runs), then sessions past the
 * cutoff that have no request left, and queues collection of what the requests pointed at.
 */
export async function pruneTelemetry(
  runtime: Runtime,
  now: number,
): Promise<{ workspaces: number; requests: number; sessions: number }> {
  const { db } = runtime.drivers;
  let after: string | null = null;
  const totals = { workspaces: 0, requests: 0, sessions: 0 };
  for (;;) {
    const page = await telemetryRetentionPage(db, after, SETTINGS_PAGE);
    for (const { workspace, days } of page) {
      totals.workspaces += 1;
      const cutoff = new Date(now - days * DAY_MS);
      for (let round = 0; round < RETENTION_BATCHES; round++) {
        const batch = await db.transaction(async (tx) => {
          const rows = await tx
            .select({ id: telemetryRequests.id })
            .from(telemetryRequests)
            .where(
              and(eq(telemetryRequests.workspace, workspace), lt(telemetryRequests.startedAt, cutoff)),
            )
            .orderBy(asc(telemetryRequests.startedAt), asc(telemetryRequests.id))
            .limit(REQUEST_BATCH)
            .for("update", { skipLocked: true });
          return await deleteRequestRows(
            tx,
            workspace,
            rows.map((row) => row.id),
          );
        });
        totals.requests += batch.deleted;
        runtime.defer(dispatchJobs(runtime, batch.jobs));
        if (batch.deleted < REQUEST_BATCH) break;
      }
      for (let round = 0; round < RETENTION_BATCHES; round++) {
        const removed = await db.transaction(async (tx) => {
          const candidates = await tx
            .select({ id: telemetrySessions.id })
            .from(telemetrySessions)
            .where(
              and(
                eq(telemetrySessions.workspace, workspace),
                lt(telemetrySessions.startedAt, cutoff),
                notExists(
                  tx
                    .select({ one: sql`1` })
                    .from(telemetryRequests)
                    .where(eq(telemetryRequests.session, telemetrySessions.id)),
                ),
              ),
            )
            .orderBy(asc(telemetrySessions.startedAt), asc(telemetrySessions.id))
            .limit(SESSION_BATCH);
          return await deleteEmptySessions(
            tx,
            candidates.map((row) => row.id),
          );
        });
        totals.sessions += removed;
        if (removed < SESSION_BATCH) break;
      }
    }
    if (page.length < SETTINGS_PAGE) break;
    after = page.at(-1)!.workspace;
  }
  return totals;
}

/** Nodes of `candidates` that nothing references, plus each ancestor that only they keep. */
function doomedNodes(tx: Database, workspace: string, candidates: readonly string[]) {
  const unreferenced = (node: SQL) => sql`
    not exists (select 1 from ${telemetryRequests} where ${telemetryRequests.input} = ${node})
    and not exists (select 1 from ${telemetryRequests} where ${telemetryRequests.output} = ${node})`;
  return queryRows<{ id: string }>(
    tx,
    sql`with recursive doomed (id, parent) as (
      select node.id, node.parent from telemetry_nodes node
        where node.workspace = ${workspace} and node.id in (${idList(candidates)})
          and not exists (select 1 from telemetry_nodes child where child.parent = node.id)
          and ${unreferenced(sql`node.id`)}
      union
      select node.id, node.parent from telemetry_nodes node join doomed on node.id = doomed.parent
        where (select count(*) from telemetry_nodes child where child.parent = node.id) = 1
          and ${unreferenced(sql`node.id`)}
    ) select id from doomed`,
  );
}

/**
 * Deletes the unreferenced nodes among `candidates` and the ancestors only they kept. Returns
 * their blobs, and the parents of deleted nodes that still exist (a fork point, re-checked in the
 * next round once all its deleted children are gone).
 */
async function collectNodes(tx: Database, workspace: string, candidates: readonly string[]) {
  const first = await doomedNodes(tx, workspace, candidates);
  if (first.length === 0) return { blobs: [], retry: [] };
  const locked = await tx
    .select({ id: telemetryNodes.id })
    .from(telemetryNodes)
    .where(
      inArray(
        telemetryNodes.id,
        first.map((row) => row.id),
      ),
    )
    .orderBy(asc(telemetryNodes.id))
    .for("update");
  // Re-checked under the locks: a reference committed meanwhile keeps its node.
  const lockedIds = new Set(locked.map((row) => row.id));
  const still = (await doomedNodes(tx, workspace, candidates))
    .map((row) => row.id)
    .filter((id) => lockedIds.has(id));
  if (still.length === 0) return { blobs: [], retry: [] };
  const deleted = await tx
    .delete(telemetryNodes)
    .where(inArray(telemetryNodes.id, still))
    .returning({ id: telemetryNodes.id, parent: telemetryNodes.parent, blob: telemetryNodes.blob });
  const gone = new Set(deleted.map((row) => row.id));
  return {
    blobs: deleted.map((row) => row.blob),
    retry: [
      ...new Set(
        deleted.flatMap((row) => (row.parent && !gone.has(row.parent) ? [row.parent] : [])),
      ),
    ],
  };
}

function blobUnreferenced(blob: SQL) {
  const requestColumns = [
    telemetryRequests.system,
    telemetryRequests.toolset,
    telemetryRequests.params,
    telemetryRequests.headers,
    telemetryRequests.legacyInput,
    telemetryRequests.legacyOutput,
    telemetryRequests.legacySpans,
  ];
  return sql.join(
    [
      sql`not exists (select 1 from ${telemetryNodes} where ${telemetryNodes.blob} = ${blob})`,
      sql`not exists (select 1 from ${telemetryToolsetTools} where ${telemetryToolsetTools.tool} = ${blob})`,
      ...requestColumns.map(
        (column) => sql`not exists (select 1 from ${telemetryRequests} where ${column} = ${blob})`,
      ),
    ],
    sql` and `,
  );
}

/**
 * Deletes the unreferenced blobs among `candidates` (locked first, then re-checked); a deleted
 * toolset's member rows go with it by cascade. Returns the object keys to delete after commit
 * and the member tools of deleted toolsets, for the next round.
 */
async function collectBlobs(tx: Database, workspace: string, candidates: readonly string[]) {
  const locked = await tx
    .select({ id: telemetryBlobs.id })
    .from(telemetryBlobs)
    .where(and(eq(telemetryBlobs.workspace, workspace), inArray(telemetryBlobs.id, [...candidates])))
    .orderBy(asc(telemetryBlobs.id))
    .for("update");
  if (locked.length === 0) return { keys: [], tools: [] };
  const ids = locked.map((row) => row.id);
  const members = await tx
    .select({ toolset: telemetryToolsetTools.toolset, tool: telemetryToolsetTools.tool })
    .from(telemetryToolsetTools)
    .where(inArray(telemetryToolsetTools.toolset, ids));
  const deleted = await tx
    .delete(telemetryBlobs)
    .where(and(inArray(telemetryBlobs.id, ids), blobUnreferenced(sql`${telemetryBlobs.id}`)))
    .returning({ id: telemetryBlobs.id, storageKey: telemetryBlobs.storageKey });
  const gone = new Set(deleted.map((row) => row.id));
  return {
    keys: deleted.flatMap((row) => (row.storageKey ? [row.storageKey] : [])),
    tools: [...new Set(members.filter((row) => gone.has(row.toolset)).map((row) => row.tool))],
  };
}

/**
 * Handler of the `telemetry.gc` job. Idempotent: candidates that are gone or still referenced
 * are skipped. Work left after the round bounds (a very branchy chain) is queued as a new job.
 */
export async function runGcJob(runtime: Runtime, payload: unknown): Promise<void> {
  const { db, objects } = runtime.drivers;
  const { workspace, nodes, blobs } = gcPayload.parse(payload);
  const blobCandidates = new Set(blobs);
  let pendingNodes = nodes;
  for (let round = 0; pendingNodes.length > 0 && round < NODE_ROUNDS; round++) {
    const result = await db.transaction((tx) => collectNodes(tx, workspace, pendingNodes));
    for (const blob of result.blobs) blobCandidates.add(blob);
    pendingNodes = result.retry;
  }

  const keys: string[] = [];
  let pendingBlobs = [...blobCandidates];
  for (let round = 0; pendingBlobs.length > 0 && round < BLOB_ROUNDS; round++) {
    const next: string[] = [];
    for (const batch of chunks(pendingBlobs, GC_IDS_PER_JOB)) {
      const result = await db.transaction((tx) => collectBlobs(tx, workspace, batch));
      keys.push(...result.keys);
      next.push(...result.tools);
    }
    pendingBlobs = next;
  }

  if (pendingNodes.length > 0 || pendingBlobs.length > 0) {
    const jobs = await db.transaction((tx) => queueGc(tx, workspace, pendingNodes, pendingBlobs));
    runtime.defer(dispatchJobs(runtime, jobs));
  }
  // After the deletes committed: an object is never removed while a row still points at it.
  for (const key of keys) await objects.delete(key);
}
