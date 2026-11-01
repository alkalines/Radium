import { describe, expect, test } from "bun:test";
import type { Id } from "backend/convex/_generated/dataModel";
import { agentsOnWorker, builtInAgent, sessionAgentById, type SessionAgentRow } from "./agents";

function agent(worker: string, status: SessionAgentRow["status"] = "ready"): SessionAgentRow {
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

describe("Worker-qualified ACP agent selection", () => {
  test("the built-in agent is available without a Worker or catalog", () => {
    expect(agentsOnWorker(undefined, undefined)).toEqual([builtInAgent]);
    expect(sessionAgentById("radium", undefined)).toBe(builtInAgent);
  });

  test("identical harness ids on different Workers resolve independently", () => {
    const rows = [agent("one"), agent("two")];
    expect(sessionAgentById("acp:one:codex", rows)).toMatchObject({
      workerId: "one",
      agentId: "codex",
      protocol: "acp",
    });
    expect(sessionAgentById("acp:two:codex", rows)).toMatchObject({
      workerId: "two",
      agentId: "codex",
      protocol: "acp",
    });
  });

  test("missing and unavailable restored agents fall back to built-in", () => {
    expect(sessionAgentById("acp:missing:codex", [agent("one")])).toBe(builtInAgent);
    expect(sessionAgentById("acp:one:codex", [agent("one", "unavailable")])).toBe(builtInAgent);
    expect(sessionAgentById("acp:one:codex", [agent("one", "failed")])).toBe(builtInAgent);
  });

  test("agents needing authentication remain available to the sign-in UI", () => {
    expect(sessionAgentById("acp:one:codex", [agent("one", "needs_auth")])).toMatchObject({
      status: "needs_auth",
    });
  });
});
