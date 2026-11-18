import { describe, expect, it } from "vitest";
import { equalBytes, utf8 } from "./encoding";
import { chatKeyBindingStatement, toolApprovalStatement, toolGrantStatement } from "./statements";
import { sign, signingPublicKeyFromSeed, verify } from "./signatures";

const receipt = { chatE2eeId: "object", scope: "shared" as const, creatorId: "creator" };

const approval = {
  workspaceId: "ws",
  chatId: "chat",
  workerId: "worker",
  directory: "/repo",
  tool: "bash",
  toolCallId: "call",
  input: utf8('{"command":"ls"}'),
  approvedAt: 1_700_000_000_000,
  receipt: { ...receipt, keyId: "epoch-key" },
};

describe("tool authorization statements", () => {
  it("binds an approval to every scope field, the input, the approval time and the receipt key", () => {
    const base = toolApprovalStatement(approval);
    const variants = [
      { ...approval, chatId: "other" },
      { ...approval, workerId: "other" },
      { ...approval, directory: "/other" },
      { ...approval, tool: "edit" },
      { ...approval, toolCallId: "other" },
      { ...approval, input: utf8('{"command":"rm"}') },
      { ...approval, approvedAt: approval.approvedAt + 1 },
      { ...approval, receipt: null },
      { ...approval, receipt: { ...approval.receipt, keyId: "other-key" } },
      { ...approval, receipt: { ...approval.receipt, chatE2eeId: "other-object" } },
      { ...approval, receipt: { ...approval.receipt, scope: "workspace" as const } },
      { ...approval, receipt: { ...approval.receipt, creatorId: "other-creator" } },
    ];
    for (const variant of variants) {
      expect(equalBytes(toolApprovalStatement(variant), base)).toBe(false);
    }
  });

  it("signs a grant's tools independent of order, its issuance time and its receipt audience", () => {
    const grant = {
      workspaceId: "ws",
      chatId: "chat",
      workerId: "worker",
      directory: "/repo",
      tools: ["read", "bash"],
      issuedAt: 1,
      receipt,
    };
    expect(
      equalBytes(
        toolGrantStatement(grant),
        toolGrantStatement({ ...grant, tools: ["bash", "read"] }),
      ),
    ).toBe(true);
    for (const variant of [
      { ...grant, issuedAt: 2 },
      { ...grant, receipt: null },
      { ...grant, receipt: { ...receipt, creatorId: "other-creator" } },
      { ...grant, receipt: { ...receipt, scope: "personal" as const } },
    ]) {
      expect(equalBytes(toolGrantStatement(grant), toolGrantStatement(variant))).toBe(false);
    }
  });
});

describe("chat recipient bindings", () => {
  it("authenticates the exact chat and audience, independently of shared member ordering", async () => {
    const seed = new Uint8Array(32).fill(7);
    const publicKey = await signingPublicKeyFromSeed(seed);
    const input = {
      chatId: "private-chat",
      workspaceId: "workspace",
      chatE2eeId: "crypto-object",
      epoch: 1,
      keyId: "epoch-key",
      suite: 1,
      publicKey: new Uint8Array(1216).fill(3),
      scope: "shared" as const,
      creatorId: "creator",
      members: ["reader-b", "reader-a"],
    };
    const signature = await sign(seed, chatKeyBindingStatement(input));
    expect(await verify(publicKey, chatKeyBindingStatement({
      ...input, members: ["reader-a", "reader-b", "reader-a"],
    }), signature)).toBe(true);
    for (const changed of [
      { ...input, chatId: "other-chat" },
      { ...input, workspaceId: "other-workspace" },
      { ...input, chatE2eeId: "other-object" },
      { ...input, epoch: 2 },
      { ...input, keyId: "other-key" },
      { ...input, publicKey: new Uint8Array(1216).fill(4) },
      { ...input, scope: "personal" as const },
      { ...input, creatorId: "other-creator" },
      { ...input, members: ["reader-a", "outsider"] },
    ]) {
      expect(await verify(publicKey, chatKeyBindingStatement(changed), signature)).toBe(false);
    }
    expect(() => chatKeyBindingStatement({
      ...input, members: Array.from({ length: 1001 }, (_, i) => `reader-${i}`),
    })).toThrow("Too many chat members");
  });
});
