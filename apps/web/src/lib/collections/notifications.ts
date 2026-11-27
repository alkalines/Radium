import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";

import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";
import { useCollection, type CollectionSource } from "./factory";
import { plainRow, type NotificationRow } from "./shapes";

/** Notifications open Tabs read, newest first (`notifications.recent`'s limit). */
const RECENT_LIMIT = 20;

/**
 * The signed-in user's recent notifications, newest first, or `undefined` until loaded (and
 * while `enabled` is off). Rows read at load are history; only later arrivals notify.
 */
export function useRecentNotifications(enabled: boolean): NotificationRow[] | undefined {
  const trpc = useTrpc();
  const source = useMemo(
    (): CollectionSource<"notifications", NotificationRow[]> | undefined =>
      enabled
        ? {
            shape: "notifications",
            selector: {},
            queryKey: trpc.notifications.recent.queryKey(),
            queryFn: () => trpcClient().notifications.recent.query(),
            select: (rows) => rows,
          }
        : undefined,
    [enabled, trpc],
  );
  const collection = useCollection(source);
  const { data, isReady } = useLiveQuery((q) =>
    collection
      ? q
          .from({ notification: collection })
          .orderBy(({ notification }) => notification.createdAt, "desc")
          .orderBy(({ notification }) => notification.id, "desc")
          .limit(RECENT_LIMIT)
      : undefined,
  );
  return useMemo(
    () => (collection && isReady && data ? data.map(plainRow) : undefined),
    [collection, data, isReady],
  );
}
