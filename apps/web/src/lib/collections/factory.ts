import { useEffect, useState, useSyncExternalStore } from "react";
import {
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { createCollection, type Collection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

import { authClient } from "@/lib/auth-client";
import { relaySync, shapeSinks } from "@/lib/live-relay";
import { useTrpc } from "@/lib/trpc";
import {
  shapeDefinition,
  shapeId,
  type ShapeName,
  type ShapeRows,
  type ShapeSelector,
} from "./shapes";

/**
 * Synced collections (`docs/Backend_Migration/Live_Data.md`, Electric Collections). Each one is a
 * shape (`./shapes.ts`) plus its tRPC query. When the deployment runs Electric (`events.config`)
 * and the page was served over HTTP/2 or HTTP/3, the collection is fed by the user's leader Tab,
 * which syncs the shape for every Tab (`lib/live-relay.ts`); otherwise it is the tRPC query, whose
 * key the invalidation events (`lib/live-events.ts`) already refresh. Components read either one
 * with `useLiveQuery` and stay the same. Collections are read-only views: writes stay tRPC
 * mutations, and their effect arrives through the shape or the refetch.
 */

/** One collection's shape and its tRPC source; rows are shape `N`'s. */
export type CollectionSource<N extends ShapeName, TData> = {
  /** The server-defined shape, `/api/shapes/<shape>`. */
  shape: N;
  /** The shape's selector; part of the collection's identity. */
  selector: ShapeSelector;
  /**
   * The tRPC query's key (or a key under its router, for rows built from several). The
   * collection's cache entry appends `"collection"`: the same router path and input, so the
   * invalidation events and `pathKey()` invalidations refresh it, but an entry of its own, because
   * a query collection removes its entry when it is cleaned up, even under other observers.
   */
  queryKey: QueryKey;
  queryFn: () => Promise<TData>;
  select: (data: TData) => ShapeRows[N][];
};

/** How long a collection nobody reads keeps syncing, so quick navigation reuses it. */
const RELEASE_MS = 30_000;

type Entry = {
  userId: string;
  collection: Collection<object, string | number>;
  readers: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** Live collections of this Tab by identity (user, source kind, shape, selector). */
const collections = new Map<string, Entry>();

function retire(id: string, entry: Entry) {
  clearTimeout(entry.timer);
  collections.delete(id);
  void entry.collection.cleanup();
}

const noSubscription = () => () => {};

/** Whether this page reached the web origin over HTTP/2 or HTTP/3. */
function multiplexedOrigin() {
  const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return navigation?.nextHopProtocol === "h2" || navigation?.nextHopProtocol === "h3";
}

/**
 * The collection of `source` for the signed-in user, or `undefined` while signed out, before
 * hydration (never during server rendering), while the deployment's sync config loads, or when
 * `source` is `undefined`. Collections are shared by identity; one nobody reads is cleaned up
 * shortly after, and every collection of a previous account as soon as another signs in.
 */
export function useCollection<N extends ShapeName, TData>(
  source: CollectionSource<N, TData> | undefined,
): Collection<ShapeRows[N], string | number> | undefined {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const { data: config } = useQuery(
    trpc.events.config.queryOptions(userId && hydrated ? undefined : skipToken, {
      staleTime: Infinity,
    }),
  );
  // Each shape is a held long-poll. Over HTTP/1.1 (6 connections per origin, shared by every Tab)
  // the shapes and the event streams together would starve all other requests, so Electric is
  // used only on a multiplexed connection; otherwise the collections are tRPC queries.
  const electric = config === undefined ? undefined : config.electric && multiplexedOrigin();
  const id =
    source && userId && electric !== undefined
      ? `${userId}:${electric ? "electric" : "query"}:${shapeId(source.shape, source.selector)}`
      : undefined;
  const [current, setCurrent] = useState<{
    id: string;
    collection: Collection<ShapeRows[N], string | number>;
  }>();

  useEffect(() => {
    if (!id || !source || !userId || electric === undefined) return;
    for (const [other, entry] of collections) {
      if (entry.userId !== userId) retire(other, entry);
    }
    let entry = collections.get(id);
    if (!entry) {
      // Entries hold collections of different row types; each is only read back through the
      // row type of the source that created it.
      const erased = source as unknown as CollectionSource<ShapeName, unknown>;
      entry = {
        userId,
        collection: createSourceCollection(id, erased, electric, queryClient),
        readers: 0,
      };
      collections.set(id, entry);
    }
    clearTimeout(entry.timer);
    entry.readers += 1;
    const acquired = entry;
    setCurrent({
      id,
      collection: acquired.collection as unknown as Collection<ShapeRows[N], string | number>,
    });
    return () => {
      acquired.readers -= 1;
      if (acquired.readers === 0)
        acquired.timer = setTimeout(() => retire(id, acquired), RELEASE_MS);
    };
    // `id` names everything the collection is built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return id && current?.id === id ? current.collection : undefined;
}

function createSourceCollection(
  id: string,
  source: CollectionSource<ShapeName, unknown>,
  electric: boolean,
  queryClient: QueryClient,
): Collection<object, string | number> {
  const { getKey } = shapeDefinition(source.shape);
  if (electric) {
    return createCollection<object, string | number>({
      id,
      getKey,
      sync: { sync: relaySync(shapeSinks, shapeId(source.shape, source.selector), getKey) },
    });
  }
  const collection = createCollection(
    queryCollectionOptions({
      id,
      queryClient,
      queryKey: [...source.queryKey, "collection"],
      queryFn: source.queryFn,
      select: (data: unknown) => source.select(data) as object[],
      getKey,
    }),
  );
  return collection as unknown as Collection<object, string | number>;
}
