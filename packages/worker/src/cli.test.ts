import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { readWorkerState, forgetWorkerState } from "./state.js";
import { recoverPendingIdentity, requestMachineToken, setupWorker } from "./auth.js";
import { readSetupCodeFromFile } from "./input.js";
import { connectWorkerControl } from "./control.js";

vi.mock("./state.js", () => ({
  defaultStateDirectory: () => "/test/worker",
  credentialStorage: vi.fn().mockResolvedValue("keyring"),
  readWorkerState: vi.fn(),
  forgetWorkerState: vi.fn(),
}));
vi.mock("./auth.js", () => ({
  setupWorker: vi.fn(),
  recoverPendingIdentity: vi.fn(),
  requestMachineToken: vi.fn(),
}));
vi.mock("./input.js", () => ({
  readSetupCodeFromFile: vi.fn(),
  readSetupCodeFromStdin: vi.fn(),
}));
vi.mock("./control.js", () => ({ connectWorkerControl: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Worker CLI credential lifecycle", () => {
  it("adds a setup code from a protected source without logging it", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(readSetupCodeFromFile).mockResolvedValue("one-time-secret");
    await runCli(["add-token", "--setup-file", "/test/setup", "--state-dir", "/test/custom"]);
    expect(setupWorker).toHaveBeenCalledWith("/test/custom", "one-time-secret");
    expect(output.mock.calls.flat().join(" ")).not.toContain("one-time-secret");
  });

  it("refreshes pending identity without printing the access token", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pending = { setup: { backendUrl: "https://backend.example" } };
    const completed = { ...pending, identity: { workerId: "worker-id" } };
    vi.mocked(readWorkerState).mockResolvedValue(pending as never);
    vi.mocked(recoverPendingIdentity).mockResolvedValue(completed as never);
    vi.mocked(requestMachineToken).mockResolvedValue({
      token: "access-secret",
      expiresAt: 2_000_000_000_000,
    });
    await runCli(["refresh"]);
    expect(recoverPendingIdentity).toHaveBeenCalledWith("/test/worker", pending);
    expect(requestMachineToken).toHaveBeenCalledWith(completed);
    expect(output.mock.calls.flat().join(" ")).toContain("Authentication succeeded");
    expect(output.mock.calls.flat().join(" ")).not.toContain("access-secret");
  });

  it("reports local status without exchanging credentials", async () => {
    vi.mocked(requestMachineToken).mockClear();
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(readWorkerState).mockResolvedValue(null);
    await runCli(["status"]);
    expect(output).toHaveBeenCalledWith("Worker is not configured.");
    expect(requestMachineToken).not.toHaveBeenCalled();
  });

  it("reports file storage without exposing the hydrated private key", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(readWorkerState).mockResolvedValue({
      credentialStoreMode: "file",
      setup: { backendUrl: "https://backend.example" },
      identity: { workerId: "worker-id", workspaceId: "workspace-id" },
      privateKey: { d: "private-secret" },
    } as never);
    await runCli(["status"]);
    const messages = output.mock.calls.flat().join(" ");
    expect(messages).toContain("protected file (not encrypted at rest)");
    expect(messages).not.toContain("private-secret");
  });

  it("forgets credentials using the explicit non-interactive confirmation", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(forgetWorkerState).mockClear();
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await expect(runCli(["forget"])).rejects.toThrow("Use --yes");
      expect(forgetWorkerState).not.toHaveBeenCalled();
    }
    await runCli(["forget-token", "--yes", "--state-dir", "/test/custom"]);
    expect(forgetWorkerState).toHaveBeenCalledWith("/test/custom");
  });

  it("rejects secrets as CLI arguments and flags for the wrong command", async () => {
    await expect(runCli(["setup", "secret"])).rejects.toThrow("Unsupported");
    await expect(runCli(["start", "--setup-file", "/test/setup"])).rejects.toThrow("Unsupported");
    await expect(runCli(["status", "--yes"])).rejects.toThrow("Unsupported");
    await expect(runCli(["start", "--port", "0"])).rejects.toThrow("Port");
  });

  it("accepts a leading package-script separator without losing state options", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.mocked(readWorkerState).mockResolvedValue(null);
    await runCli(["--", "status", "--", "--state-dir", "/test/custom"]);
    expect(readWorkerState).toHaveBeenCalledWith("/test/custom");
  });

  it("rejects invisible terminal prompts when stdout is redirected", async () => {
    const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await expect(runCli([])).rejects.toThrow("Choose a command");
      await expect(runCli(["setup"])).rejects.toThrow("stdout is redirected");
      await expect(runCli(["forget"])).rejects.toThrow("Use --yes");
    } finally {
      if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("stops the health server and handles control shutdown rejection", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const state = { identity: { workerId: "worker-id" } };
    vi.mocked(readWorkerState).mockResolvedValue(state as never);
    vi.mocked(recoverPendingIdentity).mockResolvedValue(state as never);
    const stop = vi.fn();
    vi.stubGlobal("Bun", { serve: vi.fn(() => ({ stop })) });
    vi.mocked(connectWorkerControl).mockClear();
    vi.mocked(connectWorkerControl).mockReturnValue({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
      client: {} as never,
    });
    const running = runCli(["start"]);
    const failure = expect(running).rejects.toThrow("close failed");
    await vi.waitFor(() => expect(connectWorkerControl).toHaveBeenCalled());
    process.emit("SIGTERM");
    await failure;
    expect(stop).toHaveBeenCalledWith(true);
  });
});
