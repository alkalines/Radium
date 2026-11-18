import { decimal, hmacSha256 } from "./box";
import { lengthPrefixed, utf8 } from "./encoding";
import { hkdf, LABELS } from "./kdf";
import { signingMessage } from "./signatures";
import { CryptoError } from "./errors";

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

/** Audience of a chat (`aisdk_chats.scope`). */
export type ChatScopeName = "personal" | "shared" | "workspace";

/**
 * Binds an epoch to the server-assigned chat ID and its declared audience. Native v1 epoch
 * signatures remain readable; new encryption additionally requires this proof. Binding the chat
 * ID prevents replay of a creator-signed key from another chat, including a formerly personal key
 * whose seed was later shared. Shared member IDs are canonicalized; workspace membership remains
 * governed by the owner-signed roster.
 */
export function chatKeyBindingStatement(input: {
  chatId: string;
  workspaceId: string;
  chatE2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: Uint8Array;
  scope: ChatScopeName;
  creatorId: string;
  members: readonly string[];
}): Uint8Array {
  if (input.scope === "shared" && input.members.length > 1000) {
    throw new CryptoError("BAD_INPUT", "Too many chat members");
  }
  const members = input.scope === "shared" ? [...new Set(input.members)].sort() : [];
  return signingMessage(
    "radium/v2/chat-key-binding",
    utf8(input.chatId),
    utf8(input.workspaceId),
    utf8(input.chatE2eeId),
    decimal(input.epoch),
    utf8(input.keyId),
    decimal(input.suite),
    input.publicKey,
    utf8(input.scope),
    utf8(input.creatorId),
    ...members.map(utf8),
  );
}

/**
 * A Worker's encryption and signing public keys (Keys.md "Workers"). The Worker signs it with its own
 * signing key (proof of possession) and MACs it with `workerPairingMac`, which binds the keys to whoever
 * holds the pairing secret from the setup or pairing code.
 */
export function workerKeysStatement(input: {
  workspaceId: string;
  workerId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/worker-keys",
    utf8(input.workspaceId),
    utf8(input.workerId),
    utf8(input.keyId),
    decimal(input.suite),
    input.encryptionPublicKey,
    input.signingPublicKey,
  );
}

/**
 * HMAC of a `workerKeysStatement` under `HKDF(pairingSecret, "radium/v1/worker-pairing")`. The 32-byte
 * pairing secret exists only in the owner's browser (sealed to the owner) and in the code the Worker read.
 */
export async function workerPairingMac(
  pairingSecret: Uint8Array,
  statement: Uint8Array,
): Promise<Uint8Array> {
  const key = await hkdf(pairingSecret, LABELS.workerPairing);
  try {
    return await hmacSha256(key, [statement]);
  } finally {
    key.fill(0);
  }
}

/**
 * Owner authorization to execute an ACP launch definition in a workspace. Explicit field ordering
 * makes the statement independent of object property order and excludes the attached signature.
 * `issuedAt` is a persistent per-agent high-water mark, not an expiry.
 */
export function acpAgentDefinitionStatement(input: {
  workspaceId: string;
  issuedAt: number;
  definition: {
    agentId: string;
    name: string;
    command: string;
    args: string[];
    env: { name: string; value: string }[];
    gateway?: { enabled: boolean; env: { name: string; value: string }[] };
    enabled: boolean;
    source: "registry" | "custom";
    icon?: string;
    version?: string;
  };
}): Uint8Array {
  const definition = input.definition;
  return signingMessage(
    "radium/v1/acp-agent-definition",
    utf8(input.workspaceId),
    decimal(input.issuedAt),
    utf8(JSON.stringify([
      definition.agentId,
      definition.name,
      definition.command,
      definition.args,
      definition.env.map(({ name, value }) => [name, value]),
      definition.gateway
        ? [definition.gateway.enabled, definition.gateway.env.map(({ name, value }) => [name, value])]
        : null,
      definition.enabled,
      definition.source,
      definition.icon ?? null,
      definition.version ?? null,
    ])),
  );
}

/**
 * The binding of an ACP chat, signed by the chat's creator at creation and again (higher `version`) on
 * every scope or member change: which Worker, agent, profile and directory run it, and who may command
 * it. `members` lists the picked user IDs of a `shared` chat (empty otherwise); a `workspace` chat's
 * audience is the owner-signed roster. Workers execute nothing for a chat without a valid binding.
 */
export function acpBindingStatement(input: {
  workspaceId: string;
  chatId: string;
  chatE2eeId: string;
  creatorUserId: string;
  workerId: string;
  agentId: string;
  profile: string;
  cwd: string;
  scope: ChatScopeName;
  members: string[];
  version: number;
}): Uint8Array {
  return signingMessage(
    "radium/v1/acp-binding",
    utf8(input.workspaceId),
    utf8(input.chatId),
    utf8(input.chatE2eeId),
    utf8(input.creatorUserId),
    utf8(input.workerId),
    utf8(input.agentId),
    utf8(input.profile),
    utf8(input.cwd),
    utf8(input.scope),
    lengthPrefixed([...input.members].sort().map(utf8)),
    decimal(input.version),
  );
}

/**
 * One ACP command (`acp_commands`), signed by the issuing user's identity. `payload` is the exact
 * stored bytes (a box sealed to the Worker's encryption key); `chatId` is empty for agent-level
 * commands. `clientId` is the idempotency key the backend dedupes on, so a replayed row is the same
 * command.
 */
export function acpCommandStatement(input: {
  workspaceId: string;
  workerId: string;
  chatId: string;
  kind: string;
  clientId: string;
  payload: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/acp-command",
    utf8(input.workspaceId),
    utf8(input.workerId),
    utf8(input.chatId),
    utf8(input.kind),
    utf8(input.clientId),
    input.payload,
  );
}

/** An answer to one ACP interaction (`requestKey`), sealed to the Worker and signed by the answering user. */
export function acpAnswerStatement(input: {
  workspaceId: string;
  workerId: string;
  chatId: string;
  requestKey: string;
  answer: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/acp-answer",
    utf8(input.workspaceId),
    utf8(input.workerId),
    utf8(input.chatId),
    utf8(input.requestKey),
    input.answer,
  );
}

/**
 * An object a Worker writes for clients (an epoch's frame capsule, a sealed interaction request, title,
 * error, session index entry or receipt), signed by the Worker's signing key. The location parts mirror
 * the object's AAD, so a signed object cannot be presented in another table, record or field. Readers
 * accept it only from a Worker listed in the owner-signed roster.
 */
export function workerObjectStatement(input: {
  workspaceId: string;
  workerId: string;
  table: string;
  parent: string;
  record: string;
  field: string;
  object: Uint8Array;
}): Uint8Array {
  return signingMessage(
    "radium/v1/worker-object",
    utf8(input.workspaceId),
    utf8(input.workerId),
    utf8(input.table),
    utf8(input.parent),
    utf8(input.record),
    utf8(input.field),
    input.object,
  );
}

/**
 * A user's approval of exactly one built-in agent Worker tool call: `input` is the UTF-8 JSON of the
 * tool input the user saw (`JSON.stringify` of the AI SDK tool part input) and `approvedAt` the
 * approving client's clock (milliseconds). The Worker runs the call only if the operation it derives
 * from that input is the one it was asked to run, only within a fixed window after `approvedAt`, and
 * at most once (it remembers executed approvals for that window only).
 */
export function toolApprovalStatement(input: {
  workspaceId: string;
  chatId: string;
  workerId: string;
  directory: string;
  tool: string;
  toolCallId: string;
  input: Uint8Array;
  approvedAt: number;
}): Uint8Array {
  return signingMessage(
    "radium/v1/tool-approval",
    utf8(input.workspaceId),
    utf8(input.chatId),
    utf8(input.workerId),
    utf8(input.directory),
    utf8(input.tool),
    utf8(input.toolCallId),
    input.input,
    decimal(input.approvedAt),
  );
}

/**
 * A standing, user-signed permission for the built-in agent to run `tools` without a per-call approval
 * in one chat, Worker and directory. It has no expiry: a newer grant (`issuedAt`, milliseconds) for the
 * same chat replaces it, and the Worker refuses grants older than the newest it has seen.
 */
export function toolGrantStatement(input: {
  workspaceId: string;
  chatId: string;
  workerId: string;
  directory: string;
  tools: string[];
  issuedAt: number;
}): Uint8Array {
  return signingMessage(
    "radium/v1/tool-grant",
    utf8(input.workspaceId),
    utf8(input.chatId),
    utf8(input.workerId),
    utf8(input.directory),
    lengthPrefixed([...input.tools].sort().map(utf8)),
    decimal(input.issuedAt),
  );
}
