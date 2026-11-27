import {
  createCollection,
  type ChangeMessage,
  type Collection,
  type SyncConfig,
} from "@tanstack/react-db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";

import { parseShapeId, plainRow, shapeDefinition, type ShapeRow } from "@/lib/collections/shapes";

/**
 * One live reader per browser profile and user (`docs/Backend_Migration/Live_Data.md`). Browsers
 * allow six HTTP/1.1 connections per origin across all Tabs, and every live read (an event SSE,
 * an Electric long-poll) holds one; with one reader set per Tab, a few Tabs starve every other
 * request. So the Tabs of one user elect a leader with a Web Lock (`radium-live:<user>`), and only
 * the leader reads: the event streams in a Worker (a Worker has no `document`, so the reader keeps
 * reading while the leader's Tab is hidden) and the Electric shapes in collections of its own. The
 * leader relays what it reads over a `BroadcastChannel` of the same name; every Tab, the leader
 * included, applies it. Nothing leaves the origin or the user: the channel carries what the
 * streams and shapes already serve this user, and it is closed on sign-out and user switch.
 *
 * Protocol ({@link RelayMessage}):
 * - Every Tab announces its interest (`interest`): the workspaces it shows (their event streams)
 *   and the shapes its collections read, with those still waiting for a snapshot. It announces on
 *   start, on every change and when a leader says `hello`, and says `bye` when it goes.
 * - The leader reads the union: the user stream once, one stream per wanted workspace, one shape
 *   sync per wanted shape. A Tab is dropped on `bye` or once its own Tab lock is released (the
 *   leader checks the held locks; timers of hidden Tabs are throttled, so silence proves nothing).
 * - `events` go to every Tab, which applies those of the user stream and of the workspaces it
 *   shows; `gap` (a rotated or lost stream, a new leader) makes every Tab refetch everything.
 * - Shapes: `snapshot` (to one Tab) replaces a collection's rows; `changes` (to all) apply after it.
 *
 * A new leader says `hello`, so every Tab re-announces and asks for fresh snapshots, and sends
 * `gap` when a leader came before it (events may have been missed during the handover). Without
 * Web Locks every Tab leads alone, without the channel.
 */

/** One invalidation event: a tRPC router and, optionally, the ids of what changed. */
export type LiveEvent = { topic: string; ids?: string[] };

/** A change of one synced row, as the leader relays it. */
export type RelayChange =
  | { type: "insert" | "update"; value: object }
  | { type: "delete"; key: string | number };

/** Messages between the Tabs of one user. */
export type RelayMessage =
  /** A new leader: every Tab re-announces and waits for fresh snapshots. */
  | { type: "hello" }
  /** What Tab `tab` needs now; `snapshots` are the shapes it waits a snapshot for. */
  | { type: "interest"; tab: string; workspaces: string[]; shapes: string[]; snapshots: string[] }
  /** Tab `tab` is going. */
  | { type: "bye"; tab: string }
  /** Events of the user stream (`workspace: null`) or of one workspace's stream. */
  | { type: "events"; workspace: string | null; events: LiveEvent[] }
  /** Events may have been missed: refetch everything. */
  | { type: "gap" }
  /** Every row of `shape`, for Tab `to`. */
  | { type: "snapshot"; to: string; shape: string; rows: object[] }
  /** Rows of `shape` that changed. */
  | { type: "changes"; shape: string; changes: RelayChange[] };

/** Leader Tab → its event Worker: the workspaces whose streams to read (the user's always). */
export type WorkerRequest = { type: "want"; workspaces: string[] };
/** Event Worker → its leader Tab. */
export type WorkerEvent = Extract<RelayMessage, { type: "events" | "gap" }>;

/** How often the leader drops Tabs whose lock is gone, and how new an interest is spared. */
const PRUNE_MS = 5_000;
/** A shape nobody wants keeps syncing this long, so a collection recreated at once reuses it. */
const SOURCE_RELEASE_MS = 5_000;

// --- Relay-fed collections ------------------------------------------------------------------

type ShapeSink = {
  snapshot(rows: readonly object[]): void;
  changes(changes: readonly RelayChange[]): void;
};

/** The relay-fed collections of one Tab, by shape. */
export class ShapeSinks {
  readonly #sinks = new Map<string, Set<ShapeSink>>();
  /** Shapes whose collections wait for a snapshot; changes before it are dropped. */
  readonly #awaiting = new Set<string>();
  #listener: (() => void) | undefined;

  /** Adds a collection's end; returns its removal. */
  attach(shape: string, sink: ShapeSink): () => void {
    let sinks = this.#sinks.get(shape);
    if (!sinks) this.#sinks.set(shape, (sinks = new Set()));
    sinks.add(sink);
    this.#awaiting.add(shape);
    this.#listener?.();
    return () => {
      sinks.delete(sink);
      if (sinks.size === 0 && this.#sinks.get(shape) === sinks) {
        this.#sinks.delete(shape);
        this.#awaiting.delete(shape);
      }
      this.#listener?.();
    };
  }

  /** Calls `listener` when shapes are added or removed; one listener at a time. */
  listen(listener: () => void): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  shapes(): string[] {
    return [...this.#sinks.keys()];
  }

  awaiting(): string[] {
    return [...this.#awaiting];
  }

  /** Every collection waits for a fresh snapshot (a new leader). */
  awaitAll() {
    for (const shape of this.#sinks.keys()) this.#awaiting.add(shape);
  }

  snapshot(shape: string, rows: readonly object[]) {
    const sinks = this.#sinks.get(shape);
    if (!sinks) return;
    this.#awaiting.delete(shape);
    for (const sink of sinks) sink.snapshot(rows);
  }

  changes(shape: string, changes: readonly RelayChange[]) {
    if (this.#awaiting.has(shape)) return;
    for (const sink of this.#sinks.get(shape) ?? []) sink.changes(changes);
  }
}

/** This Tab's relay-fed collections. */
export const shapeSinks = new ShapeSinks();

/**
 * The `sync` of a collection fed by the relay with the rows of `shape` (rows of type `T`, as the
 * leader mapped them): ready at the first snapshot, replaced by every later one. Changes apply
 * as upserts and deletes of present rows, so a change the snapshot already holds is harmless.
 */
export function relaySync<T extends object>(
  sinks: ShapeSinks,
  shape: string,
  getKey: (row: T) => string | number,
): SyncConfig<T, string | number>["sync"] {
  return ({ begin, write, commit, markReady, collection }) => {
    let ready = false;
    return sinks.attach(shape, {
      snapshot(rows) {
        begin({ snapshot: true });
        // The leader relays rows of this shape only.
        for (const value of rows as T[]) write({ type: "insert", value });
        commit();
        if (!ready) {
          ready = true;
          markReady();
        }
      },
      changes(changes) {
        if (changes.length === 0) return;
        // Presence as of this batch: earlier changes in it count before they commit.
        const present = new Map<string | number, boolean>();
        const has = (key: string | number) => present.get(key) ?? collection.has(key);
        begin();
        for (const change of changes) {
          if (change.type === "delete") {
            if (has(change.key)) write({ type: "delete", key: change.key });
            present.set(change.key, false);
            continue;
          }
          const value = change.value as T;
          const key = getKey(value);
          write({ type: has(key) ? "update" : "insert", value });
          present.set(key, true);
        }
        commit();
      },
    });
  };
}

// --- The relay --------------------------------------------------------------------------------

/** A shape the leader syncs. */
export type SyncedShape = {
  /** Every row, once the first sync is complete. */
  rows(): readonly object[] | undefined;
  stop(): void;
};

/** What the leader starts: injected so the protocol runs without a browser in tests. */
export type LeaderRuntime = {
  startWorker(onEvent: (event: WorkerEvent) => void): {
    want(workspaces: string[]): void;
    stop(): void;
  };
  /** Syncs `shape`; `null` for an unknown one. Calls `ready` once, then `changes` per commit. */
  startShape(
    shape: string,
    handlers: { ready(): void; changes(changes: RelayChange[]): void },
  ): SyncedShape | null;
  /** The ids of Tabs whose Tab lock is held; `undefined` when that cannot be known. */
  liveTabs?(): Promise<ReadonlySet<string>>;
};

type TabInterest = { workspaces: string[]; shapes: string[]; seen: number };

type ShapeEntry = {
  synced: SyncedShape;
  /** Tabs waiting for the first complete sync. */
  waiting: Set<string>;
  release?: ReturnType<typeof setTimeout>;
};

type Leading = {
  tabs: Map<string, TabInterest>;
  worker: ReturnType<LeaderRuntime["startWorker"]>;
  workspaces: string;
  shapes: Map<string, ShapeEntry>;
  prune: ReturnType<typeof setInterval>;
};

/**
 * One Tab's side of the protocol (see the module comment). `channel` posts to the other Tabs
 * (their messages arrive through {@link receive}); `null` leads alone.
 */
export class LiveRelay {
  readonly #tab: string;
  readonly #channel: { post(message: RelayMessage): void } | null;
  readonly #sinks: ShapeSinks;
  readonly #onEvents: (events: LiveEvent[]) => void;
  readonly #onGap: () => void;
  readonly #runtime: LeaderRuntime;
  readonly #stopListening: () => void;
  #workspaces: string[] = [];
  #leading: Leading | undefined;
  /** A leader existed before this Tab could lead: its takeover may have missed events. */
  #followed = false;
  #announcing = false;
  #stopped = false;

  constructor(options: {
    tab: string;
    channel: { post(message: RelayMessage): void } | null;
    sinks: ShapeSinks;
    onEvents: (events: LiveEvent[]) => void;
    onGap: () => void;
    runtime: LeaderRuntime;
  }) {
    this.#tab = options.tab;
    this.#channel = options.channel;
    this.#sinks = options.sinks;
    this.#onEvents = options.onEvents;
    this.#onGap = options.onGap;
    this.#runtime = options.runtime;
    this.#stopListening = this.#sinks.listen(() => this.#announceSoon());
  }

  get isLeader() {
    return this.#leading !== undefined;
  }

  /** The workspaces this Tab shows: their events apply here, and the leader reads their streams. */
  setWorkspaces(workspaces: string[]) {
    this.#workspaces = workspaces;
    this.#announceSoon();
  }

  /** Records that a leader exists (it holds the lock this Tab waits for). */
  followLeader() {
    this.#followed = true;
  }

  /** A message from another Tab. */
  receive(message: RelayMessage) {
    if (this.#stopped) return;
    switch (message.type) {
      case "hello":
        this.#followed = true;
        this.#sinks.awaitAll();
        this.announce();
        return;
      case "interest":
        if (this.#leading) this.#interest(message.tab, message);
        return;
      case "bye":
        if (this.#leading?.tabs.delete(message.tab)) this.#recompute();
        return;
      default:
        this.#followed = true;
        this.#apply(message);
    }
  }

  /** Tells the leader (or, leading, itself) what this Tab needs now. */
  announce() {
    if (this.#stopped) return;
    const interest = {
      workspaces: this.#workspaces,
      shapes: this.#sinks.shapes(),
      snapshots: this.#sinks.awaiting(),
    };
    if (this.#leading) this.#interest(this.#tab, interest);
    else this.#channel?.post({ type: "interest", tab: this.#tab, ...interest });
  }

  /** Becomes the leader: reads for every Tab until {@link stop}. */
  lead() {
    if (this.#stopped || this.#leading) return;
    this.#leading = {
      tabs: new Map(),
      worker: this.#runtime.startWorker((event) => this.#send(event)),
      workspaces: "",
      shapes: new Map(),
      prune: setInterval(() => void this.#prune(), PRUNE_MS),
    };
    if (this.#followed) this.#send({ type: "gap" });
    this.#channel?.post({ type: "hello" });
    this.#sinks.awaitAll();
    this.announce();
  }

  /** Says goodbye and stops leading; the Tab lock and channel are its owner's to release. */
  stop() {
    if (this.#stopped) return;
    this.#channel?.post({ type: "bye", tab: this.#tab });
    this.#stopped = true;
    this.#stopListening();
    const leading = this.#leading;
    this.#leading = undefined;
    if (!leading) return;
    clearInterval(leading.prune);
    leading.worker.stop();
    for (const entry of leading.shapes.values()) {
      clearTimeout(entry.release);
      entry.synced.stop();
    }
  }

  #announceSoon() {
    if (this.#announcing) return;
    this.#announcing = true;
    queueMicrotask(() => {
      this.#announcing = false;
      this.announce();
    });
  }

  /** Sends to every Tab, this one included. */
  #send(message: RelayMessage) {
    this.#channel?.post(message);
    this.#apply(message);
  }

  /** Sends a message meant for one Tab to that Tab only. */
  #sendTo(tab: string, message: RelayMessage) {
    if (tab === this.#tab) this.#apply(message);
    else this.#channel?.post(message);
  }

  #apply(message: RelayMessage) {
    switch (message.type) {
      case "events":
        if (message.workspace === null || this.#workspaces.includes(message.workspace)) {
          this.#onEvents(message.events);
        }
        return;
      case "gap":
        this.#onGap();
        return;
      case "snapshot":
        if (message.to === this.#tab) this.#sinks.snapshot(message.shape, message.rows);
        return;
      case "changes":
        this.#sinks.changes(message.shape, message.changes);
        return;
    }
  }

  #interest(
    tab: string,
    interest: { workspaces: string[]; shapes: string[]; snapshots: string[] },
  ) {
    const leading = this.#leading;
    if (!leading) return;
    leading.tabs.set(tab, {
      workspaces: interest.workspaces,
      shapes: interest.shapes,
      seen: Date.now(),
    });
    this.#recompute();
    for (const shape of interest.snapshots) {
      const entry = leading.shapes.get(shape);
      if (!entry) continue;
      const rows = entry.synced.rows();
      if (rows) this.#sendTo(tab, { type: "snapshot", to: tab, shape, rows: [...rows] });
      else entry.waiting.add(tab);
    }
  }

  /** Reads the union of every Tab's interest. */
  #recompute() {
    const leading = this.#leading;
    if (!leading) return;
    const workspaces = new Set<string>();
    const shapes = new Set<string>();
    for (const interest of leading.tabs.values()) {
      for (const workspace of interest.workspaces) workspaces.add(workspace);
      for (const shape of interest.shapes) shapes.add(shape);
    }
    const wanted = [...workspaces].sort();
    if (wanted.join("\n") !== leading.workspaces) {
      leading.workspaces = wanted.join("\n");
      leading.worker.want(wanted);
    }
    for (const shape of shapes) {
      const entry = leading.shapes.get(shape);
      if (entry) {
        clearTimeout(entry.release);
        entry.release = undefined;
        continue;
      }
      const created: ShapeEntry | undefined = this.#startShape(leading, shape);
      if (created) leading.shapes.set(shape, created);
    }
    for (const [shape, entry] of leading.shapes) {
      if (shapes.has(shape) || entry.release) continue;
      entry.release = setTimeout(() => {
        if (leading.shapes.get(shape) !== entry) return;
        leading.shapes.delete(shape);
        entry.synced.stop();
      }, SOURCE_RELEASE_MS);
    }
  }

  #startShape(leading: Leading, shape: string): ShapeEntry | undefined {
    const waiting = new Set<string>();
    const synced = this.#runtime.startShape(shape, {
      ready: () => {
        const rows = synced?.rows();
        if (!rows || this.#leading !== leading) return;
        for (const tab of waiting) {
          if (leading.tabs.get(tab)?.shapes.includes(shape)) {
            this.#sendTo(tab, { type: "snapshot", to: tab, shape, rows: [...rows] });
          }
        }
        waiting.clear();
      },
      changes: (changes) => {
        if (this.#leading === leading) this.#send({ type: "changes", shape, changes });
      },
    });
    return synced ? { synced, waiting } : undefined;
  }

  /** Drops Tabs that are gone without a `bye` (crashed, killed). */
  async #prune() {
    const leading = this.#leading;
    const live = await this.#runtime.liveTabs?.();
    if (!live || this.#leading !== leading || !leading) return;
    const now = Date.now();
    let changed = false;
    for (const [tab, interest] of leading.tabs) {
      if (tab === this.#tab || live.has(tab) || now - interest.seen < PRUNE_MS) continue;
      leading.tabs.delete(tab);
      changed = true;
    }
    if (changed) this.#recompute();
  }
}

// --- Browser wiring ---------------------------------------------------------------------------

/** Shapes the leader syncs keep syncing while its Tab is hidden: the other Tabs read them. */
const ALWAYS_VISIBLE = { getCurrentState: () => "visible" as const, subscribe: () => () => {} };

/** Syncs one Electric shape for the relay (`/api/shapes/<shape>`). */
function startElectricShape(
  id: string,
  handlers: { ready(): void; changes(changes: RelayChange[]): void },
): SyncedShape | null {
  const parsed = parseShapeId(id);
  if (!parsed) return null;
  const definition = shapeDefinition(parsed.shape);
  const collection: Collection<ShapeRow, string | number> = createCollection(
    electricCollectionOptions({
      id: `live-relay:${id}`,
      // Rows enter as UI rows (`transformer`), which is what `getKey` reads.
      getKey: (row: ShapeRow) => definition.getKey(row),
      shapeOptions: {
        url: new URL(`/api/shapes/${parsed.shape}`, location.origin).href,
        params: { ...parsed.selector },
        transformer: (row) => definition.fromShape(row) as ShapeRow,
        runtimeVisibility: ALWAYS_VISIBLE,
        // `401`/`404` (signed out, access lost, Electric off) end the sync; network and server
        // errors are retried by the client first.
        onError: () => undefined,
      },
    }),
  );
  let stopped = false;
  let ready = false;
  let subscription: { unsubscribe(): void } | undefined;
  void collection.toArrayWhenReady().then(
    () => {
      if (stopped) return;
      // Subscribed in the same turn the rows are read, so no change falls between them.
      subscription = collection.subscribeChanges((changes) =>
        handlers.changes(changes.map(relayChange)),
      );
      ready = true;
      handlers.ready();
    },
    () => {},
  );
  return {
    rows: () => (ready ? collection.toArray.map(plainRow) : undefined),
    stop() {
      stopped = true;
      subscription?.unsubscribe();
      void collection.cleanup();
    },
  };
}

function relayChange(change: ChangeMessage<ShapeRow, string | number>): RelayChange {
  return change.type === "delete"
    ? { type: "delete", key: change.key }
    : { type: change.type, value: plainRow(change.value) };
}

function startEventWorker(onEvent: (event: WorkerEvent) => void) {
  const worker = new Worker(new URL("./live-worker.ts", import.meta.url), {
    type: "module",
    name: "radium-live-events",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerEvent>) => onEvent(event.data));
  return {
    want: (workspaces: string[]) =>
      worker.postMessage({ type: "want", workspaces } satisfies WorkerRequest),
    stop: () => worker.terminate(),
  };
}

/** A running relay of this Tab. */
export type LiveRelayHandle = {
  setWorkspaces(workspaces: string[]): void;
  stop(): void;
};

/**
 * Starts this Tab's relay for user `userId` (see the module comment): joins the user's Tabs, and
 * leads when it holds the user's lock. `onEvents` and `onGap` apply what the leader reads.
 */
export function startLiveRelay(options: {
  userId: string;
  onEvents: (events: LiveEvent[]) => void;
  onGap: () => void;
}): LiveRelayHandle {
  const name = `radium-live:${options.userId}`;
  const tab = crypto.randomUUID();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const broadcast =
    locks && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(name) : null;
  const abort = new AbortController();
  const released = Promise.withResolvers<void>();
  const tabLock = `${name}:tab:`;
  const relay = new LiveRelay({
    tab,
    channel: broadcast && { post: (message) => broadcast.postMessage(message) },
    sinks: shapeSinks,
    onEvents: options.onEvents,
    onGap: options.onGap,
    runtime: {
      startWorker: startEventWorker,
      startShape: startElectricShape,
      liveTabs: locks
        ? async () => {
            const { held = [] } = await locks.query();
            return new Set(
              held.flatMap((lock) =>
                lock.name?.startsWith(tabLock) ? [lock.name.slice(tabLock.length)] : [],
              ),
            );
          }
        : undefined,
    },
  });

  if (!locks || !broadcast) {
    relay.lead();
  } else {
    broadcast.addEventListener("message", (event: MessageEvent<RelayMessage>) =>
      relay.receive(event.data),
    );
    // Held for the Tab's life: the leader reads which Tabs are alive from the held Tab locks.
    void locks
      .request(`${tabLock}${tab}`, { signal: abort.signal }, () => released.promise)
      .catch(() => {});
    void (async () => {
      // A held lock means a leader came first: this Tab's takeover may miss events.
      const { held = [] } = await locks.query().catch(() => ({ held: [] }));
      if (held.some((lock) => lock.name === name)) relay.followLeader();
      await locks.request(name, { signal: abort.signal }, () => {
        relay.lead();
        return released.promise;
      });
    })().catch(() => {});
    relay.announce();
  }

  // A page leaving says goodbye at once; one restored from the back/forward cache rejoins.
  const onPageHide = () => broadcast?.postMessage({ type: "bye", tab } satisfies RelayMessage);
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) relay.announce();
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  return {
    setWorkspaces: (workspaces) => relay.setWorkspaces(workspaces),
    stop() {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      relay.stop();
      abort.abort();
      released.resolve();
      broadcast?.close();
    },
  };
}
