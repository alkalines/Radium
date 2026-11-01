import { useEffect, useRef, useState } from "react";

/** Rows Home shows at first and adds with each `Load more`. */
export const HOME_PAGE_SIZE = 50;

export type PageStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

/** One newest-first paginated list, as returned by `usePaginatedQuery`. */
export type PagedSource<T> = {
  items: readonly T[];
  status: PageStatus;
  loadMore: (numItems: number) => void;
};

export type MergedPages<T> = {
  /** The newest `limit` rows that are certainly in order, newest first. */
  items: T[];
  /** A source has not returned its first page yet. */
  loading: boolean;
  /** More rows exist beyond `items`, loaded or not. */
  hasMore: boolean;
  /** The source to load next to reach `limit`, if any. */
  next: number | null;
};

/**
 * Merges newest-first paginated sources into one newest-first list without gaps. A row is shown
 * only when no source that can still load could hold a newer one: every unloaded row of a source
 * is at most as recent as its last loaded row, so the cut-off is the newest such "last row"
 * among the sources that are not exhausted (an unloaded source with no rows blocks everything).
 * `next` names that limiting source when fewer than `limit` rows can be shown.
 */
export function mergePages<T>(
  sources: readonly Pick<PagedSource<T>, "items" | "status">[],
  at: (item: T) => number,
  limit: number,
): MergedPages<T> {
  if (sources.some((source) => source.status === "LoadingFirstPage")) {
    return { items: [], loading: true, hasMore: false, next: null };
  }
  let cutoff = -Infinity;
  let blocker: number | null = null;
  for (const [index, source] of sources.entries()) {
    if (source.status === "Exhausted") continue;
    const last = source.items.at(-1);
    const oldest = last === undefined ? Infinity : at(last);
    if (oldest > cutoff) {
      cutoff = oldest;
      blocker = index;
    }
  }
  const ordered = sources
    .flatMap((source) => source.items)
    .filter((item) => at(item) >= cutoff)
    .sort((a, b) => at(b) - at(a));
  return {
    items: ordered.slice(0, limit),
    loading: false,
    hasMore: ordered.length > limit || blocker !== null,
    next: ordered.length < limit ? blocker : null,
  };
}

/**
 * `mergePages` with a growing limit: starts at `HOME_PAGE_SIZE` rows, loads whichever source
 * limits the list until it holds that many, and adds `HOME_PAGE_SIZE` per `showMore`. Key the
 * calling component by its filters so a new filter starts back at one page.
 */
export function useMergedPages<T>(sources: readonly PagedSource<T>[], at: (item: T) => number) {
  const [limit, setLimit] = useState(HOME_PAGE_SIZE);
  const merged = mergePages(sources, at, limit);
  const next = merged.next === null ? undefined : sources[merged.next];
  const latest = useRef(next);
  latest.current = next;
  const nextStatus = next?.status;
  const nextCount = next?.items.length;

  useEffect(() => {
    if (latest.current?.status === "CanLoadMore") latest.current.loadMore(HOME_PAGE_SIZE);
  }, [merged.next, nextStatus, nextCount]);

  return {
    ...merged,
    /** Loading toward the current limit. */
    loadingMore: next !== undefined,
    showMore: () => setLimit((current) => current + HOME_PAGE_SIZE),
  };
}
