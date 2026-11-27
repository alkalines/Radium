import type {
  AcpCommandPayload,
  AcpInteractionAnswer,
  AcpInteractionRequest,
} from "contracts/acp/contract";
import type { AcpFrame } from "contracts/acp/fold";
import {
  acpAnswerStatement,
  acpBindingStatement,
  acpCommandStatement,
  CryptoError,
  decodeCapsule,
  fromBase64Url,
  openBox,
  openCapsule,
  openWithCapsule,
  sealBox,
  toBase64Url,
  utf8,
  verify,
  workerObjectStatement,
  type ChatScopeName,
} from "radium-crypto";
import { openChatSeed } from "@/lib/crypto/chat-keys";
import { currentUserId, onSecretsCleared } from "@/lib/crypto/runtime";
import { trpcClient } from "@/lib/trpc-client";
import { signAsUser, trustedWorker, WorkerNotPairedError } from "@/lib/crypto/workers";
import { getOwnerKey, keyedWorkspaceClaim } from "@/lib/crypto/workspace-keys";

/**
 * Browser side of ACP end-to-end encryption (`docs/E2EE/Data.md#acp`): signed and sealed commands,
 * bindings and answers going to a paired Worker, and verified decryption of what the Worker wrote.
 * The backend only relays these objects; nothing here trusts it to have authored any of them.
 * Every byte string crosses the wire as unpadded base64url text.
 */

/** A sealed, signed command as `acp.*` and `chats.delete` take it. */
export type AcpSignedCommandWire = {
  clientId: string;
  payload: string;
  signature: string;
  signerKeyId: string;
};

/** A creator-signed binding as `acp.publishBinding`, `acp.startFork` and `chats.setScope` take it. */
export type AcpSignedBindingWire = {
  version: number;
  scope: ChatScopeName;
  members: string[];
  signerKeyId: string;
  signature: string;
};

/** A chat's public identifiers: where its sealed ACP objects live and which Worker signs them. */
export type AcpChatContext = {
  chatId: string;
  workspaceId: string;
  e2eeId: string;
  /** The Worker that runs the chat's agent session (`getSession.agent.worker`). */
  workerId: string;
};

/** One sealed frame of an epoch stream; `payload` is the sealed envelope as base64url. */
export type AcpFrameRow = {
  seqFrom: number;
  seqTo: number;
  kind: AcpFrame["kind"];
  payload: string;
};

/** An epoch's frame capsule as the Worker signed it: the first message of its stream. */
export type AcpEpochCapsule = { chatEpoch: number; capsule: Uint8Array; signature: Uint8Array };

const FRAME_KINDS: readonly unknown[] = ["snapshot", "live", "history"] satisfies AcpFrame["kind"][];

/**
 * Reads one message of an epoch stream (`/api/streams/c/<chat>/acp/<epoch>`): the capsule the
 * backend stored first (`{type: "capsule", chatEpoch, capsule, signature}`, bytes as base64url)
 * or a frame the Worker appended. Nothing is trusted yet: the capsule's signature and every
 * frame's seal are checked by {@link openAcpFrames}. Throws on any other shape.
 */
export function readEpochMessage(
  message: unknown,
): { capsule: AcpEpochCapsule } | { frame: AcpFrameRow } {
  if (!message || typeof message !== "object") {
    throw new CryptoError("BAD_ENVELOPE", "Agent stream message is invalid");
  }
  if ("type" in message && message.type === "capsule") {
    if (
      !("chatEpoch" in message) || typeof message.chatEpoch !== "number" ||
      !("capsule" in message) || typeof message.capsule !== "string" ||
      !("signature" in message) || typeof message.signature !== "string"
    ) throw new CryptoError("BAD_ENVELOPE", "Agent stream capsule is invalid");
    return {
      capsule: {
        chatEpoch: message.chatEpoch,
        capsule: fromBase64Url(message.capsule),
        signature: fromBase64Url(message.signature),
      },
    };
  }
  if (
    !("seqFrom" in message) || !Number.isSafeInteger(message.seqFrom) ||
    !("seqTo" in message) || !Number.isSafeInteger(message.seqTo) ||
    !("kind" in message) || !FRAME_KINDS.includes(message.kind) ||
    !("payload" in message) || typeof message.payload !== "string"
  ) throw new CryptoError("BAD_ENVELOPE", "Agent frame is invalid");
  return {
    frame: {
      seqFrom: message.seqFrom as number,
      seqTo: message.seqTo as number,
      kind: message.kind as AcpFrame["kind"],
      payload: message.payload,
    },
  };
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const frameKeys = new Map<string, Promise<Uint8Array>>();

onSecretsCleared(() => {
  for (const key of frameKeys.values()) void key.then((value) => value.fill(0)).catch(() => {});
  frameKeys.clear();
});

/**
 * Seals `command` to the Worker's encryption key and signs it with the user's identity. `chatId` is
 * `""` for agent-level commands and the deleted chat's ID for `close`/`delete`. Throws
 * `WorkerNotPairedError` when the Worker is not in the verified roster and `KeysLockedError` when
 * the identity is locked, so nothing unsigned is ever produced as a fallback.
 */
export async function signAcpCommand(input: {
  workspaceId: string;
  workerId: string;
  chatId: string;
  command: AcpCommandPayload;
  clientId?: string;
}): Promise<AcpSignedCommandWire> {
  const clientId = input.clientId ?? crypto.randomUUID();
  const worker = await trustedWorker(input.workspaceId, input.workerId);
  const payload = await sealBox({
    recipientPublicKey: worker.encryptionPublicKey,
    plaintext: utf8(JSON.stringify({ v: 1, issuedAt: Date.now(), command: input.command })),
    aad: {
      table: "acp_commands",
      workspace: input.workspaceId,
      parent: input.chatId,
      record: clientId,
      field: "payload",
    },
    pad: "content",
  });
  const { signature, signerKeyId } = await signAsUser(
    acpCommandStatement({
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      chatId: input.chatId,
      kind: input.command.kind,
      clientId,
      payload,
    }),
  );
  return {
    clientId,
    payload: toBase64Url(payload),
    signature: toBase64Url(signature),
    signerKeyId,
  };
}

/** Signs one command per Worker for an agent-level action; Workers outside the roster are skipped. */
export async function signAgentCommands(input: {
  workspaceId: string;
  workers: readonly string[];
  command: AcpCommandPayload;
}): Promise<Array<{ worker: string } & AcpSignedCommandWire>> {
  const signed: Array<{ worker: string } & AcpSignedCommandWire> = [];
  for (const worker of input.workers) {
    try {
      const command = await signAcpCommand({
        workspaceId: input.workspaceId,
        workerId: worker,
        chatId: "",
        command: input.command,
      });
      signed.push({ worker, ...command });
    } catch (error) {
      if (!(error instanceof WorkerNotPairedError)) throw error;
    }
  }
  return signed;
}

/**
 * Whether a workspace has encryption keys. Agent-level actions need a keyed workspace, since every
 * ACP command is signed and sealed. Throws `KeylessDowngradeError` when the server calls a
 * workspace keyless that this device verified as keyed.
 */
export async function isKeyedWorkspace(workspaceId: string): Promise<boolean> {
  const state = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  return keyedWorkspaceClaim(workspaceId, state.keyEpoch !== null);
}

/** Everything `acpBindingStatement` covers, except the signature. */
export type AcpBindingInput = {
  workspaceId: string;
  chatId: string;
  e2eeId: string;
  workerId: string;
  agentId: string;
  profile: string;
  cwd: string;
  scope: ChatScopeName;
  members: string[];
  version: number;
};

/** The current user, who must be the chat's creator, signs the chat's binding. */
export async function signAcpBinding(input: AcpBindingInput): Promise<AcpSignedBindingWire> {
  const { signature, signerKeyId } = await signAsUser(
    acpBindingStatement({
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      chatE2eeId: input.e2eeId,
      creatorUserId: currentUserId(),
      workerId: input.workerId,
      agentId: input.agentId,
      profile: input.profile,
      cwd: input.cwd,
      scope: input.scope,
      members: input.members,
      version: input.version,
    }),
  );
  return {
    version: input.version,
    scope: input.scope,
    members: input.members,
    signerKeyId,
    signature: toBase64Url(signature),
  };
}

/**
 * The owner's proof that they bound an indexed agent session to a chat Radium created for it
 * (`openAgentSession`): their signature over an `import` command statement for that session.
 */
export async function signImportProof(input: {
  workspaceId: string;
  workerId: string;
  chatId: string;
  agentId: string;
  sessionId: string;
}): Promise<{ signerKeyId: string; signature: string }> {
  const { signature, signerKeyId } = await signAsUser(
    acpCommandStatement({
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      chatId: input.chatId,
      kind: "import",
      clientId: input.sessionId,
      payload: utf8(input.agentId),
    }),
  );
  return { signerKeyId, signature: toBase64Url(signature) };
}

/**
 * Signs and publishes a chat's binding using the session fields the server holds, which are
 * exactly what the signature must cover. Creator-only; `version` is the stored version plus one.
 */
export async function publishAcpBinding(input: {
  chatId: string;
  e2eeId: string;
  scope: ChatScopeName;
  members: string[];
  version: number;
  importProof?: { signerKeyId: string; signature: string };
}): Promise<AcpSignedBindingWire> {
  const session = await trpcClient().acp.getSession.query({ chat: input.chatId });
  const binding = await signAcpBinding({
    workspaceId: session.workspace,
    chatId: input.chatId,
    e2eeId: input.e2eeId,
    workerId: session.agent.worker,
    agentId: session.agent.agentId,
    profile: session.agent.profile,
    cwd: session.agent.cwd,
    scope: input.scope,
    members: input.members,
    version: input.version,
  });
  await trpcClient().acp.publishBinding.mutate({
    chat: input.chatId,
    binding,
    ...(input.importProof ? { importProof: input.importProof } : {}),
  });
  return binding;
}

/**
 * The creator's next binding for exactly the audience a scope change produces, to travel with
 * `chats.setScope`: the stored version plus one over the session fields the server holds. `undefined`
 * while the chat has no published binding, which the server then also refuses to receive.
 */
export async function nextAcpBinding(
  chatId: string,
  audience: { scope: ChatScopeName; members: string[] },
): Promise<AcpSignedBindingWire | undefined> {
  const [session, keys] = await Promise.all([
    trpcClient().acp.getSession.query({ chat: chatId }),
    trpcClient().e2ee.chatKeys.query({ chatId }),
  ]);
  if (!session.binding || !keys.e2eeId) return undefined;
  return signAcpBinding({
    workspaceId: session.workspace,
    chatId,
    e2eeId: keys.e2eeId,
    workerId: session.agent.worker,
    agentId: session.agent.agentId,
    profile: session.agent.profile,
    cwd: session.agent.cwd,
    scope: audience.scope,
    members: audience.members,
    version: session.binding.version + 1,
  });
}

/**
 * Repairs a chat that has keys but no binding (an older chat opened by its creator after the
 * workspace got keys): signs and publishes version 1 for the chat's current audience. Does nothing
 * for anyone but the creator. An older chat already bound to an agent session (`sessionId`) also
 * needs the owner's import proof; `authorizeSession` signs it, so call it only on the owner's
 * explicit confirmation: the stored session ID is server data until the owner vouches for it.
 */
export async function repairAcpBinding(
  chatId: string,
  options: { authorizeSession?: boolean } = {},
): Promise<void> {
  const state = await trpcClient().e2ee.chatKeys.query({ chatId });
  if (!state.e2eeId || state.creatorId !== currentUserId()) return;
  let importProof: { signerKeyId: string; signature: string } | undefined;
  if (options.authorizeSession) {
    const session = await trpcClient().acp.getSession.query({ chat: chatId });
    if (session.agent.sessionId) {
      importProof = await signImportProof({
        workspaceId: session.workspace,
        workerId: session.agent.worker,
        chatId,
        agentId: session.agent.agentId,
        sessionId: session.agent.sessionId,
      });
    }
  }
  await publishAcpBinding({
    chatId,
    e2eeId: state.e2eeId,
    scope: state.scope,
    members: state.scope === "shared" ? state.members : [],
    version: 1,
    ...(importProof ? { importProof } : {}),
  });
}

/** Seals an interaction answer to the Worker and signs it; the Worker alone can validate it. */
export async function sealAcpAnswer(input: {
  workspaceId: string;
  workerId: string;
  chatId: string;
  requestKey: string;
  answer: AcpInteractionAnswer;
}): Promise<{ answer: string; signature: string; signerKeyId: string }> {
  const worker = await trustedWorker(input.workspaceId, input.workerId);
  const sealed = await sealBox({
    recipientPublicKey: worker.encryptionPublicKey,
    plaintext: utf8(JSON.stringify(input.answer)),
    aad: {
      table: "acp_interactions",
      workspace: input.workspaceId,
      parent: input.chatId,
      record: input.requestKey,
      field: "answer",
    },
    pad: "content",
  });
  const { signature, signerKeyId } = await signAsUser(
    acpAnswerStatement({
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      chatId: input.chatId,
      requestKey: input.requestKey,
      answer: sealed,
    }),
  );
  return { answer: toBase64Url(sealed), signature: toBase64Url(signature), signerKeyId };
}

/** First prompt reduced to one line of at most 80 characters, for the browser's fallback title. */
export function acpFallbackTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * What reading a Worker's objects depends on: the roster-verified signing key of the chat's Worker
 * and the chat seed. Production reads the verified roster and the unlocked key store; tests
 * substitute them to exercise the verification itself.
 */
export type AcpReadSources = {
  workerSigningKey(chat: AcpChatContext): Promise<Uint8Array>;
  chatSeed(chatId: string, epoch: number): Promise<Uint8Array>;
};

const liveSources: AcpReadSources = {
  workerSigningKey: async (chat) =>
    (await trustedWorker(chat.workspaceId, chat.workerId)).signingPublicKey,
  chatSeed: openChatSeed,
};

/** Verifies a Worker's signature over an object at its AAD location; the roster decides the key. */
async function verifyWorkerObject(
  chat: AcpChatContext,
  location: { table: string; record: string; field: string },
  object: Uint8Array,
  signature: Uint8Array,
  sources: AcpReadSources,
): Promise<void> {
  const valid = await verify(
    await sources.workerSigningKey(chat),
    workerObjectStatement({
      workspaceId: chat.workspaceId,
      workerId: chat.workerId,
      table: location.table,
      parent: chat.e2eeId,
      record: location.record,
      field: location.field,
      object,
    }),
    signature,
  );
  if (!valid) throw new CryptoError("BAD_SIGNATURE", "Agent content is not signed by its Worker");
}

/**
 * Key of one ACP stream epoch's frames. The epoch capsule is accepted only when the roster-listed
 * Worker signed it for this chat and epoch; the key is cached per chat and epoch until the keys
 * lock. A failed attempt is not cached.
 */
function acpFrameKey(
  chat: AcpChatContext,
  epoch: number,
  stream: AcpEpochCapsule | undefined,
  sources: AcpReadSources,
): Promise<Uint8Array> {
  const cacheKey = `${chat.chatId}:${epoch}`;
  const cached = frameKeys.get(cacheKey);
  if (cached) return cached;
  const opening = (async () => {
    if (!stream) {
      throw new CryptoError("DECRYPT_FAILED", "The agent has not published this stream yet");
    }
    await verifyWorkerObject(
      chat,
      { table: "acp_streams", record: String(epoch), field: "capsule" },
      stream.capsule,
      stream.signature,
      sources,
    );
    return openCapsule({
      seed: await sources.chatSeed(chat.chatId, stream.chatEpoch),
      capsule: decodeCapsule(stream.capsule),
      aad: {
        table: "acp_streams",
        workspace: chat.workspaceId,
        parent: chat.e2eeId,
        record: String(epoch),
        field: "capsule",
      },
    });
  })();
  frameKeys.set(cacheKey, opening);
  opening.catch(() => {
    if (frameKeys.get(cacheKey) === opening) frameKeys.delete(cacheKey);
  });
  return opening;
}

/**
 * Decrypts frames of one stream epoch under its `capsule` (the stream's first message). Throws,
 * applying nothing, when the capsule is missing or not signed by the roster Worker. Each frame
 * must authenticate its range and kind as well as its payload; invalid frames stop the fold
 * instead of advancing it.
 */
export async function openAcpFrames(
  chat: AcpChatContext,
  epoch: number,
  capsule: AcpEpochCapsule | undefined,
  rows: readonly AcpFrameRow[],
  sources: AcpReadSources = liveSources,
): Promise<AcpFrame[]> {
  const capsuleKey = await acpFrameKey(chat, epoch, capsule, sources);
  return Promise.all(
    rows.map(async (row): Promise<AcpFrame> => {
      const frame = { seqFrom: row.seqFrom, seqTo: row.seqTo, kind: row.kind };
      let envelope: Uint8Array;
      try {
        envelope = fromBase64Url(row.payload);
      } catch {
        throw new CryptoError("BAD_ENVELOPE", "Agent frame is not encrypted");
      }
      const plaintext = await openWithCapsule({
        capsuleKey,
        envelope,
        aad: {
          table: "chat_frames",
          workspace: chat.workspaceId,
          parent: chat.e2eeId,
          record: `${epoch}:${row.seqFrom}`,
          field: "payload",
        },
        pad: "content",
      });
      const opened: unknown = JSON.parse(decoder.decode(plaintext));
      if (
        !opened || typeof opened !== "object" ||
        !("seqTo" in opened) || opened.seqTo !== row.seqTo ||
        !("kind" in opened) || opened.kind !== row.kind ||
        !("ops" in opened) || !Array.isArray(opened.ops)
      ) throw new CryptoError("BAD_ENVELOPE", "Agent frame metadata is invalid");
      return { ...frame, payload: JSON.stringify(opened.ops) };
    }),
  );
}

/**
 * Opens a sealed interaction request after verifying the roster Worker's signature over it, so a
 * backend-authored question is never shown. Throws on any failure.
 */
export async function openAcpInteraction(
  chat: AcpChatContext,
  row: {
    requestKey: string;
    sealed: { epoch: number; box: string; signature: string };
  },
  sources: AcpReadSources = liveSources,
): Promise<AcpInteractionRequest> {
  const box = fromBase64Url(row.sealed.box);
  await verifyWorkerObject(
    chat,
    { table: "acp_interactions", record: row.requestKey, field: "request" },
    box,
    fromBase64Url(row.sealed.signature),
    sources,
  );
  const plaintext = await openBox({
    seed: await sources.chatSeed(chat.chatId, row.sealed.epoch),
    box,
    aad: {
      table: "acp_interactions",
      workspace: chat.workspaceId,
      parent: chat.e2eeId,
      record: row.requestKey,
      field: "request",
    },
    pad: "content",
  });
  const request: unknown = JSON.parse(decoder.decode(plaintext));
  plaintext.fill(0);
  if (
    !request ||
    typeof request !== "object" ||
    !("kind" in request) ||
    (request.kind !== "permission" && request.kind !== "elicitation")
  ) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid interaction request");
  }
  return request as AcpInteractionRequest;
}

/** Opens the Worker's sealed session error (a JSON string sealed to the chat key). */
export async function openAcpError(
  chat: Pick<AcpChatContext, "chatId" | "workspaceId" | "e2eeId">,
  sealed: { epoch: number; box: string },
): Promise<string> {
  const plaintext = await openBox({
    seed: await openChatSeed(chat.chatId, sealed.epoch),
    box: fromBase64Url(sealed.box),
    aad: {
      table: "acp_sessions",
      workspace: chat.workspaceId,
      parent: chat.e2eeId,
      record: String(sealed.epoch),
      field: "error",
    },
    pad: "short",
  });
  const message: unknown = JSON.parse(decoder.decode(plaintext));
  plaintext.fill(0);
  if (typeof message !== "string") throw new CryptoError("BAD_ENVELOPE", "Invalid session error");
  return message;
}

/**
 * Opens an agent session index title, sealed by the Worker to the workspace owner key epoch. Only
 * the owner can open it; the AAD binds it to the Worker, agent and session.
 */
export async function openAgentIndexTitle(input: {
  workspaceId: string;
  workerId: string;
  agentId: string;
  sessionId: string;
  sealedTitle: { epoch: number; box: string };
}): Promise<string> {
  const owner = await getOwnerKey(input.workspaceId, input.sealedTitle.epoch);
  const plaintext = await openBox({
    seed: owner.seed,
    box: fromBase64Url(input.sealedTitle.box),
    aad: {
      table: "acp_agent_sessions",
      workspace: input.workspaceId,
      parent: input.workerId,
      record: `${input.agentId}:${input.sessionId}`,
      field: "title",
    },
    pad: "short",
  });
  try {
    return decoder.decode(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
