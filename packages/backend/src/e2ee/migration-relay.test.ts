import { describe, expect, it, vi } from "vitest";
import type { QueryCtx } from "../../convex/_generated/server";
import {
  ACP_BACKEND_ERROR_CODES,
  ACP_SEALED_ERROR_TEXT,
  ACP_WORKER_ERROR_CODES,
  isPersistedAcpErrorCode,
} from "contracts/acp/contract";
import { workerChatTaskRequestId } from "contracts/worker/task-contract";

vi.mock("./legacy-crypto", () => ({
  activeLegacyRecipient: vi.fn(
    async (_ctx: unknown, input: { chat?: string; workspace?: string; userId?: string }) => {
      if (input.chat) return { kind: "chat", keyId: "chat-key", epoch: 1 };
      if (input.workspace) return { kind: "workspace_owner", keyId: "owner-key", epoch: 1 };
      if (input.userId) return { kind: "identity", keyId: input.userId, epoch: 1 };
      return undefined;
    },
  ),
}));

import { domain } from "./migration-relay";

type Row = Record<string, unknown>;

const chat = { _id: "chat", workspace: "ws", userId: "alice" };

function context(documents: Row[] = [chat], session: Row | null = null) {
  return {
    db: {
      get: async (id: string) => documents.find((document) => document._id === id) ?? null,
      // Only chat ids are valid here, as in the real database.
      normalizeId: (_table: string, id: string) => (id === "chat" ? id : null),
      query: () => ({ withIndex: () => ({ unique: async () => session }) }),
    },
  } as unknown as QueryCtx;
}

const command = (extra: Row = {}) => ({
  _id: "command",
  workspace: "ws",
  chat: "chat",
  by: "alice",
  kind: "prompt",
  status: "done",
  ...extra,
});

describe("relay legacy extraction", () => {
  it("seals finished plaintext commands to the chat audience and clears only plaintext", async () => {
    const result = await domain.inspect(context(), "acp_commands", command({
      payload: { kind: "prompt", prompt: [{ type: "text", text: "secret" }] },
      error: "boom",
    }));
    expect(Object.keys(result?.value ?? {}).sort()).toEqual(["error", "payload"]);
    expect(result?.patch).toEqual({ payload: undefined, error: undefined });
    expect(result?.recipient).toMatchObject({ kind: "chat" });
  });

  it("blocks pending and claimed plaintext work instead of replaying or cancelling it", async () => {
    for (const status of ["pending", "claimed"]) {
      await expect(
        domain.inspect(context(), "acp_commands", command({ status, payload: { kind: "cancel" } })),
      ).rejects.toThrow("LEGACY_RELAY_QUIESCE_COMMAND");
    }
    await expect(
      domain.inspect(context(), "acp_interactions", {
        _id: "i", workspace: "ws", chat: "chat", status: "pending", request: { kind: "permission" },
      }),
    ).rejects.toThrow("LEGACY_RELAY_QUIESCE_INTERACTION");
    await expect(
      domain.inspect(context(), "worker_tasks", {
        _id: "t", workspace: "ws", chatId: "chat", status: "processing", editRequest: { path: "a" },
      }),
    ).rejects.toThrow("LEGACY_RELAY_QUIESCE_TASK");
  });

  it("leaves native signed commands, worker error codes and fork receipts alone", async () => {
    const signed = { clientId: "c", payload: new ArrayBuffer(1) };
    expect(await domain.inspect(context(), "acp_commands", command({ status: "pending", signed }))).toBeNull();
    expect(await domain.inspect(context(), "acp_commands", command({ status: "failed", error: "ACP_FAILED" }))).toBeNull();
    // Backend-written codes (a cancelled prompt, an abandoned row) are metadata a re-run never seals again.
    for (const code of ACP_BACKEND_ERROR_CODES)
      expect(await domain.inspect(context(), "acp_commands", command({ status: "failed", error: code }))).toBeNull();
    // Lookalike free text is content, whatever its prefix.
    const lookalike = await domain.inspect(context(), "acp_commands", command({ status: "failed", error: "ACP_CANCELLED by /home/me" }));
    expect(lookalike?.value).toEqual({ error: "ACP_CANCELLED by /home/me" });
    expect(await domain.inspect(context(), "acp_commands", command({ kind: "fork", result: "chat" }))).toBeNull();
    // The same field on another kind is free text and is sealed.
    const sealed = await domain.inspect(context(), "acp_commands", command({ kind: "sync_sessions", result: "chat" }));
    expect(sealed?.value).toEqual({ result: "chat" });
  });

  it("sealed history is idempotent and a sidecar never merges with new plaintext", async () => {
    expect(await domain.inspect(context(), "acp_commands", command({ legacyContent: {} }))).toBeNull();
    await expect(
      domain.inspect(context(), "acp_commands", command({ legacyContent: {}, error: "late" })),
    ).rejects.toThrow("LEGACY_RELAY_SIDECAR_CONFLICT");
  });

  it("keeps native request IDs and sealed receipts but replaces legacy canonical keys", async () => {
    const call = { _id: "call", workspace: "ws", chatId: "chat", toolCallId: "tool", stage: "execute", taskId: "task" };
    const nativeKey = await workerChatTaskRequestId("chat", "tool", "execute");
    expect(await domain.inspect(context(), "worker_chat_calls", { ...call, requestKey: nativeKey, sealedResult: new ArrayBuffer(1) })).toBeNull();
    const legacy = await domain.inspect(context(), "worker_chat_calls", {
      ...call, requestKey: '{"command":"rm -rf x"}', result: { ok: true, output: "x" },
    });
    expect(Object.keys(legacy?.value ?? {}).sort()).toEqual(["requestKey", "result"]);
    expect(legacy?.patch).toMatchObject({ requestKey: "", result: undefined });
  });

  it("blocks warm or busy sessions and keeps the generic sealed error", async () => {
    const session = { _id: "s", workspace: "ws", chat: "chat", status: "idle", warm: false, config: { options: [] } };
    await expect(
      domain.inspect(context(), "acp_sessions", { ...session, warm: true }),
    ).rejects.toThrow("LEGACY_RELAY_QUIESCE_SESSION");
    const generic = { ...session, config: undefined, error: ACP_SEALED_ERROR_TEXT, sealedError: { epoch: 1, box: new ArrayBuffer(1) } };
    expect(await domain.inspect(context(), "acp_sessions", generic)).toBeNull();
    const extracted = await domain.inspect(context(), "acp_sessions", { ...session, error: "agent said no" });
    expect(Object.keys(extracted?.value ?? {}).sort()).toEqual(["config", "error"]);
  });

  it("covers frame payloads but not native sealed bytes", async () => {
    const frame = { _id: "f", chat: "chat", stream: "acp:1", seqFrom: 0, seqTo: 0 };
    const result = await domain.inspect(context(), "chat_frames", { ...frame, payload: "[]" });
    expect(result?.patch).toEqual({ payload: "" });
    expect(await domain.inspect(context(), "chat_frames", { ...frame, payload: new ArrayBuffer(4) })).toBeNull();
  });

  it("limits agent catalog sealing to diagnostics and never touches execution directories", async () => {
    const agent = { _id: "a", workspace: "ws", status: "failed", authMethods: [{ id: "x" }], defaults: {} };
    expect(await domain.inspect(context(), "worker_agents", { ...agent, error: "ACP_FAILED" })).toBeNull();
    for (const code of ACP_BACKEND_ERROR_CODES)
      expect(await domain.inspect(context(), "worker_agents", { ...agent, error: code })).toBeNull();
    const result = await domain.inspect(context(), "worker_agents", {
      ...agent, error: "/home/me/bin missing", sessionsSync: { status: "failed", at: 1, error: "no /srv" },
    });
    expect(result?.patch).toEqual({ error: undefined, sessionsSync: { status: "failed", at: 1 } });
    expect(result?.recipient).toMatchObject({ kind: "workspace_owner" });
    expect(domain.tables).not.toContain("worker_presence");
    await expect(
      domain.inspect(context(), "worker_presence", { _id: "p", workspace: "ws", tempDirectory: "/tmp/x" }),
    ).rejects.toThrow("LEGACY_RELAY_UNKNOWN_TABLE");
  });

  it("derives the release audience without reading content and keeps deleted chats in custody", async () => {
    expect(await domain.releaseRecipient(context(), "acp_commands", command())).toMatchObject({ kind: "chat" });
    expect(await domain.releaseRecipient(context([]), "acp_commands", command())).toBeUndefined();
    // Index titles are owner-only even when their chat is gone.
    expect(
      await domain.releaseRecipient(context([]), "acp_agent_sessions", { _id: "x", workspace: "ws", chat: "chat" }),
    ).toMatchObject({ kind: "workspace_owner" });
    await expect(
      domain.releaseRecipient(context(), "acp_commands", command({ workspace: "other" })),
    ).rejects.toThrow("LEGACY_RELAY_OWNERSHIP_CONFLICT");
  });
});

describe("fixed ACP error codes", () => {
  it("keeps Worker-reportable and backend-only codes disjoint while the persisted classifier covers both", () => {
    for (const code of ACP_BACKEND_ERROR_CODES)
      expect((ACP_WORKER_ERROR_CODES as readonly string[]).includes(code), code).toBe(false);
    for (const code of [...ACP_WORKER_ERROR_CODES, ...ACP_BACKEND_ERROR_CODES])
      expect(isPersistedAcpErrorCode(code), code).toBe(true);
    expect(isPersistedAcpErrorCode("boom")).toBe(false);
    expect(isPersistedAcpErrorCode(undefined)).toBe(false);
  });
});
