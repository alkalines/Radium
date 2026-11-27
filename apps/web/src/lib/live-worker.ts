import type { LiveEvent, WorkerEvent, WorkerRequest } from "@/lib/live-relay";
import { readStream, retryDelay, sleep } from "@/lib/stream-reader";
import { trpcClient } from "@/lib/trpc-client";

/**
 * The leader Tab's event reader (`lib/live-relay.ts`): reads the user's event stream and one
 * stream per workspace the user's Tabs show, through `/api/streams`, and posts every event to the
 * Tab. A Worker has no `document`, so reading never pauses while the leader's Tab is hidden.
 *
 * Each stream starts at its current end (screens load their state themselves) and resumes from
 * its last offset after network errors. A stream that is rotated (`rotate`, then closed), gone or
 * refused is asked for again (`events.streams`) and reported as a `gap`, since events may have
 * been missed in between.
 */

// This module runs as a dedicated Worker, whose global scope posts to and hears from its Tab.
const scope = globalThis as unknown as {
  postMessage(message: WorkerEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

const readers = new Map<string, AbortController>();

scope.addEventListener("message", ({ data }) => {
  if (data.type !== "want") return;
  const wanted = new Set(data.workspaces);
  for (const [workspace, reader] of readers) {
    if (wanted.has(workspace)) continue;
    reader.abort();
    readers.delete(workspace);
  }
  for (const workspace of wanted) {
    if (readers.has(workspace)) continue;
    const reader = new AbortController();
    readers.set(workspace, reader);
    void follow(workspace, reader.signal);
  }
});

void follow(null, new AbortController().signal);

/** Follows the user's stream (`workspace: null`) or one workspace's until `signal` aborts. */
async function follow(workspace: string | null, signal: AbortSignal) {
  let failures = 0;
  let resumed = false;
  while (!signal.aborted) {
    let path: string | null;
    try {
      const streams = await trpcClient().events.streams.query(workspace ? { workspace } : {}, {
        signal,
      });
      path = workspace ? streams.workspace : streams.user;
    } catch {
      path = null;
    }
    if (!path) {
      await sleep(retryDelay(failures++), signal);
      continue;
    }
    if (resumed) scope.postMessage({ type: "gap" });
    resumed = true;

    let delivered = false;
    const end = await readStream<LiveEvent>({
      url: `/api/streams/${path}`,
      offset: "now",
      signal,
      onMessages: (events) => {
        delivered = true;
        const changes = events.filter((event) => event.topic !== "rotate");
        if (changes.length > 0) scope.postMessage({ type: "events", workspace, events: changes });
      },
    });
    if (end === "aborted") return;
    // A rotation is routine; a stream refused or gone without delivering anything backs off.
    failures = delivered || end === "closed" ? 0 : failures + 1;
    if (failures > 0) await sleep(retryDelay(failures - 1), signal);
  }
}
