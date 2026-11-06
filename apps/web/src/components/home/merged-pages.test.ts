import { describe, expect, test } from "bun:test";

import { mergePages, type PageStatus } from "./merged-pages";

const source = (items: number[], status: PageStatus) => ({ items, status });
const at = (item: number) => item;

describe("mergePages", () => {
  test("holds back rows older than the last loaded row of a source that can still load", () => {
    const merged = mergePages(
      [source([90, 50, 40], "Exhausted"), source([80, 60], "CanLoadMore")],
      at,
      10,
    );
    // An unloaded row of the second source could still be newer than 50.
    expect(merged.items).toEqual([90, 80, 60]);
    expect(merged.next).toBe(1);
    expect(merged.hasMore).toBe(true);
  });

  test("the newest last row among loadable sources limits the list", () => {
    const merged = mergePages(
      [source([95, 70], "CanLoadMore"), source([90, 85], "CanLoadMore")],
      at,
      10,
    );
    expect(merged.items).toEqual([95, 90, 85]);
    expect(merged.next).toBe(1);
  });

  test("a loadable source without rows blocks every row until it loads", () => {
    const merged = mergePages([source([90], "Exhausted"), source([], "CanLoadMore")], at, 10);
    expect(merged.items).toEqual([]);
    expect(merged.next).toBe(1);
  });

  test("exhausted sources show everything up to the limit", () => {
    const merged = mergePages([source([9, 5], "Exhausted"), source([7, 1], "Exhausted")], at, 3);
    expect(merged.items).toEqual([9, 7, 5]);
    expect(merged.next).toBeNull();
    expect(merged.hasMore).toBe(true);
    expect(mergePages([source([9], "Exhausted")], at, 3)).toMatchObject({
      hasMore: false,
      next: null,
    });
  });

  test("waits for every first page", () => {
    expect(
      mergePages([source([9], "Exhausted"), source([], "LoadingFirstPage")], at, 3),
    ).toMatchObject({ items: [], loading: true });
  });

  test("a full list loads nothing more until the limit grows", () => {
    const merged = mergePages([source([9, 8, 7, 6], "CanLoadMore")], at, 3);
    expect(merged.items).toEqual([9, 8, 7]);
    expect(merged.next).toBeNull();
    expect(merged.hasMore).toBe(true);
  });
});
