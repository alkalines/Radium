import { useEffect, useState } from "react";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";

import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { authClient } from "@/lib/auth-client";
import { startLiveRelay, type LiveEvent, type LiveRelayHandle } from "@/lib/live-relay";

/**
 * Queries other than the topic's own router that show what an event names. Notification
 * preferences are read with the model preferences (`lib/collections/user-preferences.ts`).
 */
const ALSO_INVALIDATES: Record<string, string[][]> = {
  providers: [["models"]],
  chats: [["usage", "getChatCost"]],
  notifications: [["preferences", "all"]],
};

/** Input fields that name the record a query reads; events with `ids` refetch only those. */
const ID_FIELDS = ["chatId", "chat", "id"] as const;

/**
 * Applies the signed-in user's invalidation events (`docs/Backend_Migration/Live_Data.md`,
 * Invalidation Events) to this Tab's queries. The events are read once for all of the user's Tabs
 * by the leader Tab (`lib/live-relay.ts`): the user's stream, and the stream of every workspace a
 * Tab shows. Each event invalidates the tRPC queries of its topic (narrowed to `ids` when it names
 * them), and TanStack Query refetches only the mounted ones; a Tab applies the events of the user
 * stream and of the workspace it shows. A stream that was rotated, lost, or read by a new leader
 * may have missed events, so every tRPC query is invalidated once then.
 *
 * Mounted once in the signed-in app shell; nothing is read while signed out, the relay restarts
 * on account change (the cache is dropped then), and a workspace switch changes what this Tab
 * asks the leader for.
 */
export function LiveEvents(): null {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const { workspaceId } = useWorkspace();
  const [relay, setRelay] = useState<LiveRelayHandle>();

  useEffect(() => {
    if (!userId) return;
    const handle = startLiveRelay({
      userId,
      onEvents: (events) => invalidateEvents(queryClient, events),
      // Every tRPC query (their keys start with the procedure path; Convex's are left alone).
      onGap: () =>
        void queryClient.invalidateQueries({
          predicate: (query) => Array.isArray(query.queryKey[0]),
        }),
    });
    setRelay(handle);
    return () => {
      handle.stop();
      setRelay(undefined);
    };
  }, [queryClient, userId]);

  useEffect(() => {
    relay?.setWorkspaces(workspaceId ? [workspaceId] : []);
  }, [relay, workspaceId]);

  return null;
}

/** Invalidates, in one pass, every tRPC query that one of `events` names. */
function invalidateEvents(queryClient: QueryClient, events: readonly LiveEvent[]) {
  const targets = events.map((event) => ({
    paths: [[event.topic], ...(ALSO_INVALIDATES[event.topic] ?? [])],
    ids: event.ids && event.ids.length > 0 ? new Set(event.ids) : undefined,
  }));
  void queryClient.invalidateQueries({
    predicate: (query) => targets.some((target) => matches(query, target.paths, target.ids)),
  });
}

/**
 * Whether tRPC query `query` (key `[path, { input, type }]`) is under one of `paths` and, when
 * `ids` are given and its input names a record, reads one of them. Queries whose input names no
 * record (lists, settings) always match their topic.
 */
function matches(query: Query, paths: string[][], ids: Set<string> | undefined) {
  const [path, options] = query.queryKey;
  if (!Array.isArray(path)) return false;
  if (!paths.some((prefix) => prefix.every((part, index) => path[index] === part))) return false;
  if (!ids) return true;
  const input =
    typeof options === "object" && options !== null && "input" in options
      ? options.input
      : undefined;
  if (typeof input !== "object" || input === null) return true;
  let namesRecord = false;
  for (const field of ID_FIELDS) {
    const value: unknown = Reflect.get(input, field);
    if (typeof value !== "string") continue;
    if (ids.has(value)) return true;
    namesRecord = true;
  }
  return !namesRecord;
}
