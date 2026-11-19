import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { readMigrationState } from "./migration-contract";
import { directAudience } from "./migration-telemetry-attribution";
import { verdictSurvivesReferrer, type TelemetryAudience } from "./migration-telemetry-contract";
import { holdsTelemetryCustody, invalidateTelemetryProofs, persistedAudience } from "./migration-telemetry-proofs";

// Which native captures can change a finished custody proof?
//
// A proof of a custodial blob or node tallies the requests that reach it: directly (`system`,
// `params`, `headers`, `toolset`, or a custodial tool inside the toolset), through a node whose
// message blob it is, or through a custodial node or one of its descendants. A native request
// therefore matters only when its own blobs or its node chain touch custodial history. Everything
// is derived here from stored rows; no caller flag is trusted.
//
// Custody CAN grow after cutover: `realRunRefusal` admits a seal whenever the state is frozen, and
// an operator may re-freeze after `finishCutover`. So "no custody on this chain" is not permanent.
// Memos (`custodyFree`) are therefore stamped with the migration generation
// (`custodyFreeGeneration`) and trusted only while it equals the current one. Every freeze
// transition bumps the generation, and stamps are written only while unfrozen (a seal needs the
// freeze, and this transaction reads the state document, so OCC serializes it against a freeze).
// A hidden ancestor that turned custodial in a later freeze therefore invalidates every older memo
// and is rediscovered by a fresh walk. A row without a valid memo is unknown and is resolved from its
// stored ancestry on demand. Malformed or cross-workspace ancestry, oversized walks and oversized
// toolsets stay conservative (reach).

/** Unmemoized ancestors one walk may read and later memoize; deeper chains count as reaching. */
const MAX_WALK = 1000;
/** Tools of a toolset checked per request; larger toolsets count as reaching. */
const MAX_TOOLSET_MEMBERS = 256;

function isCustodial(row: { legacyContent?: { kind: string } }): boolean {
  return row.legacyContent?.kind === "custody";
}

/**
 * The migration generation to trust memos under, or `undefined` when native captures need no check
 * at all: cutover is complete, custody is active, writers are not frozen, and the workspace still
 * holds a custodial blob or node. While frozen nothing is stamped or trusted (and capture itself is
 * frozen-gated); before cutover proofs are not trusted by generation fencing anyway.
 */
export async function trackedGeneration(ctx: MutationCtx, workspace: Id<"workspaces">): Promise<number | undefined> {
  const state = await readMigrationState(ctx);
  if (!state || state.custodyState !== "active" || !state.cutoverComplete || state.frozen) return undefined;
  return await holdsTelemetryCustody(ctx, workspace) ? state.generation : undefined;
}

/**
 * Whether the node, one of its ancestors, or any message blob on that path is (or was) custodial.
 * Resolved bottom-up and stops at the first valid memo; every unmemoized node walked is stamped
 * with the shared answer and `generation` (valid because the walk found no custody below its
 * terminal). A memo from another generation is ignored and rewritten. Custodial rows are never
 * patched, so release and sealing fingerprints are unaffected.
 */
export async function nodeReachesCustody(ctx: MutationCtx, node: Doc<"telemetry_nodes">, generation: number): Promise<boolean> {
  const unknown: Array<Doc<"telemetry_nodes">> = [];
  let current = node;
  let reaches = false;
  for (;;) {
    if (current.custodyFree !== undefined && current.custodyFreeGeneration === generation) {
      reaches = !current.custodyFree;
      break;
    }
    if (isCustodial(current)) {
      reaches = true;
      break;
    }
    const blob = await ctx.db.get("telemetry_blobs", current.blob);
    if (!blob || blob.workspace !== current.workspace) return true;
    unknown.push(current);
    if (isCustodial(blob)) {
      reaches = true;
      break;
    }
    if (!current.parent) break;
    if (unknown.length >= MAX_WALK) return true;
    const parent = await ctx.db.get("telemetry_nodes", current.parent);
    if (!parent || parent.workspace !== current.workspace) return true;
    current = parent;
  }
  for (const entry of unknown) {
    await ctx.db.patch("telemetry_nodes", entry._id, { custodyFree: !reaches, custodyFreeGeneration: generation });
  }
  return reaches;
}

/** Memo value for a node being inserted below a parent whose reach is already known. */
export async function insertedNodeReachesCustody(
  ctx: MutationCtx,
  node: { workspace: Id<"workspaces">; blob: Id<"telemetry_blobs"> },
  parentReaches: boolean,
): Promise<boolean> {
  if (parentReaches) return true;
  const blob = await ctx.db.get("telemetry_blobs", node.blob);
  return !blob || blob.workspace !== node.workspace || isCustodial(blob);
}

/**
 * True when one more request referencing this blob cannot change any finished proof: the blob (and,
 * for a toolset, each tool in it) is not custodial, or its current proof already settled on a
 * verdict that the request's audience cannot alter. A toolset without custodial tools is
 * memoized so later requests skip the member scan.
 */
async function blobReferenceStable(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  id: Id<"telemetry_blobs">,
  generation: number,
  audience: () => Promise<TelemetryAudience>,
): Promise<boolean> {
  const blob = await ctx.db.get("telemetry_blobs", id);
  if (!blob || blob.workspace !== workspace) return false;
  if (isCustodial(blob) && !await proofSurvives(ctx, id, audience)) return false;
  if (blob.kind !== "toolset" || (blob.custodyFree === true && blob.custodyFreeGeneration === generation)) return true;

  const members = await ctx.db.query("telemetry_toolset_tools")
    .withIndex("by_toolset_and_position", (q) => q.eq("toolset", id)).take(MAX_TOOLSET_MEMBERS + 1);
  if (members.length > MAX_TOOLSET_MEMBERS) return false;
  let custodyFree = !isCustodial(blob);
  for (const member of members) {
    const tool = await ctx.db.get("telemetry_blobs", member.tool);
    if (!tool || tool.workspace !== workspace) return false;
    if (!isCustodial(tool)) continue;
    custodyFree = false;
    if (!await proofSurvives(ctx, member.tool, audience)) return false;
  }
  if (custodyFree) await ctx.db.patch("telemetry_blobs", id, { custodyFree: true, custodyFreeGeneration: generation });
  return true;
}

async function proofSurvives(ctx: MutationCtx, blob: Id<"telemetry_blobs">, audience: () => Promise<TelemetryAudience>) {
  const verdict = await persistedAudience(ctx, "telemetry_blobs", blob);
  return verdict !== undefined && verdictSurvivesReferrer(verdict, await audience());
}

/**
 * Called after a native request row is inserted. Bumps the workspace proof revision (and so
 * coalesces a re-proof and release pass) only when the request reaches custodial history in a way
 * that can alter a finished proof; unrelated traffic writes nothing here. `nodes` are the
 * request's input/output nodes, `blobs` its system/params/headers/toolset blobs, all read from the
 * stored request rather than taken from the caller.
 */
export async function invalidateForCapturedRequest(
  ctx: MutationCtx,
  request: {
    workspace: Id<"workspaces">;
    chatId: Id<"aisdk_chats"> | undefined;
    nodes: Array<Doc<"telemetry_nodes"> | null>;
    blobs: Array<Id<"telemetry_blobs"> | undefined>;
  },
): Promise<void> {
  const generation = await trackedGeneration(ctx, request.workspace);
  if (generation === undefined) return;
  for (const node of request.nodes) {
    if (node && await nodeReachesCustody(ctx, node, generation)) return await invalidateTelemetryProofs(ctx, request.workspace);
  }

  let requestAudience: TelemetryAudience | undefined;
  const audience = async () => {
    if (requestAudience) return requestAudience;
    const workspace = await ctx.db.get("workspaces", request.workspace);
    if (!workspace) throw new Error("Telemetry workspace is missing");
    requestAudience = await directAudience(ctx, workspace, request.chatId);
    return requestAudience;
  };
  for (const blob of request.blobs) {
    if (blob && !await blobReferenceStable(ctx, request.workspace, blob, generation, audience)) {
      return await invalidateTelemetryProofs(ctx, request.workspace);
    }
  }
}
