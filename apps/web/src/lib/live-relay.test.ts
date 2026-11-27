import { afterEach, describe, expect, test, vi } from "bun:test";
import { createCollection } from "@tanstack/react-db";

import {
  LiveRelay,
  relaySync,
  ShapeSinks,
  type LeaderRuntime,
  type LiveEvent,
  type RelayChange,
  type RelayMessage,
  type WorkerEvent,
} from "./live-relay";

/** Tabs of one browser profile: a channel delivers (copied) to every other Tab. */
function profile() {
  const tabs = new Map<string, LiveRelay>();
  return {
    channel: (tab: string) => ({
      post(message: RelayMessage) {
        for (const [other, relay] of tabs) {
          if (other !== tab) relay.receive(structuredClone(message));
        }
      },
    }),
    add(tab: string, relay: LiveRelay) {
      tabs.set(tab, relay);
    },
    remove(tab: string) {
      tabs.delete(tab);
    },
  };
}

type FakeShape = {
  handlers: { ready(): void; changes(changes: RelayChange[]): void };
  rows?: object[];
  stopped: boolean;
};

/** A leader's Worker and shape syncs, driven by the test. */
function fakeRuntime() {
  const wants: string[][] = [];
  const shapes = new Map<string, FakeShape>();
  let emit: ((event: WorkerEvent) => void) | undefined;
  const runtime: LeaderRuntime = {
    startWorker(onEvent) {
      emit = onEvent;
      return { want: (workspaces) => wants.push(workspaces), stop: () => (emit = undefined) };
    },
    startShape(shape, handlers) {
      const entry: FakeShape = { handlers, stopped: false };
      shapes.set(shape, entry);
      return {
        rows: () => entry.rows,
        stop: () => {
          entry.stopped = true;
        },
      };
    },
  };
  return {
    runtime,
    wants,
    shapes,
    emit: (event: WorkerEvent) => emit?.(event),
    ready(shape: string, rows: object[]) {
      const entry = shapes.get(shape);
      if (!entry) throw new Error(`${shape} was not started`);
      entry.rows = rows;
      entry.handlers.ready();
    },
  };
}

type Tab = ReturnType<typeof openTab>;
const opened: Tab[] = [];

function openTab(browser: ReturnType<typeof profile>, tab: string) {
  const fake = fakeRuntime();
  const events: LiveEvent[][] = [];
  let gaps = 0;
  const sinks = new ShapeSinks();
  const relay = new LiveRelay({
    tab,
    channel: browser.channel(tab),
    sinks,
    onEvents: (batch) => events.push(batch),
    onGap: () => gaps++,
    runtime: fake.runtime,
  });
  browser.add(tab, relay);
  const opened = {
    relay,
    sinks,
    fake,
    events,
    gaps: () => gaps,
    close() {
      relay.stop();
      browser.remove(tab);
    },
  };
  return opened;
}

function track(tab: Tab) {
  opened.push(tab);
  return tab;
}

/** Lets queued announcements and collection commits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Row = { id: string; name: string };

function relayCollection(sinks: ShapeSinks, shape: string) {
  return createCollection<Row, string | number>({
    id: `${shape}:${crypto.randomUUID()}`,
    getKey: (row) => row.id,
    sync: { sync: relaySync<Row>(sinks, shape, (row) => row.id) },
  });
}

afterEach(() => {
  for (const tab of opened.splice(0)) tab.close();
});

describe("live relay", () => {
  test("the leader reads the union of the Tabs' workspaces and relays events to the Tabs showing them", async () => {
    const browser = profile();
    const leader = track(openTab(browser, "a"));
    const follower = track(openTab(browser, "b"));
    leader.relay.lead();
    leader.relay.setWorkspaces(["w1"]);
    follower.relay.setWorkspaces(["w2"]);
    await settle();
    expect(leader.fake.wants.at(-1)).toEqual(["w1", "w2"]);

    leader.fake.emit({ type: "events", workspace: "w2", events: [{ topic: "chats", ids: ["c"] }] });
    leader.fake.emit({ type: "events", workspace: null, events: [{ topic: "notifications" }] });
    expect(follower.events).toEqual([
      [{ topic: "chats", ids: ["c"] }],
      [{ topic: "notifications" }],
    ]);
    expect(leader.events).toEqual([[{ topic: "notifications" }]]);

    leader.fake.emit({ type: "gap" });
    expect([leader.gaps(), follower.gaps()]).toEqual([1, 1]);

    // A Tab that goes takes its interest along.
    follower.close();
    expect(leader.fake.wants.at(-1)).toEqual(["w1"]);
  });

  test("a relay-fed collection loads from a snapshot, then applies changes idempotently", async () => {
    const browser = profile();
    const leader = track(openTab(browser, "a"));
    const follower = track(openTab(browser, "b"));
    leader.relay.lead();
    const shape = "projects?workspace=w1";
    const collection = relayCollection(follower.sinks, shape);
    const loaded = collection.preload();
    await settle();
    expect(leader.fake.shapes.has(shape)).toBe(true);
    expect(collection.isReady()).toBe(false);

    // Changes before the snapshot are dropped: the snapshot holds them.
    leader.fake.shapes
      .get(shape)
      ?.handlers.changes([{ type: "insert", value: { id: "x", name: "early" } }]);
    leader.fake.ready(shape, [{ id: "p1", name: "One" }]);
    await loaded;
    expect(collection.toArray.map((row) => row.id)).toEqual(["p1"]);

    const changes = leader.fake.shapes.get(shape)!.handlers.changes;
    // Already present (a change the snapshot held) becomes an update; inserting twice is harmless.
    changes([
      { type: "insert", value: { id: "p1", name: "Uno" } },
      { type: "insert", value: { id: "p2", name: "Two" } },
      { type: "update", value: { id: "p2", name: "Dos" } },
      { type: "delete", key: "gone" },
    ]);
    await settle();
    expect(collection.toArray.map((row) => [row.id, row.name]).sort()).toEqual([
      ["p1", "Uno"],
      ["p2", "Dos"],
    ]);
    changes([{ type: "delete", key: "p1" }]);
    await settle();
    expect(collection.toArray.map((row) => row.id)).toEqual(["p2"]);

    // A collection made again for the same shape gets its own snapshot.
    await collection.cleanup();
    leader.fake.shapes.get(shape)!.rows = [{ id: "p2", name: "Dos" }];
    const again = relayCollection(follower.sinks, shape);
    await again.preload();
    expect(again.toArray.map((row) => row.id)).toEqual(["p2"]);
  });

  test("a new leader after another reports a gap and re-snapshots every Tab", async () => {
    const browser = profile();
    const first = track(openTab(browser, "a"));
    const second = track(openTab(browser, "b"));
    first.relay.lead();
    expect(first.gaps()).toBe(0);
    const shape = "notifications?";
    const collection = relayCollection(second.sinks, shape);
    const loaded = collection.preload();
    await settle();
    first.fake.ready(shape, [{ id: "n1", name: "old" }]);
    await loaded;

    first.close();
    second.relay.lead();
    await settle();
    expect(second.gaps()).toBe(1);
    // The new leader syncs the shape itself and replaces the rows the old one relayed.
    second.fake.ready(shape, [{ id: "n2", name: "new" }]);
    await settle();
    expect(collection.toArray.map((row) => row.id)).toEqual(["n2"]);
  });

  test("Tabs whose lock is gone are dropped by the leader", async () => {
    vi.useFakeTimers();
    const microtasks = async () => {
      for (let index = 0; index < 5; index++) await Promise.resolve();
    };
    try {
      const browser = profile();
      const leader = track(openTab(browser, "a"));
      const live = new Set(["a", "b"]);
      leader.fake.runtime.liveTabs = async () => live;
      leader.relay.lead();
      const follower = track(openTab(browser, "b"));
      follower.relay.setWorkspaces(["w9"]);
      await microtasks();
      expect(leader.fake.wants.at(-1)).toEqual(["w9"]);
      // Still alive at the next check: kept.
      vi.advanceTimersByTime(5_100);
      await microtasks();
      expect(leader.fake.wants.at(-1)).toEqual(["w9"]);
      // Crashed: no `bye`, and its Tab lock released.
      browser.remove("b");
      live.delete("b");
      vi.advanceTimersByTime(5_100);
      await microtasks();
      expect(leader.fake.wants.at(-1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
