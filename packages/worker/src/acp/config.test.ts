import { afterEach, describe, expect, it, vi } from "vitest";
import { forbiddenAgentEnv, type AcpAgentDefinition } from "backend/src/acp/contract";
import { agentEnvironment } from "./config.js";

const definition: AcpAgentDefinition = {
  agentId: "test",
  name: "Test",
  command: "agent",
  args: [],
  env: [],
  enabled: true,
  source: "custom",
};
afterEach(() => vi.unstubAllEnvs());

describe("agent launch environment", () => {
  it("refuses loader, lookup, proxy and trust overrides case-insensitively", () => {
    for (const name of [
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
      expect(forbiddenAgentEnv(name)).toBe(true);
      expect(() => agentEnvironment({ ...definition, env: [{ name, value: "unsafe" }] })).toThrow(
        "Unsafe environment key",
      );
    }
  });
  it("does not inherit machine configuration or tokens but retains agent credentials", () => {
    vi.stubEnv("RADIUM_WORKER_TOKEN", "machine-secret");
    vi.stubEnv("CONVEX_URL", "machine-url");
    vi.stubEnv("ANTHROPIC_API_KEY", "agent-key");
    const environment = agentEnvironment({
      ...definition,
      env: [{ name: "AGENT_COLOR", value: "blue" }],
    });
    expect(environment.RADIUM_WORKER_TOKEN).toBeUndefined();
    expect(environment.CONVEX_URL).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBe("agent-key");
    expect(environment.AGENT_COLOR).toBe("blue");
  });
});
