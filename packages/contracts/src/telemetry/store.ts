import type { LegacyBox } from "../e2ee/legacy-contract";
import type { Id } from "../wire";
import type { TelemetryBlobKind, TelemetryBlobMeta } from "./validators";

/**
 * A blob as returned to readers. Content stays canonical JSON text: captured payloads carry
 * keys Convex values reject (`$schema` in tool schemas, `$`-prefixed metadata) and nesting
 * deeper than Convex allows, so it crosses function boundaries as a string. Parse with
 * `blobValue`.
 */
export type LoadedBlob = {
  id: Id<"telemetry_blobs">;
  hash: string;
  kind: TelemetryBlobKind;
  size: number;
  meta?: TelemetryBlobMeta;
  truncated?: boolean;
  /** Canonical JSON; absent when content recording was off or the content is in file storage. */
  content?: string;
  /** Signed file URL for content above the inline limit. */
  storageUrl?: string;
  legacyContent?: LegacyBox;
  sealed?: {
    epoch: number;
    requestId: string;
    capsule: ArrayBuffer;
    envelope?: ArrayBuffer;
    storageUrl?: string;
  };
  /** True when only the fingerprint and metadata were captured. */
  redacted: boolean;
};

/** Parsed blob content, or `undefined` when the content is not inline. */
export function blobValue(blob: { content?: string } | null | undefined): unknown {
  return blob?.content === undefined ? undefined : JSON.parse(blob.content);
}

export type LoadedNode = {
  id: Id<"telemetry_nodes">;
  depth: number;
  origin: "input" | "output";
  message: LoadedBlob;
};
