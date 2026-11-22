import type { LoadedBlob, LoadedNode } from "contracts/telemetry/store";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { QueryCtx } from "../../convex/_generated/server";

/**
 * Largest canonical JSON (UTF-8 bytes) stored inline on a blob row. Larger content goes to
 * file storage so a blob document stays well under Convex's 1 MiB document limit.
 */
export const INLINE_BLOB_LIMIT = 900_000;

/** Resolve one blob; `workspace` guards against cross-workspace pointers. */
export async function loadBlob(
  ctx: Pick<QueryCtx, "db" | "storage">,
  workspace: Id<"workspaces">,
  id: Id<"telemetry_blobs"> | undefined,
): Promise<LoadedBlob | null> {
  if (!id) return null;
  const blob = await ctx.db.get("telemetry_blobs", id);
  if (!blob || blob.workspace !== workspace) return null;
  return toLoadedBlob(ctx, blob);
}

async function toLoadedBlob(
  ctx: Pick<QueryCtx, "storage">,
  blob: Doc<"telemetry_blobs">,
): Promise<LoadedBlob> {
  const storageUrl = blob.storage
    ? ((await ctx.storage.getUrl(blob.storage)) ?? undefined)
    : undefined;
  return {
    id: blob._id,
    hash: blob.hash,
    kind: blob.kind,
    size: blob.size,
    meta: blob.legacyContent ? undefined : blob.meta,
    truncated: blob.truncated,
    content: blob.legacyContent ? undefined : blob.content,
    storageUrl: blob.sealed || blob.legacyContent ? undefined : storageUrl,
    sealed: blob.sealed ? { ...blob.sealed, storageUrl } : undefined,
    legacyContent: blob.legacyContent,
    redacted: blob.content === undefined && blob.storage === undefined && blob.sealed === undefined && blob.legacyContent === undefined,
  };
}

/**
 * Walk up to `limit` nodes from `leaf` toward the root and return them oldest-first.
 * `more` reports whether older nodes exist; continue from `nextLeaf` to page further back.
 * Each node costs two document reads, so keep `limit` well below the per-query read budget.
 */
export async function loadChain(
  ctx: Pick<QueryCtx, "db" | "storage">,
  workspace: Id<"workspaces">,
  leaf: Id<"telemetry_nodes"> | undefined,
  limit: number,
): Promise<{ nodes: LoadedNode[]; more: boolean; nextLeaf?: Id<"telemetry_nodes"> }> {
  const nodes: LoadedNode[] = [];
  let cursor = leaf;
  while (cursor && nodes.length < limit) {
    const node = await ctx.db.get("telemetry_nodes", cursor);
    if (!node || node.workspace !== workspace) break;
    const message = await loadBlob(ctx, workspace, node.blob);
    if (!message) break;
    nodes.push({ id: node._id, depth: node.depth, origin: node.origin, message });
    cursor = node.parent;
  }
  nodes.reverse();
  return { nodes, more: cursor !== undefined, nextLeaf: cursor };
}

/** Tool blobs of a toolset in request order. */
export async function loadToolset(
  ctx: Pick<QueryCtx, "db" | "storage">,
  workspace: Id<"workspaces">,
  toolset: Id<"telemetry_blobs"> | undefined,
): Promise<LoadedBlob[]> {
  if (!toolset) return [];
  const members = await ctx.db
    .query("telemetry_toolset_tools")
    .withIndex("by_toolset_and_position", (q) => q.eq("toolset", toolset))
    .take(1024);
  const tools: LoadedBlob[] = [];
  for (const member of members) {
    if (member.workspace !== workspace) continue;
    const tool = await loadBlob(ctx, workspace, member.tool);
    if (tool) tools.push(tool);
  }
  return tools;
}
