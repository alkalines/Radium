import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { TelemetryBlobKind, TelemetryBlobMeta } from "contracts/telemetry/validators";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import type { StoredJson } from "../db/columns";
import { toBase64Url } from "radium-crypto";
import type { Database } from "../drivers/types";
import type { Runtime } from "../runtime";
import { telemetryBlobs, telemetryNodes, telemetryToolsetTools } from "./schema";

/**
 * Read side of telemetry storage (Convex `src/telemetry/store.ts`): blobs, toolsets and message
 * chains as returned to the owner. Sealed content goes out as it is stored, for the owner's
 * client to open: the capsule and envelope as base64url, or for an envelope in the object store
 * a presigned GET URL (`storageUrl`, as Convex returned a storage URL) or, when the object store
 * cannot presign (local disk), the envelope bytes themselves.
 */

/**
 * Largest sealed envelope kept inline in `telemetry_blobs.sealed_envelope`; larger ones go to the
 * object store (Convex `INLINE_BLOB_LIMIT`).
 */
export const INLINE_ENVELOPE_LIMIT = 900_000;
/** Presigned object URLs stay valid this long: a detail view may open its content later. */
const PRESIGNED_GET_SECONDS = 15 * 60;
/** Tools read per toolset (Convex `loadToolset`). */
const TOOLSET_LIMIT = 1024;

/** A new object key for one sealed envelope (`files/<uuid>`). */
export function newEnvelopeKey() {
  return `files/${crypto.randomUUID()}`;
}

/** Rows of a raw statement; the driver returns them as an array (`Bun.SQL`) or under `rows`. */
export async function queryRows<Row>(db: Database, query: SQL): Promise<Row[]> {
  const result: unknown = await db.execute(query);
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)
      ? result.rows
      : [];
  // Column names and types are fixed by the caller's own `select` list.
  return rows as Row[];
}

/** Content sealed to the owner key under the capsule of request `requestId`. */
export type WireSealed = {
  epoch: number;
  requestId: string;
  /** base64url. */
  capsule: string;
  /** base64url; null when it is fetched from `storageUrl`. */
  envelope: string | null;
  storageUrl: string | null;
};

/** One blob as the owner reads it (`contracts/telemetry/store` `LoadedBlob`, wire form). */
export type WireBlob = {
  id: string;
  hash: string;
  kind: TelemetryBlobKind;
  size: number;
  meta: TelemetryBlobMeta | null;
  truncated: boolean;
  /** Historical plaintext canonical JSON. */
  content: string | null;
  /** Presigned URL of historical plaintext content in the object store. */
  storageUrl: string | null;
  legacyContent: StoredJson<LegacyBox> | null;
  sealed: WireSealed | null;
  /** Only the fingerprint and metadata were captured. */
  redacted: boolean;
};

export type WireNode = {
  id: string;
  depth: number;
  origin: "input" | "output";
  message: WireBlob;
};

type BlobRow = typeof telemetryBlobs.$inferSelect;
type Objects = Runtime["drivers"]["objects"];

/** A presigned GET, or the object's bytes when the store cannot presign. */
async function resolveObject(objects: Objects, key: string) {
  const url = objects.presignGet(key, { expiresInSeconds: PRESIGNED_GET_SECONDS });
  if (url !== null) return { url, bytes: null };
  return { url: null, bytes: await objects.get(key) };
}

async function toWireBlob(objects: Objects, row: BlobRow): Promise<WireBlob> {
  const stored = row.storageKey ? await resolveObject(objects, row.storageKey) : null;
  const sealed =
    row.sealedEpoch !== null
      ? {
          epoch: row.sealedEpoch,
          requestId: row.sealedRequestId!,
          capsule: toBase64Url(row.sealedCapsule!),
          envelope: row.sealedEnvelope
            ? toBase64Url(row.sealedEnvelope)
            : stored?.bytes
              ? toBase64Url(stored.bytes)
              : null,
          storageUrl: stored?.url ?? null,
        }
      : null;
  const legacy = row.legacyContent;
  const plainStored = !sealed && !legacy && stored?.bytes ? new TextDecoder().decode(stored.bytes) : null;
  return {
    id: row.id,
    hash: row.hash,
    kind: row.kind,
    size: row.size,
    meta: legacy ? null : row.meta,
    truncated: row.truncated,
    content: legacy ? null : (row.content ?? plainStored),
    storageUrl: sealed || legacy ? null : (stored?.url ?? null),
    legacyContent: legacy,
    sealed,
    redacted:
      row.content === null && row.storageKey === null && sealed === null && legacy === null,
  };
}

/** The workspace's blobs among `ids`, by id; ids of another workspace are absent. */
export async function loadBlobs(
  runtime: Pick<Runtime, "drivers">,
  workspace: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, WireBlob>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return new Map();
  const rows = await runtime.drivers.db
    .select()
    .from(telemetryBlobs)
    .where(and(eq(telemetryBlobs.workspace, workspace), inArray(telemetryBlobs.id, wanted)));
  const blobs = await Promise.all(rows.map((row) => toWireBlob(runtime.drivers.objects, row)));
  return new Map(blobs.map((blob) => [blob.id, blob]));
}

/** Tool blobs of each toolset in request order. */
export async function loadToolsets(
  runtime: Pick<Runtime, "drivers">,
  workspace: string,
  toolsets: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, WireBlob[]>> {
  const wanted = [...new Set(toolsets.filter((id): id is string => typeof id === "string"))];
  const result = new Map<string, WireBlob[]>();
  await Promise.all(
    wanted.map(async (toolset) => {
      const rows = await runtime.drivers.db
        .select({ blob: telemetryBlobs })
        .from(telemetryToolsetTools)
        .innerJoin(
          telemetryBlobs,
          and(eq(telemetryBlobs.id, telemetryToolsetTools.tool), eq(telemetryBlobs.workspace, workspace)),
        )
        .where(eq(telemetryToolsetTools.toolset, toolset))
        .orderBy(asc(telemetryToolsetTools.position))
        .limit(TOOLSET_LIMIT);
      result.set(
        toolset,
        await Promise.all(rows.map((row) => toWireBlob(runtime.drivers.objects, row.blob))),
      );
    }),
  );
  return result;
}

/**
 * Up to `limit` nodes from `leaf` toward the root, oldest first, in one recursive query. `more`
 * says older nodes exist; continue from `nextLeaf`.
 */
export async function loadChain(
  runtime: Pick<Runtime, "drivers">,
  workspace: string,
  leaf: string | null,
  limit: number,
): Promise<{ nodes: WireNode[]; more: boolean; nextLeaf: string | null }> {
  if (!leaf) return { nodes: [], more: false, nextLeaf: null };
  const rows = await queryRows<{
    id: string;
    parent: string | null;
    blob: string;
    depth: number;
    origin: "input" | "output";
  }>(
    runtime.drivers.db,
    sql`with recursive chain (id, parent, blob, depth, origin, steps) as (
      select id, parent, blob, depth, origin, 1 from telemetry_nodes
        where id = ${leaf} and workspace = ${workspace}
      union all
      select node.id, node.parent, node.blob, node.depth, node.origin, chain.steps + 1
        from telemetry_nodes node join chain on node.id = chain.parent
        where chain.steps < ${limit} and node.workspace = ${workspace}
    ) select id, parent, blob, depth, origin from chain order by depth`,
  );
  const blobs = await loadBlobs(runtime, workspace, rows.map((row) => row.blob));
  // A node whose blob is missing ends the page there, as in Convex.
  let start = rows.length;
  while (start > 0 && blobs.has(rows[start - 1]!.blob)) start--;
  const kept = rows.slice(start);
  const nodes = kept.map((row) => ({
    id: row.id,
    depth: Number(row.depth),
    origin: row.origin,
    message: blobs.get(row.blob)!,
  }));
  const next = start > 0 ? rows[start - 1]!.id : (kept[0]?.parent ?? null);
  return { nodes, more: next !== null, nextLeaf: next };
}

/** Depth of each of the workspace's nodes among `ids`. */
export async function nodeDepths(
  db: Database,
  workspace: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: telemetryNodes.id, depth: telemetryNodes.depth })
    .from(telemetryNodes)
    .where(and(eq(telemetryNodes.workspace, workspace), inArray(telemetryNodes.id, wanted)));
  return new Map(rows.map((row) => [row.id, row.depth]));
}

/** Whether `ancestor` lies on the chain below `leaf`, so a cursor cannot read another branch. */
export async function isChainAncestor(
  db: Database,
  workspace: string,
  leaf: string,
  ancestor: string,
): Promise<boolean> {
  const depth = (await nodeDepths(db, workspace, [ancestor])).get(ancestor);
  if (depth === undefined) return false;
  const rows = await queryRows<{ id: string }>(
    db,
    sql`with recursive up (id, parent, depth) as (
      select id, parent, depth from telemetry_nodes where id = ${leaf} and workspace = ${workspace}
      union all
      select node.id, node.parent, node.depth from telemetry_nodes node join up on node.id = up.parent
        where up.depth > ${depth} and node.workspace = ${workspace}
    ) select id from up where id = ${ancestor}`,
  );
  return rows.length > 0;
}
