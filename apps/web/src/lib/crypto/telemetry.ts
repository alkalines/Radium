import type { LoadedBlob } from "contracts/telemetry/store";
import {
  CryptoError,
  decodeCapsule,
  decodeEnvelope,
  equalBytes,
  fromBase64Url,
  openCapsule,
  openWithCapsule,
  type AadParts,
} from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import { trust } from "./trust-store";
import { CustodialContentError, openLegacyContent } from "./legacy-content";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { getOwnerKey } from "./workspace-keys";

/** Sealed content as the backend sends it: bytes are base64url; a large envelope is fetched from `storageUrl`. */
type Sealed = {
  epoch: number;
  requestId: string;
  capsule: string;
  envelope?: string | null;
  storageUrl?: string | null;
};
type Entry = { workspace: string; data?: unknown; failed?: boolean; promise: Promise<void> };
type CapsuleCache = Map<string, { wire: Uint8Array; key: Promise<Uint8Array> }>;
const active = new Map<AbortController, CapsuleCache>();
let opened = new WeakMap<object, Entry>();
let generation = 0;
let revision = 0;
const listeners = new Set<() => void>();
const decoder = new TextDecoder("utf-8", { fatal: true });

function emit() {
  revision++;
  for (const listener of listeners) listener();
}
function clear() {
  generation++;
  opened = new WeakMap();
  for (const [controller, capsules] of active) {
    controller.abort();
    for (const { key } of capsules.values()) void key.then((value) => value.fill(0), () => {});
  }
  active.clear();
  emit();
}
keyManager.subscribe(clear);
trust.subscribe(clear);

/** Memory-only view cache. React subscribes to a public revision, never decrypted query data. */
export const telemetryContent = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => revision,
  get<T extends object>(source: T, workspace: string): { data?: T; failed?: boolean } | undefined {
    const entry = opened.get(source);
    return entry?.workspace === workspace ? entry as { data?: T; failed?: boolean } : undefined;
  },
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Detects sealed telemetry without inspecting captured JSON strings or binary envelope bytes. */
export function hasSealedTelemetry(value: unknown): boolean {
  if (value instanceof ArrayBuffer || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSealedTelemetry);
  const object = value as Record<string, unknown>;
  return object.sealed != null || object.sealedError != null || object.legacyContent != null ||
    Object.values(object).some(hasSealedTelemetry);
}

async function openPayload(
  sealed: Sealed,
  workspace: string,
  table: string,
  objectId: string,
  field: string,
  capsules: CapsuleCache,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const capsuleBytes = fromBase64Url(sealed.capsule);
  const capsule = decodeCapsule(capsuleBytes);
  const id = `${sealed.epoch}:${sealed.requestId}`;
  let cached = capsules.get(id);
  if (cached && !equalBytes(cached.wire, capsuleBytes)) {
    throw new CryptoError("BAD_ENVELOPE", "Telemetry capsule changed");
  }
  if (!cached) {
    const key = getOwnerKey(workspace, sealed.epoch).then((owner) => {
      signal.throwIfAborted();
      return openCapsule({
        seed: owner.seed,
        capsule,
        aad: {
          table: "telemetry_capsules", workspace,
          parent: sealed.requestId, record: sealed.requestId, field: "capsule",
        },
      });
    });
    void key.then((value) => { if (signal.aborted) value.fill(0); }, () => {});
    cached = { wire: capsuleBytes, key };
    capsules.set(id, cached);
  }
  let envelope = sealed.envelope ? fromBase64Url(sealed.envelope) : undefined;
  if (!envelope && sealed.storageUrl) {
    const response = await fetch(sealed.storageUrl, { credentials: "omit", cache: "no-store", signal });
    if (!response.ok) throw new CryptoError("DECRYPT_FAILED", "Telemetry download failed");
    envelope = new Uint8Array(await response.arrayBuffer());
  }
  if (!envelope || !equalBytes(decodeEnvelope(envelope).keyRef, capsule.capsuleId)) {
    throw new CryptoError("BAD_ENVELOPE", "Telemetry capsule mismatch");
  }
  const aad: AadParts = {
    table, workspace, parent: sealed.requestId, record: objectId, field,
  };
  const capsuleKey = await cached.key;
  signal.throwIfAborted();
  const plaintext = await openWithCapsule({
    capsuleKey, envelope, aad, pad: "content",
  });
  try {
    signal.throwIfAborted();
    return JSON.parse(decoder.decode(plaintext));
  } finally {
    plaintext.fill(0);
  }
}

function blobPayload(value: unknown): Pick<LoadedBlob, "content" | "meta"> {
  const payload = record(value);
  const meta = payload?.meta === undefined ? undefined : record(payload.meta);
  if (!payload ||
    (payload.content !== undefined && typeof payload.content !== "string") ||
    (payload.meta !== undefined && !meta) ||
    (meta?.role !== undefined && typeof meta.role !== "string") ||
    (meta?.toolCallId !== undefined && typeof meta.toolCallId !== "string") ||
    (meta?.names !== undefined && (!Array.isArray(meta.names) ||
      !meta.names.every((name) => typeof name === "string")))) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid telemetry payload");
  }
  if (payload.content !== undefined) JSON.parse(payload.content as string);
  return payload as Pick<LoadedBlob, "content" | "meta">;
}

/**
 * Opens a complete request or message page locally. Sealed fields are authoritative: malformed
 * envelopes never fall back to plaintext siblings. Owner grants verify roster, trust and epoch.
 * Results live only in this module and are discarded on key-status or trust changes.
 */
export function openTelemetryData<T extends object>(source: T, workspace: string): Promise<void> {
  const existing = opened.get(source);
  if (existing?.workspace === workspace) return existing.promise;
  const start = generation;
  const capsules: CapsuleCache = new Map();
  const controller = new AbortController();
  active.set(controller, capsules);
  const entry: Entry = { workspace, promise: Promise.resolve() };
  opened.set(source, entry);
  async function visit(value: unknown): Promise<unknown> {
    if (value instanceof ArrayBuffer || !value || typeof value !== "object") return value;
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    const object = value as Record<string, unknown>;
    if (object.legacyContent != null) {
      const isBlob = typeof object.hash === "string" && typeof object.id === "string";
      const isRequest = typeof object.id === "string" && Array.isArray(object.attempts);
      if (!isBlob && !isRequest) throw new CryptoError("BAD_ENVELOPE", "Invalid legacy telemetry record");
      let payload: Record<string, unknown> | undefined;
      try {
        payload = record(await openLegacyContent<unknown>(object.legacyContent as LegacyBox, {
          table: isBlob ? "telemetry_blobs" : "telemetry_requests",
          record: object.id as string,
          workspace,
        }));
        if (!payload) throw new CryptoError("BAD_ENVELOPE", "Invalid legacy telemetry payload");
      } catch (error) {
        // Custody awaits release; the rest of the request stays readable and this part stays hidden.
        if (!(error instanceof CustodialContentError)) throw error;
      }
      const clean = { ...object, legacyContent: null };
      const result = await visit(clean) as Record<string, unknown>;
      if (!payload) return isBlob ? { ...result, content: null, meta: null, redacted: true } : result;
      if (isBlob) {
        const legacy = blobPayload(payload);
        return { ...result, content: result.content ?? legacy.content ?? null, meta: result.meta ?? legacy.meta ?? null,
          redacted: result.content == null && legacy.content === undefined };
      }
      if (payload.error !== undefined && !record(payload.error)) throw new CryptoError("BAD_ENVELOPE", "Invalid legacy error");
      const attemptMessages = payload.attempts;
      if (attemptMessages !== undefined) {
        if (!Array.isArray(attemptMessages) || attemptMessages.length !== (result.attempts as unknown[]).length ||
            !attemptMessages.every((message) => message === null || typeof message === "string")) {
          throw new CryptoError("BAD_ENVELOPE", "Invalid legacy attempt errors");
        }
        result.attempts = (result.attempts as unknown[]).map((attempt, index) => ({
          ...record(attempt), message: record(attempt)?.message ?? (attemptMessages as (string | null)[])[index] ?? undefined,
        }));
      }
      result.error ??= payload.error;
      return result;
    }
    if (object.sealed != null) {
      if (typeof object.hash !== "string") throw new CryptoError("BAD_ENVELOPE", "Invalid telemetry blob");
      const payload = blobPayload(await openPayload(
        object.sealed as Sealed, workspace, "telemetry_blobs", object.hash, "content", capsules, controller.signal,
      ));
      return { ...object, sealed: null, storageUrl: null,
        content: payload.content ?? null, meta: payload.meta ?? null, redacted: payload.content === undefined };
    }
    if (object.sealedError != null) {
      const sealed = object.sealedError as Sealed;
      const payload = record(await openPayload(
        sealed, workspace, "telemetry_requests", sealed.requestId, "error", capsules, controller.signal,
      ));
      const error = payload?.error === undefined ? undefined : record(payload.error);
      const attempts = object.attempts;
      if (!payload || !Array.isArray(payload.attempts) || !Array.isArray(attempts) ||
        payload.attempts.length !== attempts.length ||
        !payload.attempts.every((message) => message === null || typeof message === "string") ||
        (payload.error !== undefined && (!error || typeof error.message !== "string" ||
          (error.status !== undefined && typeof error.status !== "number")))) {
        throw new CryptoError("BAD_ENVELOPE", "Invalid telemetry errors");
      }
      if (sealed.requestId !== object.requestId) {
        throw new CryptoError("BAD_ENVELOPE", "Telemetry request mismatch");
      }
      return { ...object, sealedError: null, error: error ?? null,
        attempts: attempts.map((attempt, index) => ({
          ...record(attempt), message: (payload.attempts as (string | null)[])[index] ?? undefined,
        })) };
    }
    return Object.fromEntries(await Promise.all(Object.entries(object).map(async ([key, item]) =>
      [key, await visit(item)],
    )));
  }
  entry.promise = (async () => {
    try {
      if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
      const data = await visit(source);
      if (start === generation && keyManager.getSnapshot().state === "unlocked") entry.data = data;
    } catch {
      if (start === generation) entry.failed = true;
    } finally {
      controller.abort();
      active.delete(controller);
      for (const { key } of capsules.values()) void key.then((value) => value.fill(0), () => {});
      if (start === generation) emit();
    }
  })();
  return entry.promise;
}
