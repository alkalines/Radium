import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { acpAgentDefinitionError, type AcpAgentDefinition } from "backend/src/acp/contract";
import { agentReport, probeAgent } from "./process.js";

vi.mock("node:child_process", async (original) => {
  const module = await original<typeof ChildProcess>();
  return { ...module, spawn: vi.fn(module.spawn) };
});

const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const script = fileURLToPath(new URL("./test-agent.ts", import.meta.url));
const definition: AcpAgentDefinition = {
  agentId: "scripted",
  name: "Owner's name",
  command: "bun",
  args: [script],
  env: [],
  enabled: true,
  source: "registry",
  icon: "https://example.com/icon.svg",
  version: "fallback",
};
const directories: string[] = [];
beforeEach(() => {
  vi.mocked(spawn).mockClear();
  // Vitest executes under Node; the Worker itself uses Bun's native PATH lookup.
  vi.stubGlobal("Bun", { which: vi.fn((command: string) => (command === "bun" ? bun : null)) });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("ACP executable discovery", () => {
  it("reports a missing command unavailable without spawning", async () => {
    const report = await probeAgent({ ...definition, command: "missing-agent" });
    expect(Bun.which).toHaveBeenCalledWith("missing-agent");
    expect(report).toMatchObject({
      status: "unavailable",
      error: "missing-agent was not found on this Worker's PATH",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports an absolute non-executable file unavailable without spawning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "radium-acp-command-"));
    directories.push(directory);
    const command = join(directory, "agent");
    await writeFile(command, "not executable");
    await chmod(command, 0o600);
    expect(await probeAgent({ ...definition, command })).toMatchObject({
      status: "unavailable",
      error: `${command} was not found on this Worker's PATH`,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(Bun.which).not.toHaveBeenCalled();
  });

  it("probes a present PATH command and preserves the definition's display metadata", async () => {
    const report = await probeAgent(definition);
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(bun);
    expect(report).toMatchObject({
      agentId: "scripted",
      name: "Owner's name",
      status: "ready",
      source: "registry",
      icon: definition.icon,
      capabilities: { loadSession: true },
    });
    expect(report.version).not.toBe("fallback");
    expect(agentReport(definition).version).toBe("fallback");
  });

  it("reports an invalid definition failed with shared validation and never spawns", async () => {
    const invalid = { ...definition, env: [{ name: "PATH", value: "/tmp" }] };
    expect(await probeAgent(invalid)).toMatchObject({
      status: "failed",
      error: acpAgentDefinitionError(invalid),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(Bun.which).not.toHaveBeenCalled();
  });
});
