import {
  acpAgentDefinitionStatement,
  acpAnswerStatement,
  acpBindingStatement,
  acpCommandStatement,
  createCapsule,
  encodeCapsule,
  equalBytes,
  hkdf,
  hmacSha256,
  openBox,
  sealBox,
  sealWithCapsule,
  sha256,
  toBase64Url,
  utf8,
} from "radium-crypto";
import {
  ACP_COMMAND_EXPIRY_MS,
  ACP_WORKER_ERROR_CODES,
  acpAnswerError,
  type AcpAgentDefinition,
  type AcpCommandPayload,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
  type AcpProfile,
  type AcpSessionProof,
  type AcpSignedBinding,
} from "contracts/acp/contract";
import { WORKER_APPROVAL_CLOCK_SKEW_MS } from "contracts/worker/task-contract";
import { WorkerTrustError, type WorkerTrust } from "../e2ee/trust.js";
import { verifyChatKey } from "../e2ee/chat-key.js";
import type { AcpFrameSealer } from "./relay.js";
import type {
  AcpAnsweredInteraction,
  AcpChatE2ee,
  AcpClaim,
  AcpSealedBox,
  AcpSealedRequest,
  AcpSessionPatch,
  AcpTransport,
} from "./transport.js";

/** Fixed reason a paired Worker reports for a command it refuses or could not run. */
export type AcpWorkerErrorCode = (typeof ACP_WORKER_ERROR_CODES)[number];

/** Commands older than this (other than `close`/`delete`) are refused as replays. */
const COMMAND_WINDOW_MS = 15 * 60_000;
/** Tolerated clock skew of a command's `issuedAt` into the future. */
const COMMAND_SKEW_MS = 5 * 60_000;

/**
 * A refusal with a fixed, content-free code. Its `code` starts with `ACP_`, so the relay treats it
 * as permanent rather than retrying it.
 */
export class AcpRefusal extends Error {
  public constructor(public readonly code: AcpWorkerErrorCode) {
    super(code);
    this.name = "AcpRefusal";
  }
}

/** The fixed code reported for any failure: refusals keep theirs, trust failures are forbidden. */
export function workerErrorCode(error: unknown): AcpWorkerErrorCode {
  if (error instanceof AcpRefusal) return error.code;
  if (error instanceof WorkerTrustError) return "ACP_FORBIDDEN";
  return "ACP_FAILED";
}

/** A fixed code from a finished command's free-text error: anything else becomes `ACP_FAILED`. */
export function fixedErrorCode(error: string | undefined): AcpWorkerErrorCode {
  return ACP_WORKER_ERROR_CODES.find((code) => code === error) ?? "ACP_FAILED";
}

/** Convex wire form (`v.bytes()`) of a byte array, detached from any larger backing buffer. */
export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * A chat's binding after its creator's signature, pin and version were checked. `cwd`, `agentId`
 * and `profile` are the signed values: the only ones a paired Worker uses to open a session.
 */
export interface VerifiedBinding {
  chat: string;
  e2eeId: string;
  creatorUserId: string;
  agentId: string;
  profile: AcpProfile;
  cwd: string;
  scope: AcpSignedBinding["scope"];
  members: string[];
  version: number;
}

/** A command that passed signature, freshness, replay and audience checks. */
export interface AuthorizedCommand {
  /** The sealed, signed payload; never the claim's plaintext fields. */
  payload: AcpCommandPayload;
  /** Verified binding of the chat (session-level) or of the deleted target (`close`/`delete`). */
  binding: VerifiedBinding | null;
  /** The server-supplied session ID, present only if its proof verified. */
  sessionId: string | null;
}

/** The current chat key after signature, audience and rollback checks. */
export interface VerifiedChatKey {
  epoch: number;
  publicKey: Uint8Array;
}

/** What `patchForWire` needs to know about the session it patches. */
export interface PatchContext {
  binding: VerifiedBinding | undefined;
  agentId: string;
  sessionId: string | null;
}

/** Owner-key sealing of index titles for one sync run or patch. */
export interface IndexSealer {
  epoch: number;
  /** Keyed tag only this Worker can compute; the server diffs on it without seeing the title. */
  tag(agentId: string, sessionId: string, title: string): Promise<string>;
  seal(agentId: string, sessionId: string, title: string): Promise<AcpSealedBox & { tag: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseProfile(value: unknown): AcpProfile | null {
  return value === "native" || value === "gateway" ? value : null;
}

/** Structural check of an opened command; the sealed JSON is signed but still untrusted input. */
function parseCommand(value: unknown): AcpCommandPayload | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "prompt": {
      if (!Array.isArray(value.prompt)) return null;
      const prompt: Extract<AcpCommandPayload, { kind: "prompt" }>["prompt"] = [];
      for (const block of value.prompt) {
        if (!isRecord(block)) return null;
        if (block.type === "text" && isText(block.text)) {
          prompt.push({ type: "text", text: block.text });
        } else if (block.type === "resource_link" && isText(block.uri) && isText(block.name)) {
          prompt.push({
            type: "resource_link",
            uri: block.uri,
            name: block.name,
            ...(isText(block.mimeType) ? { mimeType: block.mimeType } : {}),
          });
        } else return null;
      }
      return { kind: "prompt", prompt };
    }
    case "cancel":
      return { kind: "cancel" };
    case "set_config":
      return isText(value.configId) && (isText(value.value) || typeof value.value === "boolean")
        ? { kind: "set_config", configId: value.configId, value: value.value }
        : null;
    case "set_mode":
      return isText(value.modeId) ? { kind: "set_mode", modeId: value.modeId } : null;
    case "history":
      return isNumber(value.epoch) && isNumber(value.before) && isNumber(value.limit)
        ? { kind: "history", epoch: value.epoch, before: value.before, limit: value.limit }
        : null;
    case "sync_sessions":
    case "logout":
      return isText(value.agentId) ? { kind: value.kind, agentId: value.agentId } : null;
    case "authenticate":
      return isText(value.agentId) && isText(value.methodId)
        ? { kind: "authenticate", agentId: value.agentId, methodId: value.methodId }
        : null;
    case "fork":
      return isText(value.targetChat) ? { kind: "fork", targetChat: value.targetChat } : null;
    case "close":
    case "delete": {
      const profile = parseProfile(value.profile);
      return profile && isText(value.agentId) && isText(value.sessionId) && isText(value.cwd)
        ? {
            kind: value.kind,
            agentId: value.agentId,
            profile,
            sessionId: value.sessionId,
            cwd: value.cwd,
          }
        : null;
    }
    default:
      return null;
  }
}

/** Structural check of an opened answer before `acpAnswerError` reads it. */
function parseAnswer(value: unknown): AcpInteractionAnswer | null {
  if (!isRecord(value)) return null;
  if (value.kind === "permission")
    return isText(value.optionId) ? { kind: "permission", optionId: value.optionId } : null;
  if (value.kind !== "elicitation") return null;
  if (value.action === "decline" || value.action === "cancel")
    return { kind: "elicitation", action: value.action };
  if (value.action !== "accept" || !Array.isArray(value.content)) return null;
  const content: Extract<AcpInteractionAnswer, { action: "accept" }>["content"] = [];
  for (const entry of value.content) {
    if (!isRecord(entry) || !isText(entry.name)) return null;
    const answer = entry.value;
    const valid =
      isText(answer) ||
      isNumber(answer) ||
      typeof answer === "boolean" ||
      (Array.isArray(answer) && answer.every(isText));
    if (!valid) return null;
    content.push({ name: entry.name, value: answer as never });
  }
  return { kind: "elicitation", action: "accept", content };
}

/** Whether `userId` is in the audience of the creator's binding (workspace: any roster user). */
function inAudience(binding: VerifiedBinding, userId: string): boolean {
  if (binding.scope === "workspace") return true;
  if (userId === binding.creatorUserId) return true;
  return binding.scope === "shared" && binding.members.includes(userId);
}

/**
 * Everything a paired Worker must verify before acting on what Convex served (design: "Worker
 * authorization rules"). Convex is untrusted storage: a command, binding, chat key or answer
 * counts only after a signature from the roster verified here. Nothing here is used by an
 * unpaired Worker, whose host constructs no instance.
 */
export class AcpSigned {

  public constructor(
    private readonly trust: WorkerTrust,
    private readonly transport: Pick<AcpTransport, "chatKey">,
  ) {}

  private get workspace(): string {
    return this.trust.workspaceId;
  }

  /**
   * Authorize every launch field before probing or spawning an agent. Monotonic owner-issued
   * timestamps and a per-timestamp statement pin prevent rollback and same-version equivocation.
   * `false` is a definitive refusal (bad or non-owner signature, rollback, equivocation, issue time
   * too far in the future).
   * @throws WorkerTrustError, transport or state errors when trust cannot be established right now;
   *   callers retry instead of refusing the agent.
   */
  public async verifyDefinition(definition: AcpAgentDefinition): Promise<boolean> {
    const authorization = definition.authorization;
    if (!authorization || !Number.isSafeInteger(authorization.issuedAt) || authorization.issuedAt <= 0)
      return false;
    // A far-future issue time must never advance the high-water and lock out later definitions.
    if (authorization.issuedAt > Date.now() + WORKER_APPROVAL_CLOCK_SKEW_MS) return false;
    const message = acpAgentDefinitionStatement({
      workspaceId: this.workspace,
      issuedAt: authorization.issuedAt,
      definition,
    });
    const signer = await this.trust.verifyUser({
      signerKeyId: authorization.signerKeyId,
      message,
      signature: new Uint8Array(authorization.signature),
    });
    if (signer?.role !== "owner") return false;
    const mark = `acp-agent:${definition.agentId}`;
    if (authorization.issuedAt < this.trust.highWater(mark)) return false;
    if (!(await this.trust.pin(`${mark}:${authorization.issuedAt}`, toBase64Url(await sha256(message)))))
      return false;
    await this.trust.advanceHighWater(mark, authorization.issuedAt);
    return authorization.issuedAt >= this.trust.highWater(mark);
  }

  /**
   * Verify the signed binding and pinned creator. The version may never go below the highest seen.
   * Reverify on every use: roster membership and the binding high-water mark can change.
   * @throws AcpRefusal `ACP_FORBIDDEN` for any failure, including a chat without a binding.
   */
  public async verifyBinding(input: {
    chat: string;
    e2ee: AcpChatE2ee | null;
    agentId: string;
    profile: AcpProfile;
    cwd: string;
  }): Promise<VerifiedBinding> {
    const { chat, e2ee } = input;
    const binding = e2ee?.binding;
    if (!e2ee || !binding) throw new AcpRefusal("ACP_FORBIDDEN");
    const message = acpBindingStatement({
      workspaceId: this.workspace,
      chatId: chat,
      chatE2eeId: e2ee.e2eeId,
      creatorUserId: e2ee.creatorUserId,
      workerId: this.trust.workerId,
      agentId: input.agentId,
      profile: input.profile,
      cwd: input.cwd,
      scope: binding.scope,
      members: binding.members,
      version: binding.version,
    });
    const signature = new Uint8Array(binding.signature);

    const signer = await this.trust.verifyUser({
      signerKeyId: binding.signerKeyId,
      message,
      signature,
    });
    if (signer?.userId !== e2ee.creatorUserId) throw new AcpRefusal("ACP_FORBIDDEN");
    if (!(await this.trust.pin(`acp-creator:${chat}`, e2ee.creatorUserId)))
      throw new AcpRefusal("ACP_FORBIDDEN");
    const mark = `acp-binding:${chat}`;
    if (binding.version < this.trust.highWater(mark)) throw new AcpRefusal("ACP_FORBIDDEN");
    // Do not accept two creator-signed audiences at the same version.
    if (!(await this.trust.pin(`acp-binding:${chat}:${binding.version}`, toBase64Url(await sha256(message)))))
      throw new AcpRefusal("ACP_FORBIDDEN");
    await this.trust.advanceHighWater(mark, binding.version);
    if (binding.version < this.trust.highWater(mark)) throw new AcpRefusal("ACP_FORBIDDEN");

    const value: VerifiedBinding = {
      chat,
      e2eeId: e2ee.e2eeId,
      creatorUserId: e2ee.creatorUserId,
      agentId: input.agentId,
      profile: input.profile,
      cwd: input.cwd,
      scope: binding.scope,
      members: [...binding.members],
      version: binding.version,
    };
    return value;
  }

  /**
   * Whether `proof` binds `sessionId` to the chat: the Worker's own deterministic signature
   * (re-derived, not trusted) or the workspace owner's import signature.
   */
  public async sessionProofValid(
    binding: VerifiedBinding,
    sessionId: string,
    proof: AcpSessionProof | null,
  ): Promise<boolean> {
    if (!proof) return false;
    if (proof.kind === "worker") {
      const expected = await this.trust.signObject({
        table: "acp_sessions",
        parent: binding.chat,
        record: sessionId,
        field: "sessionId",
        object: utf8(binding.agentId),
      });
      return equalBytes(expected, new Uint8Array(proof.signature));
    }
    const signer = await this.trust.verifyUser({
      signerKeyId: proof.signerKeyId,
      message: acpCommandStatement({
        workspaceId: this.workspace,
        workerId: this.trust.workerId,
        chatId: binding.chat,
        kind: "import",
        clientId: sessionId,
        payload: utf8(binding.agentId),
      }),
      signature: new Uint8Array(proof.signature),
    });
    return signer?.role === "owner";
  }

  /**
   * Verify a warm-session or session-level claim's binding and `sessionId` proof.
   * @returns the verified binding and the session ID only when its proof is valid (else null).
   * @throws AcpRefusal when the binding fails or a present session ID has no valid proof.
   */
  public async verifySession(input: {
    chat: string;
    e2ee: AcpChatE2ee | null;
    agentId: string;
    profile: AcpProfile;
    cwd: string;
    sessionId: string | null;
  }): Promise<{ binding: VerifiedBinding; sessionId: string | null }> {
    const binding = await this.verifyBinding(input);
    if (input.sessionId === null) return { binding, sessionId: null };
    if (!(await this.sessionProofValid(binding, input.sessionId, input.e2ee?.sessionProof ?? null)))
      throw new AcpRefusal("ACP_FORBIDDEN");
    return { binding, sessionId: input.sessionId };
  }

  /**
   * Authorize one claimed command from its sealed, signed payload alone. `claim.payload`,
   * `claim.by` and `session.draft` are never consulted.
   * @throws AcpRefusal with the fixed code to report; other errors are infrastructure failures.
   */
  public async verifyCommand(claim: AcpClaim): Promise<AuthorizedCommand> {
    const signed = claim.signed;
    if (!signed) throw new AcpRefusal("ACP_UNSIGNED");
    const chatId = claim.chat ?? claim.target?.chat ?? "";
    const box = new Uint8Array(signed.payload);
    const signer = await this.trust.verifyUser({
      signerKeyId: signed.signerKeyId,
      message: acpCommandStatement({
        workspaceId: this.workspace,
        workerId: this.trust.workerId,
        chatId,
        kind: claim.kind,
        clientId: claim.clientId,
        payload: box,
      }),
      signature: new Uint8Array(signed.signature),
    });
    if (!signer) throw new AcpRefusal("ACP_UNSIGNED");

    const seed = this.trust.encryptionSeed();
    let plaintext: Uint8Array;
    try {
      plaintext = await openBox({
        seed,
        box,
        aad: {
          table: "acp_commands",
          workspace: this.workspace,
          parent: chatId,
          record: claim.clientId,
          field: "payload",
        },
        pad: "content",
      });
    } catch {
      throw new AcpRefusal("ACP_UNSIGNED");
    } finally {
      seed.fill(0);
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new AcpRefusal("ACP_UNSIGNED");
    }
    if (!isRecord(envelope) || envelope.v !== 1 || !isNumber(envelope.issuedAt))
      throw new AcpRefusal("ACP_UNSIGNED");
    const payload = parseCommand(envelope.command);
    if (!payload || payload.kind !== claim.kind) throw new AcpRefusal("ACP_UNSIGNED");

    const now = Date.now();
    const lifetime =
      payload.kind === "close" || payload.kind === "delete"
        ? ACP_COMMAND_EXPIRY_MS
        : COMMAND_WINDOW_MS;
    if (envelope.issuedAt > now + COMMAND_SKEW_MS || now - envelope.issuedAt > lifetime)
      throw new AcpRefusal("ACP_EXPIRED");
    // Persist the replay guard so restarting the Worker cannot re-execute a captured command.
    if (!(await this.trust.claimOnce(`acp-command:${claim.clientId}`, envelope.issuedAt + lifetime + 1)))
      throw new AcpRefusal("ACP_FORBIDDEN");

    if (payload.kind === "sync_sessions" || payload.kind === "authenticate" || payload.kind === "logout") {
      if (signer.role !== "owner") throw new AcpRefusal("ACP_FORBIDDEN");
      return { payload, binding: null, sessionId: null };
    }

    if (payload.kind === "close" || payload.kind === "delete") {
      const target = claim.target;
      if (!target) throw new AcpRefusal("ACP_FORBIDDEN");
      const binding = await this.verifyBinding({
        chat: target.chat,
        e2ee: {
          e2eeId: target.e2eeId,
          creatorUserId: target.creatorUserId,
          binding: target.binding,
          sessionProof: target.sessionProof,
        },
        agentId: target.agentId,
        profile: target.profile,
        cwd: target.cwd,
      });
      // The command may only name the session this chat was bound to, never another one.
      const bound =
        payload.sessionId === target.sessionId &&
        payload.agentId === target.agentId &&
        payload.profile === target.profile &&
        payload.cwd === binding.cwd &&
        inAudience(binding, signer.userId) &&
        (await this.sessionProofValid(binding, target.sessionId, target.sessionProof));
      if (!bound) throw new AcpRefusal("ACP_FORBIDDEN");
      return { payload, binding, sessionId: target.sessionId };
    }

    const session = claim.session;
    if (!claim.chat || !session) throw new AcpRefusal("ACP_SESSION_DELETED");
    const verified = await this.verifySession({
      chat: claim.chat,
      e2ee: session.e2ee,
      agentId: session.agentId,
      profile: session.profile,
      cwd: session.cwd,
      sessionId: session.sessionId,
    });
    if (!inAudience(verified.binding, signer.userId)) throw new AcpRefusal("ACP_FORBIDDEN");
    // Do not start content-producing work while a removed recipient still holds the old key.
    if (payload.kind !== "cancel") await this.chatKey(verified.binding);
    if (payload.kind === "fork") await this.verifyForkTarget(claim, payload.targetChat, verified.binding, signer);
    return { payload, ...verified };
  }

  /**
   * A fork writes a session ID into another chat, so that chat must be the one the issuer bound:
   * the claim's `forkTarget` names `targetChat`, carries a binding verified like any chat's (its
   * creator is the command's signer, pinned for that chat) and runs the same agent, profile and
   * directory as the source.
   * @throws AcpRefusal `ACP_FORBIDDEN` on any mismatch.
   */
  private async verifyForkTarget(
    claim: AcpClaim,
    targetChat: string,
    source: VerifiedBinding,
    signer: { userId: string },
  ): Promise<void> {
    const target = claim.forkTarget;
    if (
      !target ||
      !target.e2ee ||
      target.chat !== targetChat ||
      target.chat === source.chat ||
      target.agentId !== source.agentId ||
      target.profile !== source.profile ||
      target.cwd !== source.cwd
    )
      throw new AcpRefusal("ACP_FORBIDDEN");
    const binding = await this.verifyBinding({
      chat: target.chat,
      e2ee: target.e2ee,
      agentId: target.agentId,
      profile: target.profile,
      cwd: target.cwd,
    });
    if (binding.creatorUserId !== signer.userId) throw new AcpRefusal("ACP_FORBIDDEN");
  }

  /**
   * The chat's current key, signed by an audience member and not older than any epoch seen.
   * @throws AcpRefusal when unsigned, mismatched, from outside the audience, rolled back or
   *   awaiting a rekey.
   */
  public async chatKey(binding: VerifiedBinding): Promise<VerifiedChatKey> {
    if (binding.version < this.trust.highWater(`acp-binding:${binding.chat}`))
      throw new AcpRefusal("ACP_FORBIDDEN");
    const key = await this.transport.chatKey({ chat: binding.chat });
    if (!key || key.e2eeId !== binding.e2eeId || key.rekey) throw new AcpRefusal("ACP_FORBIDDEN");
    if (!key.signature || !key.signerKeyId) throw new AcpRefusal("ACP_UNSIGNED");
    // An epoch without a binding predates recipient binding: readable, never sealed to.
    if (!key.bindingSignature) throw new AcpRefusal("ACP_FORBIDDEN");
    const publicKey = new Uint8Array(key.publicKey);
    // The creator-signed ACP binding is the authority for scope, creator and members; the key's
    // own signed member list must equal it exactly. A narrower or wider list means the audience
    // changed since the epoch was bound, so it must rotate before anything new is sealed to it.
    const members = binding.scope === "shared" ? [...new Set(binding.members)].sort() : [];
    const bound =
      binding.scope === "shared"
        ? key.bindingMembers && [...new Set(key.bindingMembers)].sort()
        : (key.bindingMembers ?? []);
    if (
      !bound ||
      bound.length !== members.length ||
      bound.some((member, index) => member !== members[index])
    )
      throw new AcpRefusal("ACP_FORBIDDEN");
    const signerUserId = await verifyChatKey(this.trust, {
      chatId: binding.chat,
      e2eeId: key.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey,
      signerKeyId: key.signerKeyId,
      signature: new Uint8Array(key.signature),
      bindingSignature: new Uint8Array(key.bindingSignature),
      scope: binding.scope,
      creatorId: binding.creatorUserId,
      members,
    });
    if (!signerUserId) throw new AcpRefusal("ACP_UNSIGNED");
    if (!inAudience(binding, signerUserId)) throw new AcpRefusal("ACP_FORBIDDEN");
    const mark = `acp-chat-epoch:${binding.chat}`;
    if (key.epoch < this.trust.highWater(mark)) throw new AcpRefusal("ACP_FORBIDDEN");
    await this.trust.advanceHighWater(mark, key.epoch);
    if (key.epoch < this.trust.highWater(mark)) throw new AcpRefusal("ACP_FORBIDDEN");
    return { epoch: key.epoch, publicKey };
  }

  /**
   * Frame encryption for a chat: each epoch re-reads the chat key (a rotation applies from the
   * next epoch), makes one signed capsule and seals every frame under it.
   * @param binding Reads the chat's currently verified binding when an epoch opens.
   */
  public frameSealer(binding: () => VerifiedBinding | undefined): AcpFrameSealer {
    return {
      openEpoch: async (epoch) => {
        const verified = binding();
        if (!verified) throw new AcpRefusal("ACP_FORBIDDEN");
        const key = await this.chatKey(verified);
        const parts = {
          table: "acp_streams",
          parent: verified.e2eeId,
          record: String(epoch),
          field: "capsule",
        };
        const { capsule, capsuleKey } = await createCapsule({
          recipientPublicKey: key.publicKey,
          aad: { ...parts, workspace: this.workspace },
        });
        const encoded = encodeCapsule(capsule);
        const signature = await this.trust.signObject({ ...parts, object: encoded });
        return {
          capsule: {
            chatEpoch: key.epoch,
            capsule: arrayBuffer(encoded),
            signature: arrayBuffer(signature),
          },
          seal: async ({ seqFrom, seqTo, kind, payload }) =>
            arrayBuffer(
              await sealWithCapsule({
                capsuleKey,
                capsuleId: capsule.capsuleId,
                plaintext: utf8(JSON.stringify({ seqTo, kind, ops: JSON.parse(payload) })),
                aad: {
                  table: "chat_frames",
                  workspace: this.workspace,
                  parent: verified.e2eeId,
                  record: `${epoch}:${seqFrom}`,
                  field: "payload",
                },
                pad: "content",
              }),
            ),
        };
      },
    };
  }

  /** Seal an interaction request to the current chat key and sign it for clients. */
  public async sealRequest(
    binding: VerifiedBinding,
    requestKey: string,
    request: AcpInteractionRequest,
  ): Promise<AcpSealedRequest> {
    const key = await this.chatKey(binding);
    const parts = {
      table: "acp_interactions",
      parent: binding.e2eeId,
      record: requestKey,
      field: "request",
    };
    const box = await sealBox({
      recipientPublicKey: key.publicKey,
      plaintext: utf8(JSON.stringify(request)),
      aad: { ...parts, workspace: this.workspace },
      pad: "content",
    });
    const signature = await this.trust.signObject({ ...parts, object: box });
    return {
      kind: request.kind,
      epoch: key.epoch,
      box: arrayBuffer(box),
      signature: arrayBuffer(signature),
    };
  }

  /**
   * Open and validate an answer: signed by an audience member, sealed to this Worker and valid for
   * the Worker's own copy of the request.
   * @returns the answer, or null when the row must be reopened instead of obeyed.
   */
  public async openAnswer(
    binding: VerifiedBinding,
    row: AcpAnsweredInteraction,
    request: AcpInteractionRequest,
  ): Promise<AcpInteractionAnswer | null> {
    if (binding.version < this.trust.highWater(`acp-binding:${binding.chat}`)) return null;
    const sealed = row.sealed;
    if (!sealed || row.chat !== binding.chat) return null;
    const box = new Uint8Array(sealed.answer);
    const signer = await this.trust.verifyUser({
      signerKeyId: sealed.signerKeyId,
      message: acpAnswerStatement({
        workspaceId: this.workspace,
        workerId: this.trust.workerId,
        chatId: row.chat,
        requestKey: row.requestKey,
        answer: box,
      }),
      signature: new Uint8Array(sealed.signature),
    });
    if (!signer || !inAudience(binding, signer.userId)) return null;

    const seed = this.trust.encryptionSeed();
    try {
      const plaintext = await openBox({
        seed,
        box,
        aad: {
          table: "acp_interactions",
          workspace: this.workspace,
          parent: row.chat,
          record: row.requestKey,
          field: "answer",
        },
        pad: "content",
      });
      const answer = parseAnswer(JSON.parse(new TextDecoder().decode(plaintext)));
      return answer && acpAnswerError(request, answer) === null ? answer : null;
    } catch {
      return null;
    } finally {
      seed.fill(0);
    }
  }

  /** Seal a short text to the current chat key under the given location. */
  private async sealShort(
    binding: VerifiedBinding,
    location: { table: string; field: string },
    plaintext: unknown,
  ): Promise<AcpSealedBox> {
    const key = await this.chatKey(binding);
    const box = await sealBox({
      recipientPublicKey: key.publicKey,
      plaintext: utf8(JSON.stringify(plaintext)),
      aad: {
        ...location,
        workspace: this.workspace,
        parent: binding.e2eeId,
        record: String(key.epoch),
      },
      pad: "short",
    });
    return { epoch: key.epoch, box: arrayBuffer(box) };
  }

  /** Owner-key sealing for the agent session index (Home); the title is raw UTF-8 text. */
  public async indexSealer(): Promise<IndexSealer> {
    const owner = await this.trust.ownerPublicKey();
    const seed = this.trust.encryptionSeed();
    let tagKey: Uint8Array;
    try {
      tagKey = await hkdf(seed, "radium/v1/acp-index-tag");
    } finally {
      seed.fill(0);
    }
    const tag = async (agentId: string, sessionId: string, title: string) =>
      toBase64Url(await hmacSha256(tagKey, [utf8(agentId), utf8(sessionId), utf8(title)]));
    return {
      epoch: owner.epoch,
      tag,
      seal: async (agentId, sessionId, title) => ({
        epoch: owner.epoch,
        tag: await tag(agentId, sessionId, title),
        box: arrayBuffer(
          await sealBox({
            recipientPublicKey: owner.publicKey,
            plaintext: utf8(title),
            aad: {
              table: "acp_agent_sessions",
              workspace: this.workspace,
              parent: this.trust.workerId,
              record: `${agentId}:${sessionId}`,
              field: "title",
            },
            pad: "short",
          }),
        ),
      }),
    };
  }

  /**
   * Turn a lifecycle patch into its wire form: free text becomes sealed boxes, a new `sessionId`
   * carries the Worker's proof. Text that cannot be sealed (no verified chat key) is dropped, never
   * sent in the clear.
   */
  public async patchForWire(
    chat: string,
    patch: AcpSessionPatch,
    context: PatchContext,
  ): Promise<AcpSessionPatch> {
    // Per-session config and command descriptions travel in sealed timeline frames only.
    const { title: rawTitle, error, config: _config, commands: _commands, ...rest } = patch;
    const wire: AcpSessionPatch = rest;
    // `short` padding bounds a sealed title at 500 characters.
    const title = rawTitle?.slice(0, 500);
    if (patch.sessionId) {
      wire.sessionProof = arrayBuffer(
        await this.trust.signObject({
          table: "acp_sessions",
          parent: chat,
          record: patch.sessionId,
          field: "sessionId",
          object: utf8(context.agentId),
        }),
      );
    }
    if (error === null) {
      wire.error = null;
      wire.sealedError = null;
    }
    const { binding } = context;
    if (binding && typeof error === "string") {
      const sealed = await this.sealShort(
        binding,
        { table: "acp_sessions", field: "error" },
        error.slice(0, 500),
      ).catch(() => undefined);
      if (sealed) wire.sealedError = sealed;
    }
    if (binding && title) {
      const sealed = await this.sealShort(
        binding,
        { table: "aisdk_chats", field: "title" },
        { title },
      ).catch(() => undefined);
      if (sealed) wire.sealedTitle = sealed;
    }
    const sessionId = patch.sessionId ?? context.sessionId;
    if (title && sessionId) {
      const sealer = await this.indexSealer().catch(() => undefined);
      const indexTitle = await sealer?.seal(context.agentId, sessionId, title).catch(() => undefined);
      if (indexTitle) wire.indexTitle = indexTitle;
    }
    return wire;
  }
}
