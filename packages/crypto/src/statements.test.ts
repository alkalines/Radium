import { describe, expect, it } from "vitest";
import { equalBytes, utf8 } from "./encoding";
import { toolApprovalStatement, toolGrantStatement } from "./statements";

const approval = {
  workspaceId: "ws",
  chatId: "chat",
  workerId: "worker",
  directory: "/repo",
  tool: "bash",
  toolCallId: "call",
  input: utf8('{"command":"ls"}'),
  approvedAt: 1_700_000_000_000,
};

describe("tool authorization statements", () => {
  it("binds an approval to every scope field, the input and the approval time", () => {
    const base = toolApprovalStatement(approval);
    const variants = [
      { ...approval, chatId: "other" },
      { ...approval, workerId: "other" },
      { ...approval, directory: "/other" },
      { ...approval, tool: "edit" },
      { ...approval, toolCallId: "other" },
      { ...approval, input: utf8('{"command":"rm"}') },
      { ...approval, approvedAt: approval.approvedAt + 1 },
    ];
    for (const variant of variants) {
      expect(equalBytes(toolApprovalStatement(variant), base)).toBe(false);
    }
  });

  it("signs a grant's tools independent of order, and its issuance time", () => {
    const grant = {
      workspaceId: "ws",
      chatId: "chat",
      workerId: "worker",
      directory: "/repo",
      tools: ["read", "bash"],
      issuedAt: 1,
    };
    expect(
      equalBytes(
        toolGrantStatement(grant),
        toolGrantStatement({ ...grant, tools: ["bash", "read"] }),
      ),
    ).toBe(true);
    expect(
      equalBytes(toolGrantStatement(grant), toolGrantStatement({ ...grant, issuedAt: 2 })),
    ).toBe(false);
  });
});
