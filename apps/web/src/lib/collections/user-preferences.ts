import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { resolveNotificationPreferences } from "contracts/notifications/contract";

import { useAccount } from "@/lib/use-account";
import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";
import { useCollection, type CollectionSource } from "./factory";
import { plainRow, type UserPreferences } from "./shapes";

const DEFAULT_PREFERENCES: Omit<UserPreferences, "id"> = {
  pinnedModels: [],
  hiddenModels: [],
  notifications: resolveNotificationPreferences(undefined),
};

/** The query source's key: one row read from two procedures, so neither one's own key. */
export const PREFERENCES_KEY = [["preferences", "all"], { type: "query" }];

/**
 * The signed-in user's preferences, or `undefined` until loaded (or signed out). A user without a
 * row reads the defaults. Without Electric they come from `preferences.get` and
 * `notifications.getPreferences`, under a key both routers' events refresh (`lib/live-events.ts`).
 */
export function useUserPreferences(): Omit<UserPreferences, "id"> | undefined {
  const trpc = useTrpc();
  const { signedIn } = useAccount();
  const source = useMemo(
    (): CollectionSource<"userPreferences", UserPreferences> | undefined =>
      signedIn
        ? {
            shape: "userPreferences",
            selector: {},
            // Under the `preferences` router, so its events refresh it; `notifications` events
            // refresh it too (`lib/live-events.ts`).
            queryKey: PREFERENCES_KEY,
            queryFn: async () => {
              const [models, notifications] = await Promise.all([
                trpcClient().preferences.get.query(),
                trpcClient().notifications.getPreferences.query(),
              ]);
              return { id: "preferences", ...models, notifications };
            },
            select: (row) => [row],
          }
        : undefined,
    [signedIn, trpc],
  );
  const collection = useCollection(source);
  const { data, isReady } = useLiveQuery((q) =>
    collection ? q.from({ preferences: collection }).findOne() : undefined,
  );
  return useMemo(() => {
    if (!collection || !isReady) return undefined;
    return data ? plainRow(data) : DEFAULT_PREFERENCES;
  }, [collection, data, isReady]);
}
