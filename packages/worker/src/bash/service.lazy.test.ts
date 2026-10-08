import { expect, test, vi } from "vitest";
import { createBashExecutor } from "./service.js";

const loadNative = vi.hoisted(() => vi.fn());
vi.mock("@oh-my-pi/pi-natives", () => {
  loadNative();
  return { Shell: class {} };
});

test("construction and invalid requests do not load the native shell package", async () => {
  const executor = createBashExecutor();
  expect(loadNative).not.toHaveBeenCalled();

  const output = await executor.execute({
    directory: "/tmp",
    sessionId: "lazy-shell",
    command: "echo invalid-timeout",
    timeoutSeconds: 31,
  });
  expect(JSON.parse(output)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  expect(loadNative).not.toHaveBeenCalled();

  await executor.close();
  expect(loadNative).not.toHaveBeenCalled();
});
