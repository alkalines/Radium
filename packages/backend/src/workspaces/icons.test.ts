import { describe, expect, test } from "vitest";
import { DEFAULT_WORKSPACE_ICON, isWorkspaceIconName, resolveWorkspaceIconName } from "./icons";

describe("workspace icons", () => {
  test("accepts supported icon keys", () => {
    expect(isWorkspaceIconName("rocket")).toBe(true);
    expect(resolveWorkspaceIconName("rocket")).toBe("rocket");
  });

  test("falls back for missing or retired icon keys", () => {
    expect(resolveWorkspaceIconName()).toBe(DEFAULT_WORKSPACE_ICON);
    expect(resolveWorkspaceIconName("unknown")).toBe(DEFAULT_WORKSPACE_ICON);
  });
});
