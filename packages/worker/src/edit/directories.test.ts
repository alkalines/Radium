import { expect, test, vi } from "vitest";
import { WorkerDirectoryEdits } from "./directories.js";

const loadNative = vi.hoisted(() => vi.fn());
vi.mock("./service.js", () => {
  loadNative();
  throw new Error("Native runtime must remain unloaded");
});

test("legacy and invalid directory instructions cannot use a local working-directory fallback", async () => {
  const editor = new WorkerDirectoryEdits();
  const request = { sessionId: "session", action: { kind: "read" as const, path: "file.txt" } };
  expect(JSON.parse(await editor.execute(request))).toMatchObject({
    ok: false,
    code: "DIRECTORY_REQUIRED",
  });
  expect(
    JSON.parse(await editor.execute({ ...request, directory: "relative/project" })),
  ).toMatchObject({ ok: false, code: "DIRECTORY_INVALID" });
  expect(loadNative).not.toHaveBeenCalled();
  await editor.close();
});
