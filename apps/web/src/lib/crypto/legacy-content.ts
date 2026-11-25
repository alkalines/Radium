import { legacyAad, type LegacyBox } from "contracts/e2ee/legacy-contract";
import { fromBase64Url, openBox, toBase64Url } from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import { getMemberKey, getOwnerKey } from "./workspace-keys";
import { openChatSeed } from "./chat-keys";
import { secretGeneration } from "./runtime";
import { trpcClient } from "@/lib/trpc-client";

/** Custody is server-readable storage, not a client key or a lost-history condition. */
export class CustodialContentError extends Error {
  constructor() { super("Not yet end-to-end encrypted. Set up encryption and release historical content."); this.name = "CustodialContentError"; }
}

export type LegacyContentContext = {
  table: string;
  record: string;
  workspace?: string;
  chatId?: string;
};

/**
 * A stored box as its source delivers it: Convex sends `box` as an `ArrayBuffer`, tRPC as unpadded
 * base64url text.
 */
export type SealedLegacyBox = Omit<LegacyBox, "box"> & { box: ArrayBuffer | string };

/** Opens historical content locally; results are never cached in React Query or persistent storage. */
export async function openLegacyContent<T = Record<string, unknown>>(sealed: SealedLegacyBox, context: LegacyContentContext): Promise<T> {
  if (sealed.kind === "custody") throw new CustodialContentError();
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const generation = secretGeneration();
  let box = typeof sealed.box === "string" ? fromBase64Url(sealed.box) : new Uint8Array(sealed.box);
  if (sealed.storageId) {
    if (box.byteLength !== 0) throw new Error("Ambiguous historical envelope storage");
    // NOT_FOUND means unknown or not authorized: both are "unavailable".
    const url = await trpcClient()
      .e2ee.legacyStorageUrl.query({ table: context.table, record: context.record })
      .catch(() => null);
    if (!url) throw new Error("Historical envelope storage is unavailable");
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Historical envelope download failed");
    box = new Uint8Array(await response.arrayBuffer());
  }
  const aad = legacyAad(context.table, context.record, context.workspace);
  const open = (seed: Uint8Array) => openBox({ seed, box, aad, pad: "content" });
  let plaintext: Uint8Array;
  if (sealed.kind === "identity") {
    plaintext = await keyManager.useAmk(async (_amk, identity) => {
      if (toBase64Url(identity.keyId) !== sealed.keyId) throw new Error("Historical identity key is unavailable");
      return open(identity.encryption.seed);
    });
  } else if (sealed.kind === "chat") {
    if (!context.chatId) throw new Error("Historical chat context is missing");
    plaintext = await open(await openChatSeed(context.chatId, sealed.epoch));
  } else {
    if (!context.workspace) throw new Error("Historical workspace context is missing");
    const key = sealed.kind === "workspace_owner"
      ? await getOwnerKey(context.workspace, sealed.epoch)
      : await getMemberKey(context.workspace, sealed.epoch);
    if (key.keyId !== sealed.keyId) throw new Error("Historical workspace key changed");
    plaintext = await open(key.seed);
  }
  try {
    if (generation !== secretGeneration() || keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid historical content");
    // Domain readers validate their original field shapes before rendering or executing a new request.
    return value as T;
  } finally { plaintext.fill(0); }
}
