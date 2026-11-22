import { v } from "convex/values";
import { generateEncryptionKeyPair, openBox, randomBytes, sealBox, toBase64Url, utf8 } from "radium-crypto";
import { internal } from "../../convex/_generated/api";
import { internalAction, type ActionCtx } from "../../convex/_generated/server";
import { legacyAad, type LegacyBox, type LegacyRecipient } from "contracts/e2ee/legacy-contract";
import {
  errorReason,
  MAX_SEAL_ENVELOPE_BYTES,
  MAX_SEAL_PLAINTEXT_BYTES,
  MAX_SEAL_SOURCE_BYTES,
  type JobIssue,
  type JobPage,
  type JobRef,
  type LegacyStorageSource,
  type ReleaseCandidate,
  type SealCandidate,
  type StepOutcome,
} from "./migration-contract";

/**
 * Action-only half of phase 9: page processing and custody creation. These run in a `"use node"` module
 * (`convex/e2ee_migration_node.ts`, 512 MiB) because sealing a legacy 20 MiB attachment holds several
 * copies of it at once. Never import this file from a query/mutation module, and never put queries,
 * mutations or schema imports here; they stay in `migration-core.ts` (default runtime).
 */

/** Envelopes above this size move to encrypted File Storage instead of the row. */
const INLINE_ENVELOPE_BYTES = 128 * 1024;

const BASE64URL = utf8("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");

/** Length of the unpadded base64url encoding of `length` bytes. */
export function base64UrlLength(length: number): number {
  const remainder = length % 3;
  return Math.floor(length / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
}

/** Writes the unpadded base64url encoding of `source` into `target` at `offset`; returns the end offset. */
export function base64UrlInto(source: Uint8Array, target: Uint8Array, offset: number): number {
  let out = offset;
  let index = 0;
  for (; index + 2 < source.length; index += 3) {
    const n = (source[index]! << 16) | (source[index + 1]! << 8) | source[index + 2]!;
    target[out++] = BASE64URL[n >> 18]!;
    target[out++] = BASE64URL[(n >> 12) & 63]!;
    target[out++] = BASE64URL[(n >> 6) & 63]!;
    target[out++] = BASE64URL[n & 63]!;
  }
  const rest = source.length - index;
  if (rest === 1) {
    const n = source[index]! << 16;
    target[out++] = BASE64URL[n >> 18]!;
    target[out++] = BASE64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (source[index]! << 16) | (source[index + 1]! << 8);
    target[out++] = BASE64URL[n >> 18]!;
    target[out++] = BASE64URL[(n >> 12) & 63]!;
    target[out++] = BASE64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** `{...value,"field":` without the closing brace; the caller appends the field value and `}`. */
function openObject(value: Record<string, unknown>, field: string): string {
  const rest = JSON.stringify(value);
  if (!rest.startsWith("{") || !rest.endsWith("}")) throw new Error("Legacy content is not a JSON object.");
  const key = `${JSON.stringify(field)}:`;
  return rest === "{}" ? `{${key}` : `${rest.slice(0, -1)},${key}`;
}

function assertPlaintextSize(length: number): void {
  if (length > MAX_SEAL_PLAINTEXT_BYTES) {
    throw new Error(`Legacy content is ${length} bytes once serialized, above the ${MAX_SEAL_PLAINTEXT_BYTES} byte sealing bound.`);
  }
}

/**
 * The exact bytes of `JSON.stringify({ ...value, [field]: content })` (the sidecar format readers parse),
 * built once into a single buffer: attachment bytes are base64url-encoded straight into it with no
 * intermediate string, and text is spliced in as one JSON string. Same format as before; fewer copies.
 */
export function legacyPlaintext(
  value: Record<string, unknown>,
  source?: { field: string; encoding: LegacyStorageSource["encoding"]; bytes: Uint8Array },
): Uint8Array {
  if (!source) {
    const plain = utf8(JSON.stringify(value));
    assertPlaintextSize(plain.length);
    return plain;
  }
  if (source.encoding === "text") {
    // `ignoreBOM` keeps a leading U+FEFF, which belongs to the original content.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes);
    const plain = utf8(`${openObject(value, source.field)}${JSON.stringify(text)}}`);
    assertPlaintextSize(plain.length);
    return plain;
  }
  const head = utf8(`${openObject(value, source.field)}"`);
  const length = head.length + base64UrlLength(source.bytes.length) + 2;
  assertPlaintextSize(length);
  const plain = new Uint8Array(length);
  plain.set(head, 0);
  const end = base64UrlInto(source.bytes, plain, head.length);
  plain[end] = 0x22;
  plain[end + 1] = 0x7d;
  return plain;
}

async function readSourceStorage(ctx: ActionCtx, source: LegacyStorageSource, expectedSize: number | undefined): Promise<Uint8Array> {
  const blob = await ctx.storage.get(source.id);
  if (!blob) throw new Error("Legacy source storage is missing.");
  if (blob.size > MAX_SEAL_SOURCE_BYTES) {
    throw new Error(`Legacy source storage is ${blob.size} bytes, above the ${MAX_SEAL_SOURCE_BYTES} byte sealing bound.`);
  }
  if (expectedSize !== undefined && blob.size !== expectedSize) throw new Error("Legacy source storage changed since it was inspected.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Seals already-serialized legacy plaintext to `recipient` (default: active custody). The caller zeroes it. */
async function sealPlaintext(ctx: ActionCtx, input: {
  table: string; record: string; workspace?: string; plaintext: Uint8Array; recipient?: LegacyRecipient;
}): Promise<LegacyBox> {
  const recipient = input.recipient ?? { kind: "custody" as const, epoch: 1, ...await ctx.runQuery(internal.e2ee_migration.custodyPublicKey, {}) };
  const bytes = await sealBox({
    recipientPublicKey: new Uint8Array(recipient.publicKey),
    plaintext: input.plaintext,
    aad: legacyAad(input.table, input.record, input.workspace),
    pad: "content",
  });
  const descriptor = { kind: recipient.kind, keyId: recipient.keyId, epoch: recipient.epoch };
  if (bytes.byteLength > INLINE_ENVELOPE_BYTES) {
    // `sealBox` returns an ArrayBuffer-backed array; the Blob copies it, so no extra slice is needed.
    const storageId = await ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
    return { ...descriptor, box: new ArrayBuffer(0), storageId };
  }
  return { ...descriptor, box: bytes.slice().buffer };
}

/**
 * Opens a deployment-custody envelope and returns its authenticated serialized plaintext without parsing
 * it, so a release reseals the identical bytes instead of round-tripping the content through JSON.
 * Only custody envelopes are ever opened server-side.
 */
async function openCustodyPlaintext(ctx: ActionCtx, input: {
  table: string; record: string; workspace?: string; sealed: LegacyBox;
}): Promise<Uint8Array> {
  if (input.sealed.kind !== "custody") throw new Error("Only custodial content may be released by the server");
  const seed = new Uint8Array(await ctx.runQuery(internal.e2ee_migration.custodySeed, { keyId: input.sealed.keyId }));
  try {
    let box = new Uint8Array(input.sealed.box);
    if (input.sealed.storageId) {
      if (box.byteLength !== 0) throw new Error("Ambiguous historical envelope storage");
      const blob = await ctx.storage.get(input.sealed.storageId);
      if (!blob) throw new Error("Historical envelope storage is missing");
      if (blob.size > MAX_SEAL_ENVELOPE_BYTES) {
        throw new Error(`Historical envelope is ${blob.size} bytes, above the ${MAX_SEAL_ENVELOPE_BYTES} byte release bound.`);
      }
      box = new Uint8Array(await blob.arrayBuffer());
    }
    const plaintext = await openBox({ seed, box, aad: legacyAad(input.table, input.record, input.workspace), pad: "content" });
    // The envelope authenticates our own serialization; a non-object means a foreign or corrupt payload.
    if (plaintext[0] !== 0x7b || plaintext[plaintext.length - 1] !== 0x7d) {
      plaintext.fill(0);
      throw new Error("Historical envelope does not hold a JSON object");
    }
    return plaintext;
  } finally { seed.fill(0); }
}

/** A new envelope blob that did not commit is deleted unless a committed row registered it. */
async function discardUncommitted(ctx: ActionCtx, sealed: LegacyBox | undefined): Promise<void> {
  if (!sealed?.storageId) return;
  try {
    await ctx.runMutation(internal.e2ee_migration.discardSidecar, { storageId: sealed.storageId });
  } catch {
    // An unregistered orphan stays ciphertext-only and is collected by the unreferenced-storage sweep.
    console.warn("Legacy envelope cleanup failed; leaving the orphan to the storage sweep.");
  }
}

async function sealCandidate(ctx: ActionCtx, ref: JobRef, table: string, candidate: SealCandidate): Promise<StepOutcome> {
  let sealed: LegacyBox | undefined;
  let outcome: StepOutcome;
  try {
    let plaintext: Uint8Array;
    if (candidate.storage) {
      // The source bytes are dropped as soon as they are serialized; only one large buffer lives at a time.
      let bytes: Uint8Array | undefined = await readSourceStorage(ctx, candidate.storage, candidate.sourceSize);
      plaintext = legacyPlaintext(candidate.value, { field: candidate.storage.field, encoding: candidate.storage.encoding, bytes });
      bytes.fill(0);
      bytes = undefined;
    } else {
      plaintext = legacyPlaintext(candidate.value);
    }
    try {
      sealed = await sealPlaintext(ctx, {
        table, record: candidate.record, workspace: candidate.workspace, plaintext, recipient: candidate.recipient,
      });
    } finally { plaintext.fill(0); }
    outcome = await ctx.runMutation(internal.e2ee_migration.commitSeal, {
      ...ref, table, record: candidate.record, digest: candidate.digest, sealed,
    });
  } catch (error) {
    outcome = { issue: { record: candidate.record, reason: errorReason(error) } };
  }
  if (outcome !== "committed") await discardUncommitted(ctx, sealed);
  return outcome;
}

async function releaseCandidate(ctx: ActionCtx, ref: JobRef, candidate: ReleaseCandidate): Promise<StepOutcome> {
  let sealed: LegacyBox | undefined;
  let outcome: StepOutcome;
  try {
    const source = { table: candidate.table, record: candidate.record, workspace: candidate.workspace };
    const plaintext = await openCustodyPlaintext(ctx, { ...source, sealed: candidate.sealed });
    try {
      sealed = await sealPlaintext(ctx, { ...source, plaintext, recipient: candidate.recipient });
    } finally { plaintext.fill(0); }
    outcome = await ctx.runMutation(internal.e2ee_migration.commitRelease, {
      ...ref, entry: candidate.entry, digest: candidate.digest, sealed,
    });
  } catch (error) {
    outcome = { issue: { record: candidate.record, reason: errorReason(error) } };
  }
  if (outcome !== "committed") await discardUncommitted(ctx, sealed);
  return outcome;
}

/**
 * Processes one page of a job and hands the result to `advance`, which schedules the next page.
 * Arguments are ids only; plaintext exists solely in this action's memory between read and seal, and
 * candidates are processed one at a time so at most one large attachment is resident.
 */
export const runJob = internalAction({
  args: { job: v.id("e2ee_migration_jobs"), run: v.number() },
  handler: async (ctx, args): Promise<null> => {
    let page: JobPage | null;
    try {
      page = await ctx.runQuery(internal.e2ee_migration.loadPage, args);
    } catch (error) {
      await ctx.runMutation(internal.e2ee_migration.failJob, { ...args, reason: errorReason(error) });
      return null;
    }
    if (!page) return null;

    const tally = page.tally;
    let issue: JobIssue | undefined = page.issue;
    let conflicts = 0;
    const record = (outcome: StepOutcome, source: string) => {
      if (outcome === "committed") tally.changed += 1;
      else if (outcome === "conflict") {
        conflicts += 1;
        issue ??= { record: source, reason: "Source or recipient changed before commit." };
      } else if (outcome !== "stale") {
        tally.blocked += 1;
        issue ??= outcome.issue;
      }
    };
    for (const probe of page.probes) {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await readSourceStorage(ctx, probe.storage, probe.sourceSize);
        if (probe.storage.encoding === "text") new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        tally.blocked += 1;
        if (probe.countsChange) tally.changed -= 1;
        issue ??= { record: probe.record, reason: errorReason(error) };
      } finally { bytes?.fill(0); }
    }
    for (const candidate of page.seal) record(await sealCandidate(ctx, args, page.table, candidate), candidate.record);
    for (const candidate of page.release) record(await releaseCandidate(ctx, args, candidate), candidate.record);

    await ctx.runMutation(internal.e2ee_migration.advance, {
      ...args,
      cursor: page.cursor,
      next: page.continueCursor,
      isDone: page.isDone,
      tally,
      conflicts,
      stale: page.stale,
      ...(issue ? { issue } : {}),
    });
    return null;
  },
});

/** Create custody only by an explicit operator invocation; never replace an existing key. */
export const createCustody = internalAction({
  args: {},
  handler: async (ctx): Promise<{ keyId: string }> => {
    const pair = await generateEncryptionKeyPair();
    const keyId = toBase64Url(randomBytes(16));
    try {
      await ctx.runMutation(internal.e2ee_migration.installCustody, {
        keyId,
        publicKey: pair.publicKey.slice().buffer,
        seed: toBase64Url(pair.seed),
      });
      return { keyId };
    } finally {
      pair.seed.fill(0);
    }
  },
});
