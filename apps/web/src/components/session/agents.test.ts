import { describe, expect, test } from "bun:test";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  agentAvailability,
  agentListed,
  builtInAgent,
  firstReadyWorker,
  restoreAgentId,
  sessionAgentById,
  workspaceAgents,
  type SessionAgentDefinition,
  type SessionAgentRow,
  type SessionWorker,
} from "./agents";
import { readTabState } from "./tab-state";

const definition: SessionAgentDefinition = {
  _id: "definition" as Id<"acp_agents">,
  agentId: "codex",
  name: "Codex",
  command: "codex",
  args: [],
  env: [],
  enabled: true,
  source: "custom",
  updatedAt: 0,
};
const now = 100_000;
function worker(
  workerId: string,
  lastSeenAt: number | undefined = now,
  access: SessionWorker["gateway"]["access"] = "off",
): SessionWorker {
  return {
    workerId,
    name: workerId,
    workspaceId: "workspace",
    status: "active",
    capabilities: [],
    identityEpoch: 0,
    lastSeenAt,
    gateway: { access, telemetry: "workspace" },
  };
}
const gatewayEnv = [{ name: "OPENAI_BASE_URL", value: "{{gateway.url}}" }];
const gatewayDefinition: SessionAgentDefinition = {
  ...definition,
  gateway: { enabled: true, env: gatewayEnv },
};
function report(worker: string, status: SessionAgentRow["status"] = "ready"): SessionAgentRow {
  return {
    _id: `${worker}-agent` as Id<"worker_agents">,
    _creationTime: 0,
    workspace: "workspace" as Id<"workspaces">,
    worker,
    checkedAt: 0,
    agentId: "codex",
    name: "Codex",
    version: "1",
    source: "custom",
    status,
    capabilities: {
      loadSession: true,
      list: true,
      resume: false,
      close: false,
      delete: true,
      fork: false,
      logout: false,
      image: false,
      audio: false,
      embeddedContext: false,
      mcpHttp: false,
      mcpSse: false,
    },
    authMethods: [],
  };
}

describe("workspace ACP agent selection", () => {
  test("Radium stays first and every enabled definition appears without a Worker or report", () => {
    const agents = workspaceAgents(
      [definition, { ...definition, agentId: "disabled", enabled: false }],
      undefined,
      undefined,
    );
    expect(agents.map((agent) => agent.id)).toEqual(["radium", "acp:codex"]);
    expect(sessionAgentById("radium", agents)).toBe(builtInAgent);
    expect(sessionAgentById("acp:codex", agents)).toMatchObject({
      protocol: "acp",
      agentId: "codex",
    });
  });

  test("Worker changes keep the definition selected, even on a missing or failed installation", () => {
    for (const rows of [[], [report("two", "failed")], [report("two", "unavailable")]]) {
      const agents = workspaceAgents([definition], "two", rows);
      expect(sessionAgentById("acp:codex", agents).id).toBe("acp:codex");
    }
    expect(sessionAgentById("acp:missing", workspaceAgents([definition], undefined, []))).toBe(
      builtInAgent,
    );
    expect(
      sessionAgentById(
        "acp:codex",
        workspaceAgents([{ ...definition, enabled: false }], undefined, []),
      ),
    ).toBe(builtInAgent);
  });

  test("installation state is scoped to the selected Worker", () => {
    const agents = workspaceAgents([definition], "two", [
      report("one"),
      report("two", "needs_auth"),
    ]);
    expect(sessionAgentById("acp:codex", agents)).toMatchObject({
      installation: { worker: "two", status: "needs_auth" },
    });
  });

  test("presence and report state matrix", () => {
    const agent = sessionAgentById("acp:codex", workspaceAgents([definition], undefined, []));
    for (const status of ["ready", "needs_auth", "unavailable", "failed"] as const) {
      const rows = [report("one", status)];
      expect(agentAvailability(agent, undefined, now, rows)).toBe("no_worker");
      expect(agentAvailability(agent, worker("one", now - 60_001), now, rows)).toBe("offline");
      expect(agentAvailability(agent, { ...worker("one"), lastSeenAt: undefined }, now, rows)).toBe(
        "offline",
      );
      expect(agentAvailability(agent, worker("one"), now, rows)).toBe(
        status === "ready" ? "ready" : status === "needs_auth" ? "needs_auth" : "unavailable",
      );
    }
    expect(agentAvailability(agent, worker("one"), now, [])).toBe("unavailable");
    expect(
      agentAvailability(agent, { ...worker("one"), status: "revoked" }, now, [report("one")]),
    ).toBe("offline");
    expect(agentAvailability(builtInAgent, undefined, now)).toBe("ready");
  });

  test("auto-selection skips offline, revoked, missing and unauthenticated installations", () => {
    const agent = sessionAgentById("acp:codex", workspaceAgents([definition], undefined, []));
    const workers = [
      worker("offline", 0),
      { ...worker("revoked"), status: "revoked" as const },
      worker("missing"),
      worker("auth"),
      worker("ready"),
      worker("also-ready"),
    ];
    const rows = [
      report("offline"),
      report("revoked"),
      report("auth", "needs_auth"),
      report("ready"),
      report("also-ready"),
    ];
    expect(firstReadyWorker(agent, workers, rows, now)?.workerId).toBe("ready");
    expect(firstReadyWorker(agent, workers.slice(0, 4), rows, now)).toBeUndefined();
  });

  test("old Worker-qualified ids restore to the definition and recover their Worker", () => {
    expect(restoreAgentId("acp:one:codex")).toEqual({ id: "acp:codex", workerId: "one" });
    expect(restoreAgentId("acp:codex")).toEqual({ id: "acp:codex" });
    expect(restoreAgentId("acp::codex")).toEqual({ id: "radium" });
    expect(restoreAgentId("acp:one:codex:extra")).toEqual({ id: "radium" });
    expect(
      sessionAgentById("acp:one:codex", workspaceAgents([definition], "one", [])),
    ).toMatchObject({ id: "acp:codex" });
  });

  test("stored old draft ids migrate with Worker tools intact, without resetting storage", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    const stored = JSON.stringify({
      tab: {
        agentId: "acp:one:codex",
        draft: {
          workspaceId: "workspace",
          scope: "personal",
          worker: { workerId: "different", tools: ["read"] },
          project: null,
          tools: null,
        },
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { getItem: () => stored } },
    });
    try {
      expect(readTabState("tab")).toMatchObject({
        agentId: "acp:codex",
        draft: { worker: { workerId: "one", tools: ["read"] } },
      });
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("a Gateway profile adds its own entry, round-tripped by id", () => {
    expect(
      workspaceAgents(
        [
          { ...gatewayDefinition, gateway: { enabled: false, env: gatewayEnv } },
          { ...gatewayDefinition, agentId: "empty", gateway: { enabled: true, env: [] } },
          { ...gatewayDefinition, agentId: "disabled", enabled: false },
        ],
        undefined,
        [],
      ).map((agent) => agent.id),
    ).toEqual(["radium", "acp:codex", "acp:empty"]);

    const agents = workspaceAgents([gatewayDefinition], "one", [report("one")]);
    expect(agents.map((agent) => agent.id)).toEqual(["radium", "acp:codex", "acp-gateway:codex"]);
    expect(restoreAgentId("acp-gateway:codex")).toEqual({ id: "acp-gateway:codex" });
    expect(restoreAgentId("acp-gateway:")).toEqual({ id: "radium" });
    expect(restoreAgentId("acp-gateway:one:codex")).toEqual({ id: "radium" });
    expect(sessionAgentById("acp-gateway:codex", agents)).toMatchObject({
      protocol: "acp",
      agentId: "codex",
      profile: "gateway",
      name: "Codex · Gateway",
      installation: { worker: "one" },
    });
    expect(sessionAgentById("acp:codex", agents)).toMatchObject({ profile: "native" });
    // The legacy Worker-qualified id still means the native profile.
    expect(sessionAgentById("acp:one:codex", agents)).toMatchObject({ profile: "native" });
    expect(sessionAgentById("acp-gateway:codex", workspaceAgents([definition], "one", []))).toBe(
      builtInAgent,
    );
  });

  test("Gateway entries are hidden where Gateway access is off", () => {
    const gateway = sessionAgentById(
      "acp-gateway:codex",
      workspaceAgents([gatewayDefinition], undefined, []),
    );
    const native = sessionAgentById(
      "acp:codex",
      workspaceAgents([gatewayDefinition], undefined, []),
    );
    expect(agentListed(native, worker("one"), [worker("one")])).toBe(true);
    expect(agentListed(builtInAgent, undefined, [])).toBe(true);
    expect(agentListed(gateway, worker("one"), [worker("one")])).toBe(false);
    expect(agentListed(gateway, worker("one", now, "pending"), [])).toBe(true);
    expect(agentListed(gateway, undefined, [worker("one"), worker("two")])).toBe(false);
    expect(agentListed(gateway, undefined, [worker("one"), worker("two", now, "missing")])).toBe(
      true,
    );
    expect(
      agentListed(gateway, undefined, [
        { ...worker("revoked", now, "active"), status: "revoked" as const },
      ]),
    ).toBe(false);
    expect(agentAvailability(gateway, worker("one"), now, [report("one")])).toBe("gateway_off");
  });

  test("Gateway availability follows access, then the native report without sign-in", () => {
    const gateway = sessionAgentById(
      "acp-gateway:codex",
      workspaceAgents([gatewayDefinition], undefined, []),
    );
    expect(agentAvailability(gateway, undefined, now, [])).toBe("no_worker");
    expect(agentAvailability(gateway, worker("one", now, "pending"), now, [report("one")])).toBe(
      "gateway_pending",
    );
    expect(agentAvailability(gateway, worker("one", now, "missing"), now, [report("one")])).toBe(
      "gateway_missing",
    );
    for (const status of ["ready", "needs_auth", "unavailable", "failed"] as const) {
      expect(
        agentAvailability(gateway, worker("one", now, "active"), now, [report("one", status)]),
      ).toBe(status === "ready" || status === "needs_auth" ? "ready" : "unavailable");
    }
    expect(
      agentAvailability(gateway, worker("one", 0, "active"), now, [report("one", "ready")]),
    ).toBe("offline");
    const workers = [
      worker("off", now, "off"),
      worker("pending", now, "pending"),
      worker("auth", now, "active"),
    ];
    const rows = [report("off"), report("pending"), report("auth", "needs_auth")];
    expect(firstReadyWorker(gateway, workers, rows, now)?.workerId).toBe("auth");
  });
});
