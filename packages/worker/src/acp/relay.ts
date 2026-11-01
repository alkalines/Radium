import {
  ACP_EPOCH_ROLLOVER_BYTES,
  ACP_FRAME_BYTES,
  ACP_FRAMES_PER_APPEND,
  utf8Bytes,
  type AcpFrameInput,
  type AcpFrameKind,
  type AcpOp,
} from "backend/src/acp/contract";
import type { AcpTimeline } from "./timeline";
import type { AcpTransport } from "./transport";

type Queued = { kind: AcpFrameKind; op: AcpOp; bytes: number };
const RESTART_CODES: Record<string, true> = {
  ACP_FRAME_CONFLICT: true,
  ACP_FRAME_GAP: true,
  ACP_STALE_EPOCH: true,
};

/** Optional clock policy overrides; production defaults implement the ACP relay timing/budgets. */
export interface AcpRelayOptions {
  textFlushMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  random?: () => number;
  outageBytes?: number;
  rolloverBytes?: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = "data" in error ? error.data : undefined;
  if (typeof data === "object" && data !== null && "code" in data) return String(data.code);
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return typeof parsed === "object" && parsed !== null && "code" in parsed
        ? String(parsed.code)
        : undefined;
    } catch {
      return data;
    }
  }
  if ("code" in error) return String(error.code);
  return undefined;
}

/** Ordered warm-only frame writer; uncertain appends retry identical ranges before any later write. */
export class AcpRelay {
  /** Current (or currently opening) epoch; increases on warm-up, repair and rollover. */
  public epoch = 0;
  private readonly options: Required<AcpRelayOptions>;
  private streaming = false;
  private generation = 0;
  private nextSeq = 0;
  private bytes = 0;
  private queuedBytes = 0;
  private inFlightBytes = 0;
  private queue: Queued[] = [];
  private opening = false;
  private restart = false;
  private ready = false;
  private fragment = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeRetry: (() => void) | undefined;
  private draining: Promise<void> | undefined;

  /** Bind one chat to its local timeline; this class never mutates lifecycle metadata. */
  public constructor(
    private readonly transport: Pick<AcpTransport, "startEpoch" | "appendFrames">,
    private readonly chat: string,
    private readonly timeline: AcpTimeline,
    options: AcpRelayOptions = {},
  ) {
    this.options = {
      textFlushMs: 300,
      retryMinMs: 500,
      retryMaxMs: 10_000,
      random: Math.random,
      outageBytes: 1024 * 1024,
      rolloverBytes: ACP_EPOCH_ROLLOVER_BYTES,
      ...options,
    };
  }

  /** Whether this relay is warm and has not been stopped or rejected as cold. */
  public get active(): boolean {
    return this.streaming;
  }

  /** Open above both remembered epochs and publish the initial snapshot before resolving. */
  public async start(previousEpoch: number): Promise<void> {
    this.stop();
    const generation = this.generation;
    const previous = this.draining;
    if (previous) await previous;
    if (this.generation !== generation) return;
    this.streaming = true;
    this.epoch = Math.max(previousEpoch, this.epoch) + 1;
    this.opening = true;
    this.nextSeq = 0;
    this.bytes = 0;
    this.inFlightBytes = 0;
    this.enqueue(this.timeline.snapshot(), "snapshot");
    await this.flush();
  }

  /** Queue normalized ops; text waits for the flush interval, structural updates flush immediately. */
  public push(ops: AcpOp[], kind: AcpFrameKind = "live"): void {
    if (!this.streaming || ops.length === 0) return;
    this.enqueue(ops, kind);
    if (this.queuedBytes + this.inFlightBytes > this.options.outageBytes) {
      this.queue = [];
      this.queuedBytes = 0;
      this.restart = true;
    }
    const immediate = kind !== "live" || ops.some((op) => op.op !== "text.append");
    if (immediate || this.queuedBytes >= ACP_FRAME_BYTES || this.restart) {
      this.ready = true;
      this.clearTextTimer();
      this.kick();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.ready = true;
        this.kick();
      }, this.options.textFlushMs);
    }
  }

  /** Wait until all currently buffered writes are acknowledged (including retries and repair). */
  public async flush(): Promise<void> {
    this.clearTextTimer();
    this.ready = true;
    this.kick();
    while (this.draining) await this.draining;
  }

  /** Stop immediately on cold/deleted chats; pending content is recovered by the next snapshot. */
  public stop(): void {
    this.streaming = false;
    this.generation++;
    this.queue = [];
    this.queuedBytes = 0;
    this.restart = false;
    this.opening = false;
    this.clearTextTimer();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.wakeRetry?.();
    this.wakeRetry = undefined;
  }

  /** Drain acknowledged content before stopping; unlike stop, waits through a transient outage. */
  public async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.stop();
    }
  }

  private enqueue(ops: AcpOp[], kind: AcpFrameKind): void {
    for (const op of ops) {
      const last = this.queue.at(-1);
      if (
        last?.kind === kind &&
        last.op.op === "text.append" &&
        op.op === "text.append" &&
        last.op.id === op.id &&
        last.bytes + utf8Bytes(op.text) < ACP_FRAME_BYTES
      ) {
        this.queuedBytes -= last.bytes;
        last.op = { ...last.op, text: last.op.text + op.text };
        last.bytes = utf8Bytes(JSON.stringify(last.op));
        this.queuedBytes += last.bytes;
      } else {
        const bytes = utf8Bytes(JSON.stringify(op));
        this.queue.push({ kind, op, bytes });
        this.queuedBytes += bytes;
      }
    }
  }

  private kick(): void {
    if (!this.streaming || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.streaming && this.ready && (this.queue.length || this.opening || this.restart))
        this.kick();
    });
    // Push is deliberately synchronous; flush/close still observe a permanent failure.
    void this.draining.catch(() => {});
  }

  private async drain(): Promise<void> {
    const generation = this.generation;
    let backoff = this.options.retryMinMs;
    let frames: AcpFrameInput[] | undefined;
    let turnEnd = false;
    while (this.streaming && this.generation === generation && this.ready) {
      if (this.restart) {
        this.restart = false;
        this.epoch++;
        this.nextSeq = 0;
        this.bytes = 0;
        this.queue = [];
        this.queuedBytes = 0;
        this.inFlightBytes = 0;
        frames = undefined;
        this.enqueue(this.timeline.snapshot(), "snapshot");
        this.opening = true;
      }
      try {
        if (this.opening) {
          const result = await this.transport.startEpoch({ chat: this.chat, epoch: this.epoch });
          if (!this.streaming || this.generation !== generation) return;
          if (!result.accepted) {
            this.stop();
            return;
          }
          this.opening = false;
          backoff = this.options.retryMinMs;
        }
        if (!frames) {
          if (this.queue.length === 0) {
            this.ready = false;
            return;
          }
          frames = this.takeFrames();
          turnEnd = frames.some((frame) =>
            (JSON.parse(frame.payload) as AcpOp[]).some((op) => op.op === "turn.end"),
          );
          this.inFlightBytes = frames.reduce((sum, frame) => sum + utf8Bytes(frame.payload), 0);
        }
        const result = await this.transport.appendFrames({
          chat: this.chat,
          epoch: this.epoch,
          frames,
        });
        if (!this.streaming || this.generation !== generation) return;
        if (!result.accepted) {
          this.stop();
          return;
        }
        this.bytes = result.bytes;
        this.inFlightBytes = 0;
        frames = undefined;
        backoff = this.options.retryMinMs;
        if (turnEnd && this.bytes > this.options.rolloverBytes) this.restart = true;
      } catch (error) {
        if (!this.streaming || this.generation !== generation) return;
        const code = errorCode(error);
        if (code && RESTART_CODES[code]) {
          this.restart = true;
          continue;
        }
        if (code?.startsWith("ACP_")) {
          this.stop();
          throw error;
        }
        await this.delay(backoff);
        backoff = Math.min(this.options.retryMaxMs, backoff * 2);
      }
    }
  }

  private takeFrames(): AcpFrameInput[] {
    const frames: AcpFrameInput[] = [];
    while (this.queue.length && frames.length < ACP_FRAMES_PER_APPEND) {
      const first = this.queue[0]!;
      if (first.bytes + 2 > ACP_FRAME_BYTES) {
        this.queue.shift();
        this.queuedBytes -= first.bytes;
        const fragments = this.split(first.op);
        const entries = fragments.map((op) => ({
          kind: first.kind,
          op,
          bytes: utf8Bytes(JSON.stringify(op)),
        }));
        this.queue.unshift(...entries);
        this.queuedBytes += entries.reduce((sum, entry) => sum + entry.bytes, 0);
        continue;
      }
      const ops: AcpOp[] = [];
      let bytes = 2;
      while (this.queue.length) {
        const next = this.queue[0]!;
        if (next.kind !== first.kind || bytes + next.bytes + (ops.length ? 1 : 0) > ACP_FRAME_BYTES)
          break;
        this.queue.shift();
        this.queuedBytes -= next.bytes;
        bytes += next.bytes + (ops.length ? 1 : 0);
        ops.push(next.op);
      }
      const seqFrom = this.nextSeq;
      this.nextSeq += ops.length;
      frames.push({
        seqFrom,
        seqTo: this.nextSeq - 1,
        kind: first.kind,
        payload: JSON.stringify(ops),
      });
    }
    return frames;
  }

  private split(op: AcpOp): AcpOp[] {
    const textAppend =
      op.op === "text.append" &&
      utf8Bytes(JSON.stringify([{ ...op, text: "" }])) + 8 < ACP_FRAME_BYTES
        ? op
        : undefined;
    const serialized = textAppend ? textAppend.text : JSON.stringify(op);
    const id = `fragment:${++this.fragment}`;
    const parts: string[] = [];
    let offset = 0;
    while (offset < serialized.length) {
      let low = 1;
      let high = Math.min(serialized.length - offset, ACP_FRAME_BYTES);
      let length = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const data = serialized.slice(offset, offset + middle);
        const candidate = textAppend
          ? { ...textAppend, text: data }
          : { op: "fragment", id, index: parts.length, total: Number.MAX_SAFE_INTEGER, data };
        if (utf8Bytes(JSON.stringify([candidate])) <= ACP_FRAME_BYTES) {
          length = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (length === 0) throw new Error("Cannot encode an ACP fragment within the frame limit");
      const last = serialized.charCodeAt(offset + length - 1);
      if (last >= 0xd800 && last <= 0xdbff && offset + length < serialized.length) length--;
      parts.push(serialized.slice(offset, offset + length));
      offset += length;
    }
    return parts.map((data, index): AcpOp =>
      textAppend
        ? { ...textAppend, text: data }
        : { op: "fragment", id, index, total: parts.length, data },
    );
  }

  private delay(backoff: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.wakeRetry = resolve;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        this.wakeRetry = undefined;
        resolve();
      },
      Math.min(this.options.retryMaxMs, backoff * (0.75 + this.options.random() * 0.5)),
    );
    return promise;
  }

  private clearTextTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
