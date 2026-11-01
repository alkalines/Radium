import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentEnvironment, forbiddenAgentEnv, readAgentDefinitions } from "./config.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function state(value?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "radium-acp-config-"));
  directories.push(directory);
  if (value !== undefined) await writeFile(join(directory, "agents.json"), JSON.stringify(value));
  return directory;
}

describe("local agent launch policy", () => {
  it("accepts missing config and validates unique local executable definitions", async () => {
    expect(await readAgentDefinitions(await state())).toEqual([]);
    const agents = [
      { id: "test.agent", command: "bun", args: ["agent.ts"], env: { API_KEY: "agent-secret" } },
    ];
    expect(await readAgentDefinitions(await state({ agents }))).toEqual(agents);
    await expect(
      readAgentDefinitions(await state({ agents: [...agents, ...agents] })),
    ).rejects.toThrow("unique");
    await expect(
      readAgentDefinitions(await state({ agents: [{ id: "../bad", command: "bun" }] })),
    ).rejects.toThrow("valid");
  });
  it("refuses loader, lookup, proxy and trust overrides case-insensitively", async () => {
    for (const key of [
      "Path",
      "LD_PRELOAD",
      "dyld_insert_libraries",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "HTTPS_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "PYTHONPATH",
      "PYTHONHOME",
      "RUBYOPT",
      "PERL5OPT",
      "BUN_OPTIONS",
      "RADIUM_PRIVATE_KEY",
      "CONVEX_URL",
    ]) {
      expect(forbiddenAgentEnv(key)).toBe(true);
      await expect(
        readAgentDefinitions(
          await state({ agents: [{ id: "test", command: "bun", env: { [key]: "unsafe" } }] }),
        ),
      ).rejects.toThrow("Unsafe environment key");
    }
  });
  it("does not inherit machine configuration or tokens but retains agent credentials", () => {
    vi.stubEnv("RADIUM_WORKER_TOKEN", "machine-secret");
    vi.stubEnv("CONVEX_URL", "machine-url");
    vi.stubEnv("ANTHROPIC_API_KEY", "agent-key");
    const environment = agentEnvironment({
      id: "test",
      command: "agent",
      env: { AGENT_COLOR: "blue" },
    });
    expect(environment.RADIUM_WORKER_TOKEN).toBeUndefined();
    expect(environment.CONVEX_URL).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBe("agent-key");
    expect(environment.AGENT_COLOR).toBe("blue");
  });
});
