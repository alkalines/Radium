import type {
  AcpAgentDefinition,
  AcpAgentReport,
  AcpCommandKind,
  AcpCommandPayload,
  AcpConfig,
  AcpDraftConfig,
  AcpFrameInput,
  AcpInteractionAnswer,
  AcpInteractionRequest,
  AcpSessionStatus,
  AcpStopReason,
  AcpCommandInfo,
  AcpUsage,
} from "backend/src/acp/contract";

/** Durable session metadata supplied when claiming a command; IDs remain opaque locally. */
export interface AcpSessionBinding {
  agentId: string;
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

/** Claimed intent; execution must never be repeated merely because receipt delivery fails. */
export interface AcpClaim {
  command: string;
  kind: AcpCommandKind;
  payload: AcpCommandPayload;
  chat: string | null;
  by: string;
  session: AcpSessionBinding | null;
}

/** Warm-session subscription contains metadata only, never transcript content. */
export interface AcpWarmSession {
  chat: string;
  epoch: number;
  agentId: string;
  cwd: string;
  sessionId: string | null;
  status: AcpSessionStatus;
}

/** Durable decision waiting to be relayed to an agent request. */
export interface AcpAnsweredInteraction {
  _id: string;
  chat: string;
  requestKey: string;
  answer: AcpInteractionAnswer;
}

/** Lifecycle fields mirrored by Convex; null explicitly clears an error. */
export interface AcpSessionPatch {
  status?: AcpSessionStatus;
  stopReason?: AcpStopReason;
  error?: string | null;
  config?: AcpConfig;
  commands?: AcpCommandInfo[];
  usage?: AcpUsage;
  history?: "full" | "resumed" | "none";
  sessionId?: string;
  title?: string;
}

type Subscription<T> = (
  receive: (value: T) => void,
  failed: (error: unknown) => void,
) => () => void;

/** The entire authorized Convex boundary, replaceable by an in-memory transport in tests. */
export interface AcpTransport {
  agentDefinitions: Subscription<AcpAgentDefinition[]>;
  assignedCommands: Subscription<AcpAssignment[]>;
  warmSessions: Subscription<AcpWarmSession[]>;
  answeredInteractions: Subscription<AcpAnsweredInteraction[]>;
  claimCommand(args: { command: string }): Promise<AcpClaim | null>;
  finishCommand(args: {
    command: string;
    status: "done" | "failed";
    error?: string;
    result?: string;
  }): Promise<unknown>;
  openInteraction(args: {
    chat: string;
    requestKey: string;
    request: AcpInteractionRequest;
  }): Promise<string>;
  resolveInteraction(args: {
    interaction: string;
    status: "resolved" | "cancelled";
  }): Promise<unknown>;
  startEpoch(args: { chat: string; epoch: number }): Promise<{ accepted: boolean }>;
  appendFrames(args: {
    chat: string;
    epoch: number;
    frames: AcpFrameInput[];
  }): Promise<{ accepted: boolean; bytes: number }>;
  updateSession(args: { chat: string; patch: AcpSessionPatch }): Promise<unknown>;
  reportAgents(args: { agents: AcpAgentReport[] }): Promise<unknown>;
  recoverWorker(args: Record<string, never>): Promise<{ more: boolean }>;
}
