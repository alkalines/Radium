import type { Doc } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";

type Ctx = QueryCtx | MutationCtx;

/** Which fingerprint scheme produced a telemetry row's `hash`. */
export type HashScheme = "unkeyed" | "keyed";

const encoder = new TextEncoder();

/** The pre-encryption fingerprint: plain SHA-256 of the labelled workspace, kind and content. */
async function unkeyedDigest(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Marked = { legacyHashVersion?: number; legacyContent?: unknown };

/** `legacyHashVersion` 1: original keyed hash (native capture, or keyed content sealed with its hash kept). */
export const KEYED_HASH_VERSION = 1;
/** `legacyHashVersion` 2: the migration replaced a proven unkeyed hash with a keyed one. */
export const REKEYED_HASH_VERSION = 2;

/**
 * The scheme a marked row's hash ORIGINALLY had, which is what its chain neighbours inherit. A
 * sidecar says nothing about it: only the marker does. An unmarked row has no declaration.
 */
function declared(row: Marked): HashScheme | undefined {
  if (row.legacyHashVersion === undefined) return undefined;
  if (row.legacyHashVersion === KEYED_HASH_VERSION) return "keyed";
  if (row.legacyHashVersion === REKEYED_HASH_VERSION) return "unkeyed";
  throw new Error("Telemetry row has an unknown hash version");
}

/**
 * Node hashes chain `sha256("node\0ws\0" + parentHash + "\0" + blobHash)`, so an unmarked node is
 * unkeyed exactly when that recomputation matches. A keyed node never matches. A node whose
 * parent or blob was already migrated cannot be recomputed (their old hashes now live in
 * ciphertext), but chains never mix schemes, so it inherits the declared scheme of its
 * marked neighbour. A sidecar without a marker is ambiguous and blocks.
 */
export async function nodeScheme(ctx: Ctx, node: Doc<"telemetry_nodes"> & Marked): Promise<HashScheme> {
  const marked = declared(node);
  if (marked) return marked;
  const blob = await ctx.db.get("telemetry_blobs", node.blob) as (Doc<"telemetry_blobs"> & Marked) | null;
  if (!blob) throw new Error("Telemetry node has no message blob");
  if (blob.sealed) return "keyed";
  const blobMarked = declared(blob);
  if (blobMarked) return blobMarked;
  if (blob.legacyContent) throw new Error("Telemetry blob has a sidecar without a hash marker");
  const parent = node.parent ? await ctx.db.get("telemetry_nodes", node.parent) as (Doc<"telemetry_nodes"> & Marked) | null : null;
  if (node.parent && !parent) throw new Error("Telemetry node has no parent");
  const parentMarked = parent ? declared(parent) : undefined;
  if (parentMarked) return parentMarked;
  if (parent?.legacyContent) throw new Error("Telemetry node has a sidecar without a hash marker");
  const expected = await unkeyedDigest(`node\u0000${node.workspace}\u0000${parent?.hash ?? ""}\u0000${blob.hash}`);
  return expected === node.hash ? "unkeyed" : "keyed";
}

/**
 * Shape of a first-message session key. Explicit client session ids always carry a `claude:`,
 * `codex:`, ... prefix, so `msg:` marks a message hash and its length names the scheme: dev wrote
 * FNV-1a 64 over the first 100 bytes (16 hex), keyed code a 32-byte HMAC (64 hex). Any other
 * `msg:` shape is "unknown" (e.g. uncommitted work-in-progress code), never guessed. `undefined`
 * means the key is not a message hash at all.
 */
export function messageSessionKey(key: string): HashScheme | "unknown" | undefined {
  if (!key.startsWith("msg:")) return undefined;
  if (/^msg:[0-9a-f]{16}$/.test(key)) return "unkeyed";
  if (/^msg:[0-9a-f]{64}$/.test(key)) return "keyed";
  return "unknown";
}

/**
 * The scheme that produced a message-hash session row's key, or `undefined` when its key says
 * nothing (explicit client ids, unknown shapes). The migration marker outranks the key format
 * because a rekeyed key is a 64 hex character keyed value; it only counts for `msg:` keys, since a
 * marker on an explicit id merely records a rekeyed parent key.
 */
export function sessionScheme(session: Marked & { key: string }): HashScheme | undefined {
  const shape = messageSessionKey(session.key);
  if (shape === undefined || shape === "unknown") return undefined;
  return declared(session) ?? shape;
}

/**
 * A request is captured by one code version, so its input or output chain and (for message-hash
 * sessions) its session key date all its blobs. Two exact sources that disagree block.
 */
async function requestScheme(ctx: Ctx, request: Doc<"telemetry_requests">): Promise<HashScheme | undefined> {
  const leaf = request.input ?? request.output;
  const node = leaf ? await ctx.db.get("telemetry_nodes", leaf) : null;
  const fromNode = node ? await nodeScheme(ctx, node) : undefined;
  const session = request.session
    ? await ctx.db.get("telemetry_sessions", request.session) as (Doc<"telemetry_sessions"> & Marked) | null
    : null;
  const fromSession = session ? sessionScheme(session) : undefined;
  if (fromNode && fromSession && fromNode !== fromSession) throw new Error("Telemetry request has contradictory hash provenance");
  return fromNode ?? fromSession;
}

/** One operator-attested stretch of time (`from` inclusive, `until` exclusive) hashed by a single scheme. */
type Epoch = { from: number; until: number; scheme: HashScheme };

const MAX_EPOCHS = 32;

/**
 * `TELEMETRY_HASH_PROVENANCE`: JSON array of `{ "from": ms, "until": ms, "scheme": "keyed" | "unkeyed" }`.
 * A deployment can run keyed code, roll back to unkeyed code and move forward again, so one
 * "keyed since" instant cannot describe it. The operator lists every stretch it verified from its
 * deployment history (leave out deploy-boundary slack); a content-less orphan blob is classified
 * only when its creation time lies inside exactly one stretch. Malformed or overlapping input throws.
 */
function attestedEpochs(): Epoch[] {
  const raw = process.env.TELEMETRY_HASH_PROVENANCE;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TELEMETRY_HASH_PROVENANCE is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_EPOCHS) {
    throw new Error(`TELEMETRY_HASH_PROVENANCE must list 1 to ${MAX_EPOCHS} epochs`);
  }
  const epochs = parsed.map((item): Epoch => {
    const epoch = item as Partial<Epoch> | null;
    const valid = typeof epoch === "object" && epoch !== null && Object.keys(epoch).length === 3
      && typeof epoch.from === "number" && typeof epoch.until === "number"
      && Number.isFinite(epoch.from) && Number.isFinite(epoch.until) && epoch.from > 0 && epoch.until > epoch.from
      && (epoch.scheme === "keyed" || epoch.scheme === "unkeyed");
    if (!valid) throw new Error("TELEMETRY_HASH_PROVENANCE has an invalid epoch");
    return { from: epoch.from!, until: epoch.until!, scheme: epoch.scheme! };
  }).sort((a, b) => a.from - b.from);
  for (let index = 1; index < epochs.length; index++) {
    if (epochs[index]!.from < epochs[index - 1]!.until) throw new Error("TELEMETRY_HASH_PROVENANCE epochs overlap");
  }
  return epochs;
}

/**
 * Hash scheme of a blob, decided from exact evidence in this order: marker, native ciphertext,
 * plaintext file storage (never written by keyed code), recomputation over inline content,
 * then the scheme of nodes and requests (chain or message-hash session key) that reference a
 * content-less blob. A content-less orphan with no such evidence is classified only by an
 * explicit operator attestation of the epoch its creation time lies in
 * (`TELEMETRY_HASH_PROVENANCE`); an attestation that contradicts exact evidence blocks, and
 * anything outside every attested epoch is reported as ambiguous. Nothing is ever inferred
 * from a single "keyed since" instant, which a keyed -> unkeyed -> keyed history breaks.
 */
export async function blobScheme(ctx: Ctx, blob: Doc<"telemetry_blobs"> & Marked): Promise<HashScheme> {
  const marked = declared(blob);
  if (marked) return marked;
  if (blob.sealed) return "keyed";
  if (blob.legacyContent) throw new Error("Telemetry blob has a sidecar without a hash marker");
  if (blob.storage) return "unkeyed";
  if (blob.content !== undefined) {
    const expected = await unkeyedDigest(`blob\u0000${blob.workspace}\u0000${blob.kind}\u0000${blob.content}`);
    return expected === blob.hash ? "unkeyed" : "keyed";
  }

  const evidence = new Set<HashScheme>();
  const nodes = await ctx.db.query("telemetry_nodes").withIndex("by_blob", (q) => q.eq("blob", blob._id)).take(3);
  for (const node of nodes) evidence.add(await nodeScheme(ctx, node));
  const id = blob._id;
  const requests = [
    await ctx.db.query("telemetry_requests").withIndex("by_system", (q) => q.eq("system", id)).first(),
    await ctx.db.query("telemetry_requests").withIndex("by_params", (q) => q.eq("params", id)).first(),
    await ctx.db.query("telemetry_requests").withIndex("by_headers", (q) => q.eq("headers", id)).first(),
    await ctx.db.query("telemetry_requests").withIndex("by_toolset", (q) => q.eq("toolset", id)).first(),
  ];
  for (const request of requests) {
    const scheme = request ? await requestScheme(ctx, request) : undefined;
    if (scheme) evidence.add(scheme);
  }
  if (evidence.size > 1) throw new Error("Telemetry blob has contradictory hash provenance");
  const [exact] = evidence;
  const attested = attestedEpochs().find((epoch) => blob._creationTime >= epoch.from && blob._creationTime < epoch.until)?.scheme;
  if (exact) {
    if (attested && attested !== exact) throw new Error("Telemetry blob evidence contradicts the attested hash provenance");
    return exact;
  }
  if (attested) return attested;
  throw new Error("Telemetry blob hash provenance is ambiguous: no exact evidence and no TELEMETRY_HASH_PROVENANCE epoch covers it");
}
