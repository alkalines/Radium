import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ActionCtx } from "../../convex/_generated/server";
import { createCapsule, encodeCapsule, sealWithCapsule, utf8 } from "radium-crypto";
import { toArrayBuffer } from "contracts/e2ee/contract";
import { boundedMessage } from "@/routing/failures";
import { deliverFromMemory } from "../../convex/observability/telemetryExport";
import type { RoutingSession } from "@/routing/session";
import type { genCallbackType } from "@/translators/openai";
import type {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
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
import { INLINE_BLOB_LIMIT } from "./store";
import type {
  TelemetryAttempt,
  TelemetryBlobKind,
  TelemetryBlobMeta,
  TelemetryRequestStatus,
  TelemetrySettings,
  TelemetrySource,
  TelemetryUsage,
} from "contracts/telemetry/validators";

/** Server-derived workspace attribution and settings for one captured request. */
export type TelemetryRequestContext = {
  workspace: Id<"workspaces">;
  apiKey?: Id<"api_keys">;
  chatId?: Id<"aisdk_chats">;
  userId: string;
  /** Idempotency key: one Gateway request, not one Chatroom turn. */
  requestId: string;
  settings: TelemetrySettings;
};

export type StartCaptureOptions = {
  /** The request JSON as parsed from the wire; zod output would drop unknown fields. */
  rawBody: unknown;
  headers?: Headers;
  session?: RoutingSession;
  source: TelemetrySource;
  /** Model slug the client requested. */
  model: string;
  requestedServiceTier?: string;
  stream: boolean;
  startedAt: number;
};

export type CaptureResult = {
  status: TelemetryRequestStatus;
  error?: { message: string; status?: number };
  canceled?: boolean;
};

// Per-call bounds that keep every mutation under Convex's argument, write, and read limits.
const NODE_BATCH = 500;
const BLOB_BATCH_COUNT = 200;
const BLOB_BATCH_BYTES = 4 * 1024 * 1024;
const EXISTING_BATCH = 100;
/**
 * Longest the response path waits for content export after the request row is written. Each
 * destination may take up to its own delivery timeout; a slower one keeps sending only while the
 * action is still alive, so its content may be lost (export is best-effort, never replayed).
 */
const CONTENT_EXPORT_WAIT_MS = 1_000;

type PreparedBlob = {
  hash: string;
  kind: TelemetryBlobKind;
  /** UTF-8 bytes of the canonical JSON. */
  size: number;
  /** Canonical JSON to store; absent when content recording is off for this blob. */
  canonical?: string;
  meta?: TelemetryBlobMeta;
  /** Tool blob IDs of a toolset, resolved once the tools are stored. */
  members?: Id<"telemetry_blobs">[];
};

type IngestedInputs = {
  /** Last client message node; absent when the request had no conversation messages. */
  input?: Id<"telemetry_nodes">;
  inputHash?: string;
  /** Deepest node that existed before this request stored its own. */
  prefix?: Id<"telemetry_nodes">;
  /** The first stored input node diverged from history that already continued past `prefix`. */
  forked: boolean;
  system?: Id<"telemetry_blobs">;
  toolset?: Id<"telemetry_blobs">;
  params?: Id<"telemetry_blobs">;
  headers?: Id<"telemetry_blobs">;
};

/**
 * Begin capturing one Gateway request. Hashing and ingesting the inputs starts immediately and
 * runs alongside routing; `finish` waits for it. Every failure is logged and swallowed, so
 * capture can never fail or alter the request path.
 */
export function startCapture(
  ctx: ActionCtx,
  context: TelemetryRequestContext,
  options: StartCaptureOptions,
): TelemetryCapture {
  return new TelemetryCapture(ctx, context, options);
}

export class TelemetryCapture {
  private readonly attempts: TelemetryAttempt[] = [];
  private readonly streamOutput = new StreamOutputAssembler();
  private responseOutput:
    | { message?: OutputMessage; id?: string; finishReason?: string }
    | undefined;
  private generation:
    | {
        usage?: TelemetryUsage;
        ttftMs: number;
        generationMs: number;
        providerId?: string;
        servedServiceTier?: string;
        estimatedCost?: number;
        reportedCost?: number;
        upstreamInferenceCost?: number;
      }
    | undefined;
  private chatCompletion: Id<"chat_completions"> | undefined;
  private readonly inputs: Promise<IngestedInputs | undefined>;
  private readonly sealing: Promise<{
    epoch: number;
    capsule: ArrayBuffer;
    capsuleId: Uint8Array;
    key: Uint8Array;
  } | null>;
  private finishing: Promise<void> | undefined;

  constructor(
    private readonly ctx: ActionCtx,
    private readonly context: TelemetryRequestContext,
    private readonly options: StartCaptureOptions,
  ) {
    this.sealing = this.createSealing().catch(() => null);
    this.inputs = this.ingestInputs().catch(() => {
      console.error("Telemetry input capture failed");
      return undefined;
    });
  }

  /** Record one routing attempt, in dispatch order. */
  attempt(attempt: TelemetryAttempt) {
    this.attempts.push(attempt);
  }

  /** Accumulate a streamed chunk. Call before the gateway rewrites the chunk's ID. */
  outputChunk(chunk: ChatCompletions_Streaming_Chunk_Type) {
    try {
      this.streamOutput.push(chunk);
    } catch {
      console.error("Telemetry output capture failed");
    }
  }

  /** Record a complete non-streaming response. Call before the gateway rewrites its ID. */
  outputResponse(response: ChatCompletions_NotStreaming_ResponseBody_Type) {
    try {
      this.responseOutput = {
        message: assembleOutputMessage(response),
        id: response.id || undefined,
        finishReason: response.choices?.[0]?.finish_reason ?? undefined,
      };
    } catch {
      console.error("Telemetry output capture failed");
    }
  }

  /** Record usage and timing when the generation settles. */
  recordGeneration(generation: Parameters<genCallbackType>[0]) {
    const usage = generation.usage;
    this.generation = {
      usage: {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage
          ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
          : undefined,
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

  /** Link the persisted `chat_completions` row for this request. */
  recordChatCompletion(id: Id<"chat_completions"> | null | undefined) {
    if (id) this.chatCompletion = id;
  }

  /**
   * Store the output and the request row. Idempotent: later calls return the first call's
   * promise. Never rejects.
   */
  finish(result: CaptureResult): Promise<void> {
    this.finishing ??= this.finishRequest(result).catch(() => {
      console.error("Telemetry request capture failed");
    }).finally(async () => {
      (await this.sealing)?.key.fill(0);
    });
    return this.finishing;
  }

  private async createSealing() {
    const target = await this.ctx.runQuery(internal.observability.telemetryIngest.ownerKey, {
      workspace: this.context.workspace,
    });
    if (!target) return null;
    const { capsule, capsuleKey } = await createCapsule({
      recipientPublicKey: new Uint8Array(target.publicKey),
      aad: {
        table: "telemetry_capsules", workspace: this.context.workspace,
        parent: this.context.requestId, record: this.context.requestId, field: "capsule",
      },
    });
    return { epoch: target.epoch, capsule: toArrayBuffer(encodeCapsule(capsule)), capsuleId: capsule.capsuleId, key: capsuleKey };
  }

  private async seal(table: string, record: string, field: string, value: unknown) {
    const sealing = await this.sealing;
    if (!sealing) return undefined;
    const envelope = await sealWithCapsule({
      capsuleKey: sealing.key,
      capsuleId: sealing.capsuleId,
      plaintext: utf8(JSON.stringify(value)),
      pad: "content",
      aad: { table, workspace: this.context.workspace, parent: this.context.requestId, record, field },
    });
    return { epoch: sealing.epoch, requestId: this.context.requestId, capsule: sealing.capsule, envelope: toArrayBuffer(envelope) };
  }

  private async ingestInputs(): Promise<IngestedInputs> {
    const { workspace, settings } = this.context;
    const parts = decomposeRequest(this.options.rawBody, this.options.headers);
    const recordContent = settings.recordInputs;

    const [system, params, headers, tools, messages] = await Promise.all([
      parts.system.length > 0
        ? prepareBlob(workspace, "system", parts.system, recordContent)
        : undefined,
      prepareBlob(workspace, "params", parts.params, recordContent),
      Object.keys(parts.headers).length > 0
        ? prepareBlob(workspace, "headers", parts.headers, recordContent)
        : undefined,
      Promise.all(
        parts.tools.map((tool) =>
          prepareBlob(workspace, "tool", tool, recordContent, toolMeta(tool)),
        ),
      ),
      Promise.all(
        parts.chain.map((message) =>
          prepareBlob(workspace, "message", message, recordContent, messageMeta(message)),
        ),
      ),
    ]);

    // A toolset is only the ordered tool hashes, so it carries no prompt content.
    const toolset =
      tools.length > 0
        ? await prepareBlob(
            workspace,
            "toolset",
            tools.map((tool) => tool.hash),
            true,
          )
        : undefined;

    const nodeHashes: string[] = [];
    let parentHash: string | undefined;
    for (const message of messages) {
      parentHash = await nodeHash(workspace, parentHash, message.hash);
      nodeHashes.push(parentHash);
    }

    const prefix =
      nodeHashes.length > 0
        ? await this.ctx.runQuery(internal.observability.telemetryIngest.deepestExistingPrefix, {
            workspace,
            hashes: nodeHashes,
          })
        : { depth: 0, node: undefined };

    // A previously redacted prefix may now be recordable; upgrade its blobs in place.
    const ids = new Map<string, Id<"telemetry_blobs">>();
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
      const run = await this.ctx.runMutation(internal.observability.telemetryIngest.ingestNodes, {
        workspace,
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

  /**
   * Store blobs that are new, or whose content was not recorded before and is now. Content
   * above the inline limit is uploaded to file storage first; the mutation deletes the upload
   * if the blob turned out to exist already.
   */
  private async upsertBlobs(blobs: PreparedBlob[], ids: Map<string, Id<"telemetry_blobs">>) {
    const { workspace } = this.context;
    const unique = [...new Map(blobs.map((blob) => [blob.hash, blob])).values()].filter(
      (blob) => !ids.has(blob.hash),
    );

    const existing = new Map<string, { id: Id<"telemetry_blobs">; recorded: boolean }>();
    for (let start = 0; start < unique.length; start += EXISTING_BATCH) {
      const found = await this.ctx.runQuery(internal.observability.telemetryIngest.existingBlobs, {
        workspace,
        hashes: unique.slice(start, start + EXISTING_BATCH).map((blob) => blob.hash),
      });
      for (const blob of found) existing.set(blob.hash, blob);
    }

    const pending: PreparedBlob[] = [];
    for (const blob of unique) {
      const stored = existing.get(blob.hash);
      if (stored) ids.set(blob.hash, stored.id);
      // Content can only upgrade a blob that was stored redacted.
      if (!stored || (!stored.recorded && blob.canonical !== undefined)) pending.push(blob);
    }

    let batch: Array<{
      hash: string;
      kind: TelemetryBlobKind;
      size: number;
      sealed?: { epoch: number; requestId: string; capsule: ArrayBuffer; envelope?: ArrayBuffer };
      storage?: Id<"_storage">;
      members?: Id<"telemetry_blobs">[];
    }> = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const stored = await this.ctx.runMutation(
        internal.observability.telemetryIngest.ingestBlobs,
        { workspace, blobs: batch },
      );
      for (const blob of stored) ids.set(blob.hash, blob.id);
      batch = [];
      batchBytes = 0;
    };

    for (const blob of pending) {
      let sealed: (typeof batch)[number]["sealed"] = blob.canonical !== undefined
        ? await this.seal("telemetry_blobs", blob.hash, "content", { content: blob.canonical, meta: blob.meta })
        : undefined;
      let storage: Id<"_storage"> | undefined;
      if (sealed?.envelope && sealed.envelope.byteLength > INLINE_BLOB_LIMIT) {
        storage = await this.ctx.storage.store(new Blob([sealed.envelope], { type: "application/octet-stream" }));
        sealed = { ...sealed, envelope: undefined };
      }

      const cost = (sealed?.envelope?.byteLength ?? 0) + 2048 + (blob.members?.length ?? 0) * 48;
      if (
        batch.length > 0 &&
        (batch.length >= BLOB_BATCH_COUNT || batchBytes + cost > BLOB_BATCH_BYTES)
      ) {
        await flush();
      }
      batch.push({
        hash: blob.hash,
        kind: blob.kind,
        size: blob.size,
        sealed,
        storage,
        members: blob.members,
      });
      batchBytes += cost;
    }
    await flush();
  }

  /** Store the model's answer as a child of the input leaf. Absent when nothing was produced. */
  private async ingestOutput(inputs: IngestedInputs): Promise<Id<"telemetry_nodes"> | undefined> {
    const { workspace, settings } = this.context;
    const message = this.responseOutput ? this.responseOutput.message : this.streamOutput.message();
    if (!message) return undefined;

    const blob = await prepareBlob(
      workspace,
      "message",
      message,
      settings.recordOutputs,
      messageMeta(message),
    );
    const ids = new Map<string, Id<"telemetry_blobs">>();
    await this.upsertBlobs([blob], ids);

    const run = await this.ctx.runMutation(internal.observability.telemetryIngest.ingestNodes, {
      workspace,
      parentHash: inputs.inputHash,
      nodes: [
        {
          hash: await nodeHash(workspace, inputs.inputHash, blob.hash),
          blob: requireId(ids, blob.hash),
          origin: "output" as const,
        },
      ],
    });
    return run.node;
  }

  private async finishRequest(result: CaptureResult) {
    const { workspace, settings } = this.context;
    const endedAt = Date.now();
    const inputs = await this.inputs;
    if (!inputs) return;

    let output: Id<"telemetry_nodes"> | undefined;
    if (inputs) {
      try {
        output = await this.ingestOutput(inputs);
      } catch {
        console.error("Telemetry output capture failed");
      }
    }

    const finalAttempt = this.attempts.at(-1);
    const sealedError = settings.recordInputs || settings.recordOutputs
      ? await this.seal("telemetry_requests", this.context.requestId, "error", {
          error: result.error && { message: boundedMessage(result.error.message), status: result.error.status },
          attempts: this.attempts.map((attempt) => attempt.message ?? null),
        })
      : undefined;
    const request = await this.ctx.runMutation(internal.observability.telemetryIngest.finishRequest, {
      workspace,
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
      attempts: this.attempts.map(({ message: _message, ...attempt }) => attempt),
      input: inputs?.input,
      output,
      prefix: inputs?.prefix,
      forked: inputs?.forked,
      system: inputs?.system,
      toolset: inputs?.toolset,
      params: inputs?.params,
      headers: inputs?.headers,
      recordsInputs: settings.recordInputs,
      recordsOutputs: settings.recordOutputs,
    });
    const parts = decomposeRequest(this.options.rawBody, this.options.headers);
    const delivery = deliverFromMemory(this.ctx, request, {
      parts,
      output: this.responseOutput ? this.responseOutput.message : this.streamOutput.message(),
      error: result.error,
      attempts: this.attempts,
      recordInputs: settings.recordInputs,
      recordOutputs: settings.recordOutputs,
    }).catch(() => {
      console.error("Telemetry export failed");
    });
    // Destinations must not hold the client's response or stream close for their full timeout.
    const waited = Promise.withResolvers<void>();
    const timer = setTimeout(waited.resolve, CONTENT_EXPORT_WAIT_MS);
    await Promise.race([delivery, waited.promise]);
    clearTimeout(timer);
  }
}

/**
 * Canonicalize and fingerprint a value. The hash always covers the full content; the content
 * itself is kept only when `store` is set.
 */
async function prepareBlob(
  workspace: Id<"workspaces">,
  kind: TelemetryBlobKind,
  value: unknown,
  store: boolean,
  meta?: TelemetryBlobMeta,
): Promise<PreparedBlob> {
  const canonical = canonicalJson(value);
  return {
    hash: await blobHash(workspace, kind, canonical),
    kind,
    size: utf8Length(canonical),
    canonical: store ? canonical : undefined,
    meta,
  };
}

function requireId(ids: Map<string, Id<"telemetry_blobs">>, hash: string) {
  const id = ids.get(hash);
  if (!id) throw new Error("Telemetry blob was not stored.");
  return id;
}

/**
 * Session key and parent for the telemetry session. A message-hash session changes its key
 * once the first reply exists, so the stable first-turn key is used instead.
 */
function sessionIdentity(session: RoutingSession | undefined) {
  if (!session) return undefined;
  const key = session.primary.startsWith("msg:")
    ? (session.fallback ?? session.primary)
    : session.primary;
  return { key, parentKey: session.isSubagent ? session.fallback : undefined };
}
