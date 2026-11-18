import { v, type Infer } from "convex/values";
import type { AadParts } from "radium-crypto";

/** Historical plaintext sealed independently of native signed Worker/client records. */
export const legacyBoxValidator = v.object({
  kind: v.union(v.literal("identity"), v.literal("workspace_member"), v.literal("workspace_owner"), v.literal("chat"), v.literal("custody")),
  keyId: v.string(),
  epoch: v.number(),
  box: v.bytes(),
  /** Large historical envelopes live in encrypted File Storage, never plaintext table fields. */
  storageId: v.optional(v.id("_storage")),
});

/** Recipient descriptor is public; only custody has a backend-held private key. */
export type LegacyBox = Infer<typeof legacyBoxValidator>;
export type LegacyRecipient = Omit<LegacyBox, "box" | "kind" | "storageId"> & {
  kind: Exclude<LegacyBox["kind"], "custody">;
  publicKey: ArrayBuffer;
};

/** A dedicated domain prevents historical payloads from becoming valid live commands. */
export function legacyAad(table: string, record: string, workspace?: string): AadParts {
  return { workspace: workspace ?? "", parent: "legacy-v1", table, record, field: "legacy" };
}
