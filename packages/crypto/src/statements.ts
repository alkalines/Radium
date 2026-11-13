import { decimal } from "./box";
import { utf8 } from "./encoding";
import { signingMessage } from "./signatures";

/**
 * Bytes signed for workspace and chat key records (Keys.md "Workspaces", "Chats"). Each statement has
 * its own label, so a signature over one kind can never be presented as another. Every part is
 * length-prefixed by `signingMessage`.
 */

/** Purpose of a workspace key: the member key (every member) or the owner key (owners only). */
export type WorkspaceKeyPurpose = "member" | "owner";

/**
 * A grant: workspace key `purpose` of `epoch`, sealed (`sealed`, a box) to the identity `recipientKeyId`
 * of `recipientUserId`. Signed by the granter's identity signing key.
 */
export function grantStatement(input: {
  workspaceId: string;
  epoch: number;
  purpose: WorkspaceKeyPurpose;
  recipientUserId: string;
  recipientKeyId: string;
  sealed: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/grant",
    utf8(input.workspaceId),
    decimal(input.epoch),
    utf8(input.purpose),
    utf8(input.recipientUserId),
    utf8(input.recipientKeyId),
    input.sealed,
  );
}

/** A workspace roster: the owner-signed UTF-8 JSON `body` (see `docs/E2EE/Keys.md`). */
export function rosterStatement(input: { workspaceId: string; body: Uint8Array }): Uint8Array {
  return signingMessage("radium/v1/roster", utf8(input.workspaceId), input.body);
}

/**
 * One chat key epoch: chat `chatE2eeId` in `workspaceId` uses `publicKey` (key ID `keyId`) from `epoch`
 * on. Signed by the identity that created the epoch.
 */
export function chatKeyStatement(input: {
  workspaceId: string;
  chatE2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/chat-key",
    utf8(input.workspaceId),
    utf8(input.chatE2eeId),
    decimal(input.epoch),
    utf8(input.keyId),
    decimal(input.suite),
    input.publicKey,
  );
}
