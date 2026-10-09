import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { readWorkerState, forgetWorkerState } from "./auth/state.js";
import { recoverPendingIdentity, setupWorker } from "./auth/enrollment.js";
import { requestMachineToken } from "./auth/token.js";
import { readSetupCode } from "./cli/prompt.js";
import { connectWorkerControl, type WorkerControlStatus } from "./control.js";
import { password } from "@clack/prompts";
import { consumeEditTasks } from "./tasks.js";
import { WorkerDirectoryEdits } from "./edit/directories.js";

vi.mock("./auth/state.js", () => ({
  defaultStateDirectory: () => "/test/worker",
  credentialStorage: vi.fn().mockResolvedValue("keyring"),
  readWorkerState: vi.fn(),
  forgetWorkerState: vi.fn(),
}));
vi.mock("./auth/enrollment.js", () => ({
  setupWorker: vi.fn(),
  recoverPendingIdentity: vi.fn(),
}));
vi.mock("./auth/token.js", () => ({
  requestMachineToken: vi.fn(),
}));
vi.mock("./control.js", () => ({ connectWorkerControl: vi.fn() }));
vi.mock("./tasks.js", () => ({
  consumeEditTasks: vi.fn(() => ({
    setAvailable: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@clack/prompts", () => ({
  password: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
  intro: vi.fn(),
  confirm: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const diagnostics = () => ({
  socketConnected: false,
  authenticated: false,
  identityAvailable: false,
  tokenExchangePending: false,
  connectionRetries: 0,
});

describe("Worker CLI credential lifecycle", () => {
  it("adds a setup code piped on stdin without logging it", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one-time-secret\n"));
        controller.close();
      },
    });
    vi.stubGlobal("Bun", { stdin: { stream: vi.fn(() => stream) } });
    try {
      await runCli(["add-token", "--state-dir", "/test/custom"]);
    } finally {
      if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
    expect(setupWorker).toHaveBeenCalledWith("/test/custom", "one-time-secret");
    expect(output.mock.calls.flat().join(" ")).not.toContain("one-time-secret");
  });

  it("uses the masked prompt for interactive setup", async () => {
    const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.mocked(password).mockResolvedValue("one-time-secret");
    try {
      await expect(readSetupCode()).resolves.toBe("one-time-secret");
    } finally {
      if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
    expect(password).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Paste the setup code from Chatroom → Workers" }),
    );
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
      setup: {
        backendUrl: "https://test-deployment.convex.site",
        convexUrl: "https://test-deployment.convex.cloud",
      },
      identity: { workerId: "worker-id", workspaceId: "workspace-id" },
      privateKey: { d: "private-secret" },
    } as never);
    await runCli(["status"]);
    const messages = output.mock.calls.flat().join(" ");
    expect(messages).toContain("protected file (not encrypted at rest)");
    expect(output).toHaveBeenCalledWith("Backend: https://test-deployment.convex.site");
    expect(output).toHaveBeenCalledWith("Convex client: https://test-deployment.convex.cloud");
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
    await expect(runCli(["setup", "--setup-file", "/test/setup"])).rejects.toThrow("Unsupported");
    await expect(runCli(["start", "--setup-file", "/test/setup"])).rejects.toThrow("Unsupported");
    await expect(runCli(["status", "--yes"])).rejects.toThrow("Unsupported");
    await expect(runCli(["start", "--port", "3001"])).rejects.toThrow("Unsupported");
    await expect(runCli(["setup", "--edit-root", "/project"])).rejects.toThrow("Unsupported");
    await expect(runCli(["start", "--edit-root", "/project"])).rejects.toThrow("Unsupported");
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

  it.each([false, true])(
    "runs outbound-only and closes control on shutdown (failure: %s)",
    async (fails) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const state = { identity: { workerId: "worker-id" } };
      vi.mocked(readWorkerState).mockResolvedValue(state as never);
      vi.mocked(recoverPendingIdentity).mockResolvedValue(state as never);
      const serve = vi.fn(() => {
        throw new Error("Worker must not start an HTTP server");
      });
      vi.stubGlobal("Bun", { serve });
      const close = fails
        ? vi.fn().mockRejectedValue(new Error("close failed"))
        : vi.fn().mockResolvedValue(undefined);
      vi.mocked(connectWorkerControl).mockClear();
      vi.mocked(connectWorkerControl).mockReturnValue({
        close,
        client: {} as never,
        diagnostics,
      });
      const running = runCli(["start"]);
      const completion = fails
        ? expect(running).rejects.toThrow("close failed")
        : expect(running).resolves.toBeUndefined();
      await vi.waitFor(() => expect(connectWorkerControl).toHaveBeenCalled());
      process.emit("SIGTERM");
      await completion;
      expect(close).toHaveBeenCalled();
      expect(serve).not.toHaveBeenCalled();
    },
  );

  it("consumes backend-directory tasks on start and drains tasks before closing control", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const state = { identity: { workerId: "worker-id" } };
    vi.mocked(readWorkerState).mockResolvedValue(state as never);
    vi.mocked(recoverPendingIdentity).mockResolvedValue(state as never);
    const tasks = { setAvailable: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(consumeEditTasks).mockReturnValue(tasks);
    vi.mocked(consumeEditTasks).mockClear();
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectWorkerControl).mockImplementation((_state, onStatus) => {
      onStatus({ status: "connected", worker: {} as never });
      return { client: {} as never, close, diagnostics };
    });
    const running = runCli(["start"]);
    await vi.waitFor(() => expect(consumeEditTasks).toHaveBeenCalled());
    expect(vi.mocked(consumeEditTasks).mock.calls[0]?.[1]).toBeInstanceOf(WorkerDirectoryEdits);
    expect(tasks.setAvailable).toHaveBeenLastCalledWith(true);
    process.emit("SIGTERM");
    await running;
    expect(tasks.close).toHaveBeenCalledTimes(1);
    expect(tasks.close.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]!,
    );
  });

  it("prints deduplicated, actionable disconnect reasons without exposing auth details", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const state = { identity: { workerId: "worker-id" } };
    vi.mocked(readWorkerState).mockResolvedValue(state as never);
    vi.mocked(recoverPendingIdentity).mockResolvedValue(state as never);
    let reportStatus: ((status: WorkerControlStatus) => void) | undefined;
    vi.mocked(connectWorkerControl).mockImplementation((_state, onStatus) => {
      reportStatus = onStatus;
      return { client: {} as never, close: vi.fn().mockResolvedValue(undefined), diagnostics };
    });

    const running = runCli(["start"]);
    await vi.waitFor(() => expect(consumeEditTasks).toHaveBeenCalled());
    reportStatus?.({ status: "disconnected", reason: "token_http_failed" });
    reportStatus?.({ status: "disconnected", reason: "token_http_failed" });
    reportStatus?.({ status: "disconnected", reason: "verifier_auth_rejected" });
    reportStatus?.({ status: "disconnected", reason: "identity_unavailable" });
    reportStatus?.({ status: "disconnected", reason: "transport" });

    process.emit("SIGTERM");
    await running;

    const messages = output.mock.calls.flat().join("\n");
    expect(
      output.mock.calls.flat().filter((message) => String(message).includes("token_http_failed")),
    ).toHaveLength(1);
    expect(messages).toContain("run `refresh` to test token issuance");
    expect(messages).toContain("backend issuer, Convex JWT verifier issuer/audience");
    expect(messages).toContain("Chatroom → Workers");
    expect(messages).toContain("network, proxy, or firewall");
    expect(messages).not.toContain("access-token-value");
  });

  it("reports stalled startup stages and stops diagnostics after shutdown", async () => {
    vi.useFakeTimers();
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const state = { identity: { workerId: "worker-id" } };
    vi.mocked(readWorkerState).mockResolvedValue(state as never);
    vi.mocked(recoverPendingIdentity).mockResolvedValue(state as never);
    const snapshot = vi.fn(diagnostics);
    vi.mocked(connectWorkerControl).mockImplementation((_state, report) => {
      report({ status: "disconnected", reason: "connecting" });
      return {
        client: {} as never,
        diagnostics: snapshot,
        close: vi.fn().mockResolvedValue(undefined),
      };
    });
    const running = runCli(["start"]);
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith("Worker control connecting."));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(output.mock.calls.flat().join("\n")).toContain(
      "socket=closed, auth=pending, identity=pending, tokenExchange=idle, socketRetries=0",
    );
    process.emit("SIGTERM");
    await running;
    const calls = snapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(snapshot).toHaveBeenCalledTimes(calls);
  });
});
