import type {
  TelemetryAttempt,
  TelemetryBlobKind,
  TelemetryBlobMeta,
  TelemetryRequestStatus,
  TelemetrySettings,
  TelemetrySource,
  TelemetryUsage,
} from "contracts/telemetry/validators";
import { createCapsule, encodeCapsule, sealWithCapsule, utf8 } from "radium-crypto";
import { workspaceOwnerSealingKey } from "../e2ee/workspace-keys";
import type { Database } from "../drivers/types";
import type {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "../gateway/openai/types";
import { boundedMessage } from "../gateway/routing/failures";
import type { Runtime } from "../runtime";
import { readWorkspaceSettings } from "../workspaces/settings";
import { canonicalJson } from "./canonical";
import {
  assembleOutputMessage,
  decomposeRequest,
  messageMeta,
  StreamOutputAssembler,
  toolMeta,
  type OutputMessage,
} from "./decompose";
import { blobHash, nodeHash, utf8Length } from "./hash";
import {
  deepestExistingPrefix,
  existingBlobs,
  finishRequest,
  ingestBlobs,
  ingestNodes,
  type BlobInput,
  type SealedContent,
} from "./ingest";

/**
 * Capture of one Gateway request. Capture is off while the deployment has no
 * `TELEMETRY_HASH_SECRET`: `startCapture` then returns a capture whose methods do nothing and
 * whose `finish` resolves, and no row is written. Content recorded with `recordInputs` /
 * `recordOutputs` is sealed to the workspace owner key (a workspace without a key stores no
 * content); plaintext is never written. Envelopes are stored inline in `sealed_envelope`.
 */

/** Server-derived workspace attribution and settings for one captured request. */
export type TelemetryRequestContext = {
  workspace: string;
  apiKey?: string;
  chatId?: string;
  userId: string;
  /** Idempotency key: one Gateway request, not one Chatroom turn. */
  requestId: string;
  settings: TelemetrySettings;
};

/** The routing session fields capture reads. */
export type CaptureRoutingSession = {
  primary: string;
  fallback?: string;
  isSubagent: boolean;
};

export type StartCaptureOptions = {
  /** The request JSON as parsed from the wire; zod output would drop unknown fields. */
  rawBody: unknown;
  headers?: Headers;
  session?: CaptureRoutingSession;
  source: TelemetrySource;
  /** Model slug the client requested. */
  model: string;
  requestedServiceTier?: string;
  stream: boolean;
  /** Epoch milliseconds. */
  startedAt: number;
};

export type CaptureResult = {
  status: TelemetryRequestStatus;
  error?: { message: string; status?: number };
  canceled?: boolean;
};

/** The settled generation, as far as capture reads it (translator `genCallbackType` payload). */
export type CaptureGeneration = {
  genId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number | null };
    prompt_tokens_details?: {
      cached_tokens?: number | null;
      written_cache_tokens?: number | null;
      written_cache_tokens_1h?: number | null;
    };
  };
  genTime: number;
  ttft: number;
  serviceTier?: string;
  estimatedCost?: number;
  reportedCost?: number;
  upstreamInferenceCost?: number;
};

/** What capture does with one request; the inert variant is returned when capture is off. */
export interface TelemetryCapture {
  /** Record one routing attempt, in dispatch order. */
  attempt(attempt: TelemetryAttempt): void;
  /** Accumulate a streamed chunk. Call before the gateway rewrites the chunk's id. */
  outputChunk(chunk: ChatCompletions_Streaming_Chunk_Type): void;
  /** Record a complete non-streaming response. Call before the gateway rewrites its id. */
  outputResponse(response: ChatCompletions_NotStreaming_ResponseBody_Type): void;
  /** Record usage and timing when the generation settles. */
  recordGeneration(generation: CaptureGeneration): void;
  /** Link the persisted `chat_completions` row for this request. */
  recordChatCompletion(id: string | null | undefined): void;
  /**
   * Store the output and the request row. Idempotent: later calls return the first call's
   * promise. Never rejects.
   */
  finish(result: CaptureResult): Promise<void>;
}

/** Hashes per existing-blob lookup, and bounds of one blob write. */
const EXISTING_BATCH = 500;
const NODE_BATCH = 500;
const BLOB_BATCH_COUNT = 200;
const BLOB_BATCH_BYTES = 4 * 1024 * 1024;
/** Fixed row overhead plus a toolset member's size, for the byte bound of a blob batch. */
const BLOB_ROW_BYTES = 2048;
const MEMBER_BYTES = 48;

/** `workspace_settings` as capture settings; defaults (capture off) when the row does not exist. */
export async function telemetrySettingsFor(
  db: Database,
  workspace: string,
): Promise<TelemetrySettings> {
  const row = await readWorkspaceSettings(db, workspace);
  return {
    enabled: row?.telemetryEnabled ?? false,
    recordInputs: row?.telemetryRecordInputs ?? false,
    recordOutputs: row?.telemetryRecordOutputs ?? false,
    retentionDays: row?.telemetryRetentionDays ?? undefined,
  };
}

/**
 * Begin capturing one Gateway request. Hashing and ingesting the inputs starts immediately and
 * runs alongside routing; `finish` waits for it. Every failure is logged (error name and
 * database code only, never content) and swallowed, so capture can never fail or alter the
 * request path.
 */
export function startCapture(
  runtime: Runtime,
  context: TelemetryRequestContext,
  options: StartCaptureOptions,
): TelemetryCapture {
  const secret = runtime.config.TELEMETRY_HASH_SECRET;
  return secret === undefined
    ? inertCapture
    : new ActiveCapture(runtime.drivers.db, secret, context, options);
}

const inertCapture: TelemetryCapture = {
  attempt() {},
  outputChunk() {},
  outputResponse() {},
  recordGeneration() {},
  recordChatCompletion() {},
  finish: () => Promise.resolve(),
};

type PreparedBlob = {
  hash: string;
  kind: TelemetryBlobKind;
  /** UTF-8 bytes of the canonical JSON. */
  size: number;
  /** Canonical JSON to store; absent when content recording is off for this blob. */
  canonical?: string;
  meta?: TelemetryBlobMeta;
  /** Tool blob ids of a toolset, resolved once the tools are stored. */
  members?: string[];
};

type IngestedInputs = {
  /** Last client message node; absent when the request had no conversation messages. */
  input?: string;
  inputHash?: string;
  /** Deepest node that existed before this request stored its own. */
  prefix?: string;
  /** The first stored input node diverged from history that already continued past `prefix`. */
  forked: boolean;
  system?: string;
  toolset?: string;
  params?: string;
  headers?: string;
};

type Sealing = {
  epoch: number;
  capsule: Uint8Array;
  capsuleId: Uint8Array;
  key: Uint8Array;
};

function logFailure(stage: string, error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = [error, cause]
    .map((candidate) => (candidate as { code?: unknown } | undefined)?.code)
    .find((candidate) => typeof candidate === "string");
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(boundedMessage(`Telemetry ${stage} failed: ${name}${code ? ` (${code})` : ""}`));
}

class ActiveCapture implements TelemetryCapture {
  private readonly attempts: TelemetryAttempt[] = [];
  private readonly streamOutput = new StreamOutputAssembler();
  private responseOutput: { message?: OutputMessage; id?: string; finishReason?: string } | undefined;
  private generation:
    | {
        usage: TelemetryUsage;
        ttftMs: number;
        generationMs: number;
        providerId?: string;
        servedServiceTier?: string;
        estimatedCost?: number;
        reportedCost?: number;
        upstreamInferenceCost?: number;
      }
    | undefined;
  private chatCompletion: string | undefined;
  private readonly sealing: Promise<Sealing | null>;
  private readonly inputs: Promise<IngestedInputs | undefined>;
  private finishing: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    private readonly secret: string,
    private readonly context: TelemetryRequestContext,
    private readonly options: StartCaptureOptions,
  ) {
    this.sealing = this.createSealing().catch((error) => {
      logFailure("sealing", error);
      return null;
    });
    this.inputs = this.ingestInputs().catch((error) => {
      logFailure("input capture", error);
      return undefined;
    });
  }

  attempt(attempt: TelemetryAttempt) {
    this.attempts.push(attempt);
  }

  outputChunk(chunk: ChatCompletions_Streaming_Chunk_Type) {
    try {
      this.streamOutput.push(chunk);
    } catch (error) {
      logFailure("output capture", error);
    }
  }

  outputResponse(response: ChatCompletions_NotStreaming_ResponseBody_Type) {
    try {
      this.responseOutput = {
        message: assembleOutputMessage(response),
        id: response.id || undefined,
        finishReason: response.choices?.[0]?.finish_reason ?? undefined,
      };
    } catch (error) {
      logFailure("output capture", error);
    }
  }

  recordGeneration(generation: CaptureGeneration) {
    const usage = generation.usage;
    this.generation = {
      usage: {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) : undefined,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? undefined,
        cacheWriteTokens: usage?.prompt_tokens_details?.written_cache_tokens ?? undefined,
        cacheWrite1hTokens: usage?.prompt_tokens_details?.written_cache_tokens_1h ?? undefined,
      },
      ttftMs: generation.ttft,
      generationMs: generation.genTime,
      providerId: generation.genId,
      servedServiceTier: generation.serviceTier,
      estimatedCost: generation.estimatedCost,
      reportedCost: generation.reportedCost,
      upstreamInferenceCost: generation.upstreamInferenceCost,
    };
  }

  recordChatCompletion(id: string | null | undefined) {
    if (id) this.chatCompletion = id;
  }

  finish(result: CaptureResult): Promise<void> {
    this.finishing ??= this.finishRequest(result)
      .catch((error) => logFailure("request capture", error))
      .finally(async () => {
        (await this.sealing)?.key.fill(0);
      });
    return this.finishing;
  }

  private async createSealing(): Promise<Sealing | null> {
    const { workspace, requestId } = this.context;
    const target = await workspaceOwnerSealingKey(this.db, workspace);
    if (!target) return null;
    const { capsule, capsuleKey } = await createCapsule({
      recipientPublicKey: target.publicKey,
      aad: {
        table: "telemetry_capsules",
        workspace,
        parent: requestId,
        record: requestId,
        field: "capsule",
      },
    });
    return {
      epoch: target.epoch,
      capsule: encodeCapsule(capsule),
      capsuleId: capsule.capsuleId,
      key: capsuleKey,
    };
  }

  private async seal(
    table: string,
    record: string,
    field: string,
    value: unknown,
  ): Promise<SealedContent | undefined> {
    const sealing = await this.sealing;
    if (!sealing) return undefined;
    const { workspace, requestId } = this.context;
    const envelope = await sealWithCapsule({
      capsuleKey: sealing.key,
      capsuleId: sealing.capsuleId,
      plaintext: utf8(JSON.stringify(value)),
      pad: "content",
      aad: { table, workspace, parent: requestId, record, field },
    });
    return { epoch: sealing.epoch, requestId, capsule: sealing.capsule, envelope };
  }

  /**
   * Canonicalize and fingerprint a value. The hash always covers the full content; the content
   * itself is kept only when `store` is set.
   */
  private async prepareBlob(
    kind: TelemetryBlobKind,
    value: unknown,
    store: boolean,
    meta?: TelemetryBlobMeta,
  ): Promise<PreparedBlob> {
    const canonical = canonicalJson(value);
    return {
      hash: await blobHash(this.secret, this.context.workspace, kind, canonical),
      kind,
      size: utf8Length(canonical),
      canonical: store ? canonical : undefined,
      meta,
    };
  }

  private async ingestInputs(): Promise<IngestedInputs> {
    const { workspace, settings } = this.context;
    const parts = decomposeRequest(this.options.rawBody, this.options.headers);
    const recordContent = settings.recordInputs;

    const [system, params, headers, tools, messages] = await Promise.all([
      parts.system.length > 0
        ? this.prepareBlob("system", parts.system, recordContent)
        : undefined,
      this.prepareBlob("params", parts.params, recordContent),
      Object.keys(parts.headers).length > 0
        ? this.prepareBlob("headers", parts.headers, recordContent)
        : undefined,
      Promise.all(
        parts.tools.map((tool) => this.prepareBlob("tool", tool, recordContent, toolMeta(tool))),
      ),
      Promise.all(
        parts.chain.map((message) =>
          this.prepareBlob("message", message, recordContent, messageMeta(message)),
        ),
      ),
    ]);

    // A toolset is only the ordered tool hashes, so it carries no prompt content.
    const toolset =
      tools.length > 0
        ? await this.prepareBlob(
            "toolset",
            tools.map((tool) => tool.hash),
            true,
          )
        : undefined;

    const nodeHashes: string[] = [];
    let parentHash: string | undefined;
    for (const message of messages) {
      parentHash = await nodeHash(this.secret, workspace, parentHash, message.hash);
      nodeHashes.push(parentHash);
    }

    const prefix =
      nodeHashes.length > 0
        ? await deepestExistingPrefix(this.db, workspace, nodeHashes)
        : { depth: 0, node: undefined };

    // A previously redacted prefix may now be recordable; upgrade its blobs in place.
    const ids = new Map<string, string>();
    const messagesToStore = recordContent ? messages : messages.slice(prefix.depth);
    await this.upsertBlobs(
      [...tools, system, params, headers, ...messagesToStore].filter((blob) => blob !== undefined),
      ids,
    );
    if (toolset) {
      await this.upsertBlobs(
        [{ ...toolset, members: tools.map((tool) => requireId(ids, tool.hash)) }],
        ids,
      );
    }

    let input = prefix.node;
    let forked = false;
    for (let start = prefix.depth; start < messages.length; start += NODE_BATCH) {
      const end = Math.min(start + NODE_BATCH, messages.length);
      const run = await ingestNodes(this.db, workspace, {
        parentHash: start > 0 ? nodeHashes[start - 1] : undefined,
        nodes: messages.slice(start, end).map((message, offset) => ({
          hash: nodeHashes[start + offset]!,
          blob: requireId(ids, message.hash),
          origin: "input" as const,
        })),
      });
      input = run.node;
      if (start === prefix.depth) forked = run.forked;
    }

    return {
      input,
      inputHash: nodeHashes.at(-1),
      prefix: prefix.node,
      forked,
      system: system && requireId(ids, system.hash),
      toolset: toolset && requireId(ids, toolset.hash),
      params: requireId(ids, params.hash),
      headers: headers && requireId(ids, headers.hash),
    };
  }

  /** Store blobs that are new, or whose content was not recorded before and is now. */
  private async upsertBlobs(blobs: PreparedBlob[], ids: Map<string, string>) {
    const { workspace } = this.context;
    const unique = [...new Map(blobs.map((blob) => [blob.hash, blob])).values()].filter(
      (blob) => !ids.has(blob.hash),
    );

    const existing = new Map<string, { id: string; recorded: boolean }>();
    for (let start = 0; start < unique.length; start += EXISTING_BATCH) {
      const hashes = unique.slice(start, start + EXISTING_BATCH).map((blob) => blob.hash);
      for (const blob of await existingBlobs(this.db, workspace, hashes)) {
        existing.set(blob.hash, blob);
      }
    }

    const pending: PreparedBlob[] = [];
    for (const blob of unique) {
      const stored = existing.get(blob.hash);
      if (stored) ids.set(blob.hash, stored.id);
      // Content can only upgrade a blob that was stored redacted.
      if (!stored || (!stored.recorded && blob.canonical !== undefined)) pending.push(blob);
    }

    let batch: BlobInput[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      for (const blob of await ingestBlobs(this.db, workspace, batch)) ids.set(blob.hash, blob.id);
      batch = [];
      batchBytes = 0;
    };

    for (const blob of pending) {
      const sealed =
        blob.canonical !== undefined
          ? await this.seal("telemetry_blobs", blob.hash, "content", {
              content: blob.canonical,
              meta: blob.meta,
            })
          : undefined;
      const cost =
        (sealed?.envelope.byteLength ?? 0) + BLOB_ROW_BYTES + (blob.members?.length ?? 0) * MEMBER_BYTES;
      if (
        batch.length > 0 &&
        (batch.length >= BLOB_BATCH_COUNT || batchBytes + cost > BLOB_BATCH_BYTES)
      ) {
        await flush();
      }
      batch.push({ hash: blob.hash, kind: blob.kind, size: blob.size, sealed, members: blob.members });
      batchBytes += cost;
    }
    await flush();
  }

  /** Store the model's answer as a child of the input leaf. Absent when nothing was produced. */
  private async ingestOutput(inputs: IngestedInputs): Promise<string | undefined> {
    const { workspace, settings } = this.context;
    const message = this.responseOutput ? this.responseOutput.message : this.streamOutput.message();
    if (!message) return undefined;

    const blob = await this.prepareBlob("message", message, settings.recordOutputs, messageMeta(message));
    const ids = new Map<string, string>();
    await this.upsertBlobs([blob], ids);

    const run = await ingestNodes(this.db, workspace, {
      parentHash: inputs.inputHash,
      nodes: [
        {
          hash: await nodeHash(this.secret, workspace, inputs.inputHash, blob.hash),
          blob: requireId(ids, blob.hash),
          origin: "output" as const,
        },
      ],
    });
    return run.node;
  }

  private async finishRequest(result: CaptureResult) {
    const { settings } = this.context;
    const endedAt = Date.now();
    const inputs = await this.inputs;
    if (!inputs) return;

    let output: string | undefined;
    try {
      output = await this.ingestOutput(inputs);
    } catch (error) {
      logFailure("output capture", error);
    }

    const finalAttempt = this.attempts.at(-1);
    const sealedError =
      settings.recordInputs || settings.recordOutputs
        ? await this.seal("telemetry_requests", this.context.requestId, "error", {
            error: result.error && {
              message: boundedMessage(result.error.message),
              status: result.error.status,
            },
            attempts: this.attempts.map((attempt) => attempt.message ?? null),
          })
        : undefined;

    await finishRequest(this.db, {
      workspace: this.context.workspace,
      requestId: this.context.requestId,
      source: this.options.source,
      apiKey: this.context.apiKey,
      userId: this.context.userId,
      chatId: this.context.chatId,
      session: sessionIdentity(this.options.session),
      model: this.options.model,
      provider: finalAttempt?.provider,
      credential: finalAttempt?.credential,
      stream: this.options.stream,
      status: result.status,
      startedAt: this.options.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.options.startedAt),
      ttftMs: this.generation?.ttftMs,
      generationMs: this.generation?.generationMs,
      finishReason: this.streamOutput.finishReason ?? this.responseOutput?.finishReason,
      usage: this.generation?.usage,
      requestedServiceTier: this.options.requestedServiceTier,
      servedServiceTier: this.generation?.servedServiceTier,
      estimatedCost: this.generation?.estimatedCost,
      reportedCost: this.generation?.reportedCost,
      upstreamInferenceCost: this.generation?.upstreamInferenceCost,
      providerGenerationId:
        this.generation?.providerId ?? this.streamOutput.providerId ?? this.responseOutput?.id,
      chatCompletion: this.chatCompletion,
      sealedError,
      canceled: result.canceled,
      attempts: this.attempts,
      input: inputs.input,
      output,
      prefix: inputs.prefix,
      forked: inputs.forked,
      system: inputs.system,
      toolset: inputs.toolset,
      params: inputs.params,
      headers: inputs.headers,
      recordsInputs: settings.recordInputs,
      recordsOutputs: settings.recordOutputs,
    });
  }
}

function requireId(ids: Map<string, string>, hash: string) {
  const id = ids.get(hash);
  if (!id) throw new Error("Telemetry blob was not stored.");
  return id;
}

/**
 * Session key and parent for the telemetry session. A message-hash session changes its key
 * once the first reply exists, so the stable first-turn key is used instead.
 */
function sessionIdentity(session: CaptureRoutingSession | undefined) {
  if (!session) return undefined;
  const key = session.primary.startsWith("msg:")
    ? (session.fallback ?? session.primary)
    : session.primary;
  return { key, parentKey: session.isSubagent ? session.fallback : undefined };
}
