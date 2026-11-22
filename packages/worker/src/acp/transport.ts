import type {
  AcpAgentDefinition,
  AcpAgentReport,
  AcpAgentSessionEntry,
  AcpCommandKind,
  AcpCommandPayload,
  AcpConfig,
  AcpDeletedTarget,
  AcpDraftConfig,
  AcpFrameInput,
  AcpInteractionAnswer,
  AcpInteractionRequest,
  AcpSessionProof,
  AcpSessionStatus,
  AcpSignedBinding,
  AcpStopReason,
  AcpCommandInfo,
  AcpTurnReport,
  AcpTurnUsage,
  AcpUsage,
  AcpProfile,
} from "contracts/acp/contract";
import type { AcpGatewayAccess, AcpGatewayModel } from "contracts/acp/gateway";

/**
 * Keyed-workspace facts the server holds about a chat: the creator's signed binding and the
 * proof that its `sessionId` belongs to it. Everything here is untrusted until the Worker has
 * verified it (`signed.ts`); `null` for chats created before the workspace had keys.
 */
export interface AcpChatE2ee {
  e2eeId: string;
  creatorUserId: string;
  /** Untrusted rotation hint; a change only invalidates the current frame capsule. */
  keyEpoch?: number | null;
  rekey?: boolean;
  binding: AcpSignedBinding | null;
  sessionProof: AcpSessionProof | null;
}

/** Durable session metadata supplied when claiming a command; IDs remain opaque locally. */
export interface AcpSessionBinding {
  agentId: string;
  profile: AcpProfile;
  cwd: string;
  sessionId: string | null;
  status: AcpSessionStatus;
  epoch: number;
  warm: boolean;
  draft: AcpDraftConfig | null;
  config: AcpConfig | null;
}

/** Metadata-only pending assignment; payloads are obtained only by an atomic claim. */
export interface AcpAssignment {
  _id: string;
  kind: AcpCommandKind;
  chat: string | null;
  createdAt: number;
}

/**
 * Claimed intent; execution must never be repeated merely because receipt delivery fails.
 *
 * Legacy (plaintext) workspaces fill `payload`. In a keyed workspace `payload` is `null` and the
 * command exists only as `signed`: the box sealed to this Worker plus the issuer's signature. A
 * paired Worker uses nothing else (not `by`, not `payload`, not `session.draft`).
 */
export interface AcpClaim {
  command: string;
  kind: AcpCommandKind;
  clientId: string;
  payload: AcpCommandPayload | null;
  signed: { payload: ArrayBuffer; signature: ArrayBuffer; signerKeyId: string } | null;
  chat: string | null;
  by: string;
  session: (AcpSessionBinding & { e2ee: AcpChatE2ee | null }) | null;
  /** Binding snapshot of a deleted chat, for `close`/`delete` commands (which outlive it). */
  target: AcpDeletedTarget | null;
  /**
   * Fork destination recorded with a signed `fork` command (the browser creates and binds the
   * target chat first). Untrusted until `AcpSigned` verifies its binding and creator.
   */
  forkTarget: {
    chat: string;
    agentId: string;
    profile: AcpProfile;
    cwd: string;
    e2ee: AcpChatE2ee | null;
  } | null;
}

/** Warm-session subscription contains metadata only, never transcript content. */
export interface AcpWarmSession {
  chat: string;
  epoch: number;
  agentId: string;
  profile: AcpProfile;
  cwd: string;
  sessionId: string | null;
  status: AcpSessionStatus;
  e2ee: AcpChatE2ee | null;
}

/** A box sealed to chat key (or owner key) `epoch`. */
export interface AcpSealedBox {
  epoch: number;
  box: ArrayBuffer;
}

/**
 * An interaction request sealed to the chat key (AAD `acp_interactions`/e2eeId/requestKey/
 * `request`) with the Worker's signature over the same location; `kind` is the only plaintext.
 */
export interface AcpSealedRequest extends AcpSealedBox {
  kind: AcpInteractionRequest["kind"];
  signature: ArrayBuffer;
}

/** Durable decision waiting to be relayed to an agent request. */
export interface AcpAnsweredInteraction {
  _id: string;
  chat: string;
  requestKey: string;
  /** Plaintext decision of a legacy workspace; a paired Worker never uses it. */
  answer?: AcpInteractionAnswer;
  /** Answer sealed to this Worker and signed by the answering user (`acpAnswerStatement`). */
  sealed?: { answer: ArrayBuffer; signature: ArrayBuffer; signerKeyId: string };
}

/**
 * Current chat key epoch as the server stores it; the Worker verifies the signatures itself.
 * `rekey` means the chat must replace the key (a recipient was removed) before anything new is
 * sealed to it. `bindingSignature` and `bindingMembers` bind the epoch to this chat ID and
 * audience; an epoch without them (created before recipient binding) is never sealed to.
 */
export interface AcpChatKey {
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: ArrayBuffer;
  signerKeyId: string | null;
  signature: ArrayBuffer | null;
  bindingSignature: ArrayBuffer | null;
  /** Raw picked members the binding signed; null unless the epoch was bound as shared. */
  bindingMembers: string[] | null;
  rekey: boolean;
}

/** An epoch's frame capsule (to the chat key) and the Worker's signature over it. */
export interface AcpEpochCapsule {
  chatEpoch: number;
  capsule: ArrayBuffer;
  signature: ArrayBuffer;
}

/**
 * Lifecycle fields mirrored by Convex; null explicitly clears an error. `title` and a string
 * `error` are plaintext and exist only on the legacy path: a paired Worker sends `sealedTitle`,
 * `sealedError`, `indexTitle` and `sessionProof` instead (design: "Worker machine API").
 */
export interface AcpSessionPatch {
  status?: AcpSessionStatus;
  stopReason?: AcpStopReason;
  error?: string | null;
  config?: AcpConfig;
  commands?: AcpCommandInfo[];
  usage?: AcpUsage;
  turnUsage?: AcpTurnUsage;
  history?: "full" | "resumed" | "none";
  sessionId?: string;
  title?: string;
  /** Usage facts of the turn this patch ends (model, cost delta, prompt command). */
  turn?: AcpTurnReport;
  /** Title sealed to the chat key (`{title}` JSON, `aisdk_chats` title AAD). */
  sealedTitle?: AcpSealedBox;
  /** Error text sealed to the chat key; null clears the stored error. */
  sealedError?: AcpSealedBox | null;
  /** Title sealed to the workspace owner key for the Home index, with its keyed diff tag. */
  indexTitle?: AcpSealedBox & { tag: string };
  /** Worker signature binding a new `sessionId` to its chat; required with `sessionId`. */
  sessionProof?: ArrayBuffer;
}

type Subscription<T> = (
  receive: (value: T) => void,
  failed: (error: unknown) => void,
) => () => void;

/** The entire authorized Convex boundary, replaceable by an in-memory transport in tests. */
export interface AcpTransport {
  gatewayState: Subscription<{ access: AcpGatewayAccess; keyId?: string }>;
  mintGatewayKey(): Promise<{ keyId: string; key: string }>;
  gatewayModels(): Promise<AcpGatewayModel[]>;
  agentDefinitions: Subscription<AcpAgentDefinition[]>;
  assignedCommands: Subscription<AcpAssignment[]>;
  warmSessions: Subscription<AcpWarmSession[]>;
  answeredInteractions: Subscription<AcpAnsweredInteraction[]>;
  claimCommand(args: { command: string }): Promise<AcpClaim | null>;
  /** A paired Worker sends only a fixed `ACP_WORKER_ERROR_CODES` value as `error`. */
  finishCommand(args: {
    command: string;
    status: "done" | "failed";
    error?: string;
    result?: string;
  }): Promise<unknown>;
  /** Exactly one of `request` (legacy plaintext) or `sealed` (paired Worker). */
  openInteraction(args: {
    chat: string;
    requestKey: string;
    request?: AcpInteractionRequest;
    sealed?: AcpSealedRequest;
  }): Promise<string>;
  resolveInteraction(args: {
    interaction: string;
    status: "resolved" | "cancelled";
  }): Promise<unknown>;
  /** Answered → pending again, answer cleared: the Worker refused the answer it was given. */
  reopenInteraction(args: { interaction: string }): Promise<unknown>;
  /** Current chat key epoch of a chat the Worker serves; `null` when the chat has none. */
  chatKey(args: { chat: string }): Promise<AcpChatKey | null>;
  /** `capsule` is required in a keyed workspace; a retry must send identical bytes. */
  startEpoch(args: {
    chat: string;
    epoch: number;
    capsule?: AcpEpochCapsule;
  }): Promise<{ accepted: boolean }>;
  appendFrames(args: {
    chat: string;
    epoch: number;
    frames: AcpFrameInput[];
  }): Promise<{ accepted: boolean; bytes: number }>;
  updateSession(args: { chat: string; patch: AcpSessionPatch }): Promise<unknown>;
  reportAgents(args: {
    agents: AcpAgentReport[];
  }): Promise<Record<string, NonNullable<AcpAgentReport["defaults"]>>>;
  knownAgentSessions(args: { agentId: string }): Promise<AcpAgentSessionEntry[]>;
  syncAgentSessions(args: {
    agentId: string;
    upserts: AcpAgentSessionEntry[];
    removals: string[];
    start?: boolean;
    finish?: { count: number; truncated: boolean } | { error: string };
  }): Promise<unknown>;
  recoverWorker(args: Record<string, never>): Promise<{ more: boolean }>;
}
