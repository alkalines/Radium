import { z } from "zod";
import type { AadParts } from "radium-crypto";
import { bytes, idOf } from "../wire";

/** Historical plaintext sealed independently of native signed Worker/client records. */
export const legacyBoxValidator = z.object({
  kind: z.union([
    z.literal("identity"),
    z.literal("workspace_member"),
    z.literal("workspace_owner"),
    z.literal("chat"),
    z.literal("custody"),
  ]),
  keyId: z.string(),
  epoch: z.number(),
  box: bytes(),
  /** Large historical envelopes live in encrypted File Storage, never plaintext table fields. */
  storageId: z.optional(idOf("_storage")),
});

/** Recipient descriptor is public; only custody has a backend-held private key. */
export type LegacyBox = z.infer<typeof legacyBoxValidator>;
export type LegacyRecipient = Omit<LegacyBox, "box" | "kind" | "storageId"> & {
  kind: Exclude<LegacyBox["kind"], "custody">;
  publicKey: ArrayBuffer;
};

/** A dedicated domain prevents historical payloads from becoming valid live commands. */
export function legacyAad(table: string, record: string, workspace?: string): AadParts {
  return { workspace: workspace ?? "", parent: "legacy-v1", table, record, field: "legacy" };
}
