import type {
  AcpCommandInfo,
  AcpConfig,
  AcpFrameKind,
  AcpItem,
  AcpItemPatch,
  AcpOp,
  AcpStopReason,
  AcpUsage,
} from "./contract";

/**
 * Client-side fold of an ACP epoch stream (`chatroom.LiveFrames`) into the normalized timeline
 * (`docs/ACP/Transport.md#normalized-timeline`). Runtime-neutral and immutable: every call that
 * changes something returns a new state, so React can compare by reference; items that did not
 * change keep their object identity.
 */

/** One `chatroom.LiveFrames` row. `seqFrom..seqTo` (inclusive) count the frame's ops. */
export type AcpFrame = { seqFrom: number; seqTo: number; kind: AcpFrameKind; payload: string };

/** The current or last turn as the stream reported it. */
export type AcpTurn = {
  id: string;
  ended: boolean;
  stopReason?: AcpStopReason;
  error?: string;
};

/** Session metadata carried by `session.patch` ops (also mirrored to `acp_sessions`). */
export type AcpStreamSession = {
  config?: AcpConfig;
  commands?: AcpCommandInfo[];
  usage?: AcpUsage;
  title?: string;
  updatedAt?: string;
};

export type AcpTimeline = {
  /** Epoch this state follows; `undefined` before the first `startEpoch`. */
  epoch: number | undefined;
  /** Sequence number of the next op expected from the epoch stream. */
  nextSeq: number;
  /** Items by id; values are never mutated in place. */
  items: ReadonlyMap<string, AcpItem>;
  /** Item ids sorted by `order`. */
  sorted: readonly string[];
  /** Lowest `order` covered by a snapshot or history page; `undefined` until a snapshot arrived. */
  windowStart: number | undefined;
  /** Whether items older than `windowStart` exist (in the agent). */
  hasMore: boolean;
  /** Whether the current epoch's snapshot has been applied. */
  hasSnapshot: boolean;
  turn: AcpTurn | undefined;
  session: AcpStreamSession;
  /** Pieces of ops split across frames, by fragment id. */
  fragments: ReadonlyMap<string, readonly string[]>;
};

export const emptyAcpTimeline: AcpTimeline = {
  epoch: undefined,
  nextSeq: 0,
  items: new Map(),
  sorted: [],
  windowStart: undefined,
  hasMore: false,
  hasSnapshot: false,
  turn: undefined,
  session: {},
  fragments: new Map(),
};

/**
 * Follow a new epoch from sequence 0. `keepOlder` keeps items the client already holds below the
 * new snapshot's window (a size rollover seen live); otherwise the new snapshot replaces
 * everything, which is right after a cold period or a Worker restart, when item orders may differ.
 */
export function startAcpEpoch(
  state: AcpTimeline,
  epoch: number,
  { keepOlder }: { keepOlder: boolean },
): AcpTimeline {
  if (state.epoch === epoch) return state;
  return {
    ...emptyAcpTimeline,
    epoch,
    ...(keepOlder
      ? {
          items: state.items,
          sorted: state.sorted,
          windowStart: state.windowStart,
          hasMore: state.hasMore,
          session: state.session,
        }
      : {}),
  };
}

/**
 * Apply frames of the current epoch in sequence order. Frames already applied (a re-delivered
 * page) are skipped; a frame after a gap stops the fold, since the missing range must arrive
 * first. Unparseable payloads are skipped by sequence so one bad frame cannot stall the stream.
 */
export function applyAcpFrames(state: AcpTimeline, frames: readonly AcpFrame[]): AcpTimeline {
  const sortedFrames = [...frames].sort((a, b) => a.seqFrom - b.seqFrom);
  let draft: Draft | undefined;
  let nextSeq = state.nextSeq;
  for (const frame of sortedFrames) {
    if (frame.seqTo < nextSeq) continue;
    if (frame.seqFrom !== nextSeq) break;
    draft ??= new Draft(state);
    let ops: AcpOp[];
    try {
      ops = JSON.parse(frame.payload) as AcpOp[];
    } catch {
      ops = [];
    }
    if (Array.isArray(ops)) for (const op of ops) draft.apply(op);
    nextSeq = frame.seqTo + 1;
  }
  if (!draft) return state;
  return draft.finish(nextSeq);
}

/** Items in display order. */
export function acpItemsInOrder(state: AcpTimeline): AcpItem[] {
  return state.sorted.flatMap((id) => {
    const item = state.items.get(id);
    return item ? [item] : [];
  });
}

/** Mutable working copy used inside one `applyAcpFrames` call. */
class Draft {
  private items: Map<string, AcpItem> | undefined;
  private fragments: Map<string, readonly string[]> | undefined;
  private orderChanged = false;
  private windowStart: number | undefined;
  private hasMore: boolean;
  private hasSnapshot: boolean;
  private turn: AcpTurn | undefined;
  private session: AcpStreamSession;

  constructor(private readonly base: AcpTimeline) {
    this.windowStart = base.windowStart;
    this.hasMore = base.hasMore;
    this.hasSnapshot = base.hasSnapshot;
    this.turn = base.turn;
    this.session = base.session;
  }

  private writableItems() {
    this.items ??= new Map(this.base.items);
    return this.items;
  }

  private currentItems(): ReadonlyMap<string, AcpItem> {
    return this.items ?? this.base.items;
  }

  apply(op: AcpOp): void {
    switch (op.op) {
      case "window":
        this.window(op);
        return;
      case "item.upsert":
        this.upsert(op.item);
        return;
      case "text.append": {
        const item = this.currentItems().get(op.id);
        if (!item || !("text" in item)) return;
        this.writableItems().set(op.id, { ...item, text: item.text + op.text });
        return;
      }
      case "turn.start":
        this.turn = { id: op.turnId, ended: false };
        return;
      case "turn.end":
        this.turn = {
          id: op.turnId,
          ended: true,
          ...(op.stopReason ? { stopReason: op.stopReason } : {}),
          ...(op.error ? { error: op.error } : {}),
        };
        return;
      case "session.patch": {
        const next: AcpStreamSession = { ...this.session };
        if (op.config) next.config = op.config;
        if (op.commands) next.commands = op.commands;
        if (op.usage) next.usage = op.usage;
        if (op.info?.title !== undefined) {
          if (op.info.title === null) delete next.title;
          else next.title = op.info.title;
        }
        if (op.info?.updatedAt !== undefined) {
          if (op.info.updatedAt === null) delete next.updatedAt;
          else next.updatedAt = op.info.updatedAt;
        }
        this.session = next;
        return;
      }
      case "fragment":
        this.fragment(op);
        return;
    }
  }

  private window(op: Extract<AcpOp, { op: "window" }>) {
    if (op.before === undefined) {
      // A snapshot: everything at or after `start` is re-sent, so drop the stale copies.
      const items = this.writableItems();
      for (const [id, item] of items) if (item.order >= op.start) items.delete(id);
      this.orderChanged = true;
      this.windowStart = Math.min(op.start, this.windowStart ?? op.start);
      if (this.windowStart === op.start) this.hasMore = op.hasMore;
      this.hasSnapshot = true;
      return;
    }
    // A history page covering `start <= order < before`.
    if (this.windowStart === undefined || op.start <= this.windowStart) {
      this.windowStart = op.start;
      this.hasMore = op.hasMore;
    }
  }

  private upsert(patch: AcpItemPatch) {
    const existing = this.currentItems().get(patch.id);
    if (!existing && (patch.kind == null || patch.order == null)) return;
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    if (!existing || existing.order !== next.order) this.orderChanged = true;
    this.writableItems().set(patch.id, next as AcpItem);
  }

  private fragment(op: Extract<AcpOp, { op: "fragment" }>) {
    if (op.total < 1 || op.index < 0 || op.index >= op.total) return;
    this.fragments ??= new Map(this.base.fragments);
    const pieces = [...(this.fragments.get(op.id) ?? [])];
    pieces[op.index] = op.data;
    if (op.index < op.total - 1) {
      this.fragments.set(op.id, pieces);
      return;
    }
    this.fragments.delete(op.id);
    if (pieces.length !== op.total || pieces.some((piece) => piece === undefined)) return;
    let whole: AcpOp;
    try {
      whole = JSON.parse(pieces.join("")) as AcpOp;
    } catch {
      return;
    }
    if (whole.op !== "fragment") this.apply(whole);
  }

  finish(nextSeq: number): AcpTimeline {
    const items = this.items ?? this.base.items;
    const sorted =
      this.orderChanged || items.size !== this.base.sorted.length
        ? [...items.values()].sort((a, b) => a.order - b.order).map((item) => item.id)
        : this.base.sorted;
    return {
      epoch: this.base.epoch,
      nextSeq,
      items,
      sorted,
      windowStart: this.windowStart,
      hasMore: this.hasMore,
      hasSnapshot: this.hasSnapshot,
      turn: this.turn,
      session: this.session,
      fragments: this.fragments ?? this.base.fragments,
    };
  }
}
