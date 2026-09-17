import { describe, expect, test } from "bun:test";

import { selectWorkspace } from "./selection";

const workspaces = [{ _id: "first" }, { _id: "second" }];

describe("workspace selection", () => {
  test("falls back to the first workspace when no IDs are set", () => {
    expect(selectWorkspace(workspaces, undefined, undefined)).toEqual(workspaces[0]);
  });

  test("keeps a newly created selection pending until it appears", () => {
    expect(selectWorkspace(workspaces, "created", "created")).toBeUndefined();
  });

  test("falls back when a stored selection is no longer accessible", () => {
    expect(selectWorkspace(workspaces, "removed", undefined)).toEqual(workspaces[0]);
  });

  test("prefers an accessible preferred workspace", () => {
    expect(selectWorkspace(workspaces, "second", undefined)).toEqual(workspaces[1]);
  });
});
