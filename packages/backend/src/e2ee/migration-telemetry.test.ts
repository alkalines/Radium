import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationTitle } from "contracts/notifications/contract";
import { domain } from "./migration-telemetry";
import { advanceProofStep, proofVerdict, startProof } from "./migration-telemetry-attribution";
import { fakeDb, type Fake } from "./migration-telemetry-fake";
import { PROOF_FORMAT } from "./migration-telemetry-contract";
import { enqueueProofsPage, invalidateTelemetryProofs, persistedAudience, proveNextStep, scheduleProofRefresh } from "./migration-telemetry-proofs";
import { invalidateForCapturedRequest } from "./migration-telemetry-reach";

vi.mock("./legacy-crypto", () => ({
  activeLegacyRecipient: vi.fn(async (_ctx: unknown, input: { chat?: string; workspace?: string; userId?: string }) => {
    if (input.chat) return { kind: "chat", keyId: input.chat };
    if (input.workspace) return { kind: "workspace_owner", keyId: input.workspace };
    return { kind: "identity", keyId: input.userId };
  }),
}));

// Chats are visible to the workspace owner unless they are another user's personal chat.
vi.mock("../../convex/workspaces", () => ({
  findWorkspaceForLegacyBalance: vi.fn(async (ctx: Fake, balance: string) =>
    ctx.tables.workspaces!.find((workspace) => workspace.legacyBalance === balance) ?? null),
  authorizeChatRecord: vi.fn(async (ctx: Fake, chatId: string, userId: string) => {
    const chat = ctx.tables.aisdk_chats!.find((row) => row._id === chatId);
    if (!chat) return null;
    if (chat.scope === "personal" && chat.userId !== userId) return null;
    return { chat, workspace: ctx.tables.workspaces!.find((row) => row._id === chat.workspace) };
  }),
}));

type Row = Record<string, unknown>;

function fakeCtx(tables: Record<string, Row[]>) {
  return fakeDb(tables) as unknown as Parameters<typeof domain.inspect>[0] & Fake;
}

async function sha256(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const workspace = { _id: "ws", ownerId: "owner" };
const chats = [
  { _id: "shared-visible", userId: "owner", scope: "workspace", workspace: "ws" },
  { _id: "alice-private", userId: "alice", scope: "personal", workspace: "ws" },
  { _id: "bob-private", userId: "bob", scope: "personal", workspace: "ws" },
];
const request = (id: string, extra: Row = {}): Row => ({
  _id: id, workspace: "ws", requestId: id, attempts: [], ...extra,
});
const blob = (id: string, extra: Row = {}) => ({ _id: id, workspace: "ws", hash: `hash-${id}`, kind: "message", size: 1, ...extra });
const node = (id: string, blobId: string, extra: Row = {}) => ({
  _id: id, workspace: "ws", hash: `hash-${id}`, blob: blobId, depth: 1, origin: "input", ...extra,
});

beforeEach(() => { process.env.TELEMETRY_HASH_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; });
afterEach(() => {
  delete process.env.TELEMETRY_HASH_SECRET;
  delete process.env.TELEMETRY_KEYED_HASH_SINCE;
  delete process.env.TELEMETRY_HASH_PROVENANCE;
});

describe("request and trace attribution", () => {
  it("seals request and attempt errors while keeping native ciphertext in place", async () => {
    const ctx = fakeCtx({ workspaces: [workspace], aisdk_chats: chats });
    const sealedError = { capsule: new ArrayBuffer(3) };
    const row = request("r", {
      error: { message: "private", status: 500 }, sealedError,
      attempts: [{ provider: "p", message: "upstream" }, { provider: "q" }],
    });
    const result = await domain.inspect(ctx, "telemetry_requests", row);
    expect(result?.value).toEqual({ error: row.error, attempts: ["upstream", null] });
    expect(result?.patch.attempts).toEqual([{ provider: "p", message: undefined }, { provider: "q", message: undefined }]);
    expect(result?.patch).not.toHaveProperty("sealedError");
    expect(result?.recipient).toMatchObject({ kind: "workspace_owner" });
  });

  it("never gives the workspace owner another user's private chat telemetry", async () => {
    const ctx = fakeCtx({ workspaces: [workspace], aisdk_chats: chats });
    const row = request("r", { chatId: "alice-private", error: { message: "private" } });
    expect((await domain.inspect(ctx, "telemetry_requests", row))?.recipient).toEqual({ kind: "chat", keyId: "alice-private" });
    const visible = request("v", { chatId: "shared-visible", error: { message: "x" } });
    expect((await domain.inspect(ctx, "telemetry_requests", visible))?.recipient).toMatchObject({ kind: "workspace_owner" });
  });

  it("keeps a request in a deleted chat custodial", async () => {
    const ctx = fakeCtx({ workspaces: [workspace], aisdk_chats: [] });
    const result = await domain.inspect(ctx, "telemetry_requests", request("r", { chatId: "gone", error: { message: "x" } }));
    expect(result?.recipient).toBeUndefined();
  });

  it("blocks a legacy trace whose workspace and balance disagree and resolves balance-only traces", async () => {
    const ctx = fakeCtx({
      workspaces: [{ ...workspace, legacyBalance: "balance" }, { _id: "other", ownerId: "x", legacyBalance: "other-balance" }],
      aisdk_chats: chats,
    });
    const base = { _id: "t", userId: "alice", error: "failed" };
    await expect(domain.inspect(ctx, "telemetry_traces", { ...base, workspace: "ws", balance: "other-balance" })).rejects.toThrow();
    await expect(domain.inspect(ctx, "telemetry_traces", base)).rejects.toThrow();
    const result = await domain.inspect(ctx, "telemetry_traces", { ...base, balance: "balance" });
    expect(result?.workspace).toBe("ws");
    expect(result?.value).toEqual({ error: "failed" });
  });

  it("derives span and payload audience and workspace from the validated trace", async () => {
    const ctx = fakeCtx({
      workspaces: [workspace],
      aisdk_chats: chats,
      telemetry_traces: [{ _id: "trace", workspace: "ws", chatId: "bob-private" }],
      telemetry_spans: [{ _id: "span", trace: "trace" }, { _id: "foreign-span", trace: "other-trace" }],
    });
    const payload = await domain.inspect(ctx, "telemetry_payloads", { _id: "p", trace: "trace", inputJson: "private" });
    expect(payload).toMatchObject({ workspace: "ws", value: { inputJson: "private" }, recipient: { kind: "chat", keyId: "bob-private" } });
    const span = await domain.inspect(ctx, "telemetry_spans", { _id: "s", trace: "trace", name: "tool", toolName: "bash" });
    expect(span?.patch.name).toBe("Historical span");
    expect(span?.value).toEqual({ name: "tool", toolName: "bash" });
    await expect(domain.inspect(ctx, "telemetry_spans", { trace: "trace", workspace: "other", name: "n" })).rejects.toThrow();
    await expect(domain.inspect(ctx, "telemetry_payloads", { trace: "trace", span: "foreign-span", inputJson: "x" })).rejects.toThrow();
    await expect(domain.inspect(ctx, "telemetry_payloads", { trace: "missing", inputJson: "x" })).rejects.toThrow();
  });
});

describe("shared blob and node attribution", () => {
  const base = { workspaces: [workspace], aisdk_chats: chats, telemetry_toolset_tools: [], telemetry_nodes: [] };

  it("releases only to the owner when every referencing request is owner-visible", async () => {
    const shared = blob("b", { content: "{}" });
    const ctx = fakeCtx({
      ...base,
      telemetry_requests: [request("gateway", { system: "b" }), request("visible", { system: "b", chatId: "shared-visible" })],
    });
    expect((await domain.inspect(ctx, "telemetry_blobs", shared))?.recipient).toMatchObject({ kind: "workspace_owner" });
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", { ...shared, legacyContent: { kind: "custody" } }))
      .toMatchObject({ kind: "workspace_owner" });
  });

  it("keeps a blob shared with another user's private chat in custody", async () => {
    const shared = blob("b", { content: "{}" });
    const ctx = fakeCtx({
      ...base,
      telemetry_requests: [request("gateway", { system: "b" }), request("private", { system: "b", chatId: "alice-private" })],
    });
    expect((await domain.inspect(ctx, "telemetry_blobs", shared))?.recipient).toBeUndefined();
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", shared)).toBeUndefined();
  });

  it("seals a blob used by a single private chat to that chat, and never to two audiences", async () => {
    const shared = blob("b", { content: "{}" });
    const one = fakeCtx({ ...base, telemetry_requests: [request("a1", { params: "b", chatId: "alice-private" }), request("a2", { params: "b", chatId: "alice-private" })] });
    expect(await domain.releaseRecipient(one, "telemetry_blobs", shared)).toEqual({ kind: "chat", keyId: "alice-private" });
    const two = fakeCtx({ ...base, telemetry_requests: [request("a", { params: "b", chatId: "alice-private" }), request("b", { params: "b", chatId: "bob-private" })] });
    expect(await domain.releaseRecipient(two, "telemetry_blobs", shared)).toBeUndefined();
  });

  it("reaches requests through node descendants and toolset membership", async () => {
    const message = blob("message", { content: "{}" });
    const tool = blob("tool", { kind: "tool", content: "{}" });
    const ctx = fakeCtx({
      ...base,
      telemetry_nodes: [
        node("n1", "message"),
        node("n2", "other", { parent: "n1" }),
      ],
      telemetry_toolset_tools: [{ _id: "m", workspace: "ws", toolset: "set", tool: "tool", position: 0 }],
      telemetry_requests: [
        request("visible", { input: "n2" }),
        request("hidden", { toolset: "set", chatId: "alice-private" }),
      ],
    });
    // The early message node is seen through its descendant leaf; the tool through its toolset.
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", message)).toMatchObject({ kind: "workspace_owner" });
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", tool)).toEqual({ kind: "chat", keyId: "alice-private" });
  });

  it("leaves unreferenced blobs custodial and rejects references across workspaces", async () => {
    const orphan = blob("orphan", { content: "{}" });
    expect(await domain.releaseRecipient(fakeCtx({ ...base, telemetry_requests: [] }), "telemetry_blobs", orphan)).toBeUndefined();
    const foreign = fakeCtx({ ...base, telemetry_requests: [{ ...request("r", { system: "b" }), workspace: "other" }] });
    await expect(domain.releaseRecipient(foreign, "telemetry_blobs", blob("b", { content: "{}" }))).rejects.toThrow();
  });

  it("never grants the owner a blob whose last same-instant referrer is private (in transaction)", async () => {
    // More referrers than one bounded scan may read, all created in the same instant.
    const owners = Array.from({ length: 150 }, (_, index) => request(`r${String(index).padStart(3, "0")}`, { system: "b", _creationTime: 5 }));
    const hidden = request("zz-private", { system: "b", chatId: "alice-private", _creationTime: 5 });
    const ctx = fakeCtx({ ...base, telemetry_requests: [...owners, hidden] });
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", blob("b", { content: "{}" }))).toBeUndefined();
    expect((await domain.inspect(ctx, "telemetry_blobs", blob("b", { content: "{}" })))?.recipient).toBeUndefined();
  });

  it("pages a persisted proof by one scan page per step and sees a private last same-instant referrer", async () => {
    const owners = Array.from({ length: 120 }, (_, index) => request(`r${String(index).padStart(3, "0")}`, { system: "b", _creationTime: 5 }));
    const hidden = request("zz-private", { system: "b", chatId: "alice-private", _creationTime: 5 });
    const ctx = fakeCtx({ ...base, telemetry_requests: [...owners, hidden] });
    const state = startProof({ table: "telemetry_blobs", id: "b" });
    let verdict;
    let steps = 0;
    while (!verdict) {
      verdict = await advanceProofStep(ctx as never, workspace as never, state);
      expect(++steps).toBeLessThan(100);
    }
    expect(steps).toBeGreaterThan(3);
    expect(verdict).toEqual({ kind: "custody", reason: "mixed" });
    expect(proofVerdict(state)).toEqual(verdict);

    // The same referrers all in one private chat resolve to that chat, still across several pages.
    const solo = fakeCtx({ ...base, telemetry_requests: Array.from({ length: 120 }, (_, index) => request(`p${index}`, { system: "b", chatId: "alice-private", _creationTime: 5 })) });
    const soloState = startProof({ table: "telemetry_blobs", id: "b" });
    let soloVerdict;
    while (!soloVerdict) soloVerdict = await advanceProofStep(solo as never, workspace as never, soloState);
    expect(soloVerdict).toEqual({ kind: "chat", chat: "alice-private" });
  });

  it("declares an over-wide subtree unprovable instead of growing without bound", async () => {
    const state = startProof({ table: "telemetry_nodes", id: "root" });
    // Visiting the root queues three scans, which no longer fit the frontier bound.
    state.work = [...Array.from({ length: 2999 }, (_, index) => ({ kind: "node" as const, id: `n${index}` })), ...state.work];
    const ctx = fakeCtx({ ...base, telemetry_nodes: [node("root", "x")], telemetry_requests: [] });
    expect(await advanceProofStep(ctx as never, workspace as never, state)).toEqual({ kind: "custody", reason: "too_wide" });
  });

  it("runs the persisted proof over same-instant custody rows across runner pages", async () => {
    const custody = { kind: "custody", keyId: "k", epoch: 1, box: new ArrayBuffer(1) };
    const blobs = Array.from({ length: 120 }, (_, index) =>
      blob(`c${String(index).padStart(3, "0")}`, { legacyContent: custody, _creationTime: 7 }));
    const requests = blobs.map((row) => request(`g-${row._id}`, { system: row._id }));
    // The last blob in (time, id) order is also used by a private chat, so it must stay custodial.
    requests.push(request("private", { system: "c119", chatId: "alice-private" }));
    const ctx = fakeCtx({
      ...base,
      telemetry_blobs: blobs,
      telemetry_requests: requests,
      e2ee_migration_state: [{ _id: "state", key: "global", frozen: true, generation: 1 }],
      e2ee_telemetry_proofs: [],
    }) as never as Fake & Parameters<typeof enqueueProofsPage>[0];

    // Phase 1: follow the scheduled cursors like the scheduler would.
    let args: { table: "telemetry_blobs"; cursor?: string } | undefined = { table: "telemetry_blobs" };
    let pages = 0;
    while (args) {
      await enqueueProofsPage(ctx, args);
      const next = ctx.scheduled.pop()!.args as { table: "telemetry_blobs"; cursor?: string };
      args = next.cursor === undefined ? undefined : next;
      expect(++pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(ctx.tables.e2ee_telemetry_proofs).toHaveLength(120);

    // Phase 2: each step advances one proof by one scan page until none is running.
    for (let steps = 0; ctx.tables.e2ee_telemetry_proofs!.some((proof) => proof.status === "running"); steps++) {
      expect(steps).toBeLessThan(1000);
      await proveNextStep(ctx, { table: "telemetry_blobs" });
    }
    expect(await persistedAudience(ctx, "telemetry_blobs", "c000")).toEqual({ kind: "owner" });
    expect(await persistedAudience(ctx, "telemetry_blobs", "c119")).toEqual({ kind: "custody", reason: "mixed" });

    // A later freeze generation invalidates finished proofs instead of trusting them.
    ctx.tables.e2ee_migration_state![0]!.generation = 2;
    expect(await persistedAudience(ctx, "telemetry_blobs", "c000")).toBeUndefined();
  });
});

describe("hash provenance", () => {
  const ctx = (extra: Record<string, Row[]> = {}) => fakeCtx({
    workspaces: [workspace], aisdk_chats: chats, telemetry_toolset_tools: [], telemetry_nodes: [],
    telemetry_requests: [request("gateway", { system: "b" })],
    telemetry_blobs: [],
    ...extra,
  });

  it("moves File Storage text and metadata into the sidecar and replaces the legacy fingerprint", async () => {
    const result = await domain.inspect(ctx(), "telemetry_blobs", blob("b", { storage: "file", meta: { role: "user" } }));
    expect(result?.storage).toEqual({ id: "file", field: "content", encoding: "text" });
    expect(result?.value).toEqual({ meta: { role: "user" }, legacyHash: "hash-b" });
    expect(result?.patch.hash).not.toBe("hash-b");
    expect(result?.patch.legacyHashVersion).toBe(2);
    expect(result?.patch).toHaveProperty("storage", undefined);
    expect(result?.patch).toHaveProperty("meta", undefined);
  });

  it("rekeys inline content only when the unkeyed fingerprint recomputes", async () => {
    const content = '{"role":"user"}';
    const unkeyed = await sha256(`blob\u0000ws\u0000message\u0000${content}`);
    const legacy = await domain.inspect(ctx(), "telemetry_blobs", blob("b", { content, hash: unkeyed }));
    expect(legacy?.value).toEqual({ content, legacyHash: unkeyed });
    expect(legacy?.patch.hash).toMatch(/^[0-9a-f]{64}$/);
    // Keyed hash with plaintext content (migrated payload): the content moves, the hash stays,
    // and marker 1 records that the hash was already keyed.
    const keyed = await domain.inspect(ctx(), "telemetry_blobs", blob("b", { content, hash: "keyed-by-secret" }));
    expect(keyed?.value).toEqual({ content });
    expect(keyed?.patch).not.toHaveProperty("hash");
    expect(keyed?.patch.legacyHashVersion).toBe(1);
    const again = await domain.inspect(ctx(), "telemetry_blobs", blob("b", { content, hash: unkeyed }));
    expect(again?.patch.hash).toBe(legacy?.patch.hash);
  });

  it("never changes native sealed blobs, their storage, or already keyed rows", async () => {
    const sealed = blob("b", { storage: "sealed-file", sealed: { capsule: new ArrayBuffer(1) } });
    expect(await domain.inspect(ctx(), "telemetry_blobs", sealed)).toBeNull();
    expect(await domain.inspect(ctx(), "telemetry_blobs", blob("b", { legacyHashVersion: 1 }))).toBeNull();
  });

  it("blocks contradictory content sources and plaintext beside an existing sidecar", async () => {
    await expect(domain.inspect(ctx(), "telemetry_blobs", blob("b", { content: "x", storage: "file" }))).rejects.toThrow();
    await expect(domain.inspect(ctx(), "telemetry_blobs", blob("b", { content: "x", legacyContent: { kind: "custody" } }))).rejects.toThrow();
  });

  it("dates content-less blobs by the chain of the nodes that use them", async () => {
    const legacyBlobHash = "content-less-legacy";
    const legacyNodeHash = await sha256(`node\u0000ws\u0000\u0000${legacyBlobHash}`);
    const nodes = ctx({
      telemetry_blobs: [blob("old", { hash: legacyBlobHash }), blob("native", { hash: "keyed-blob" })],
      telemetry_nodes: [
        node("old-node", "old", { hash: legacyNodeHash }),
        node("native-node", "native", { hash: "keyed-node" }),
      ],
    });
    // The legacy chain recomputes; the keyed one never does, so only the legacy blob is rekeyed.
    expect((await domain.inspect(nodes, "telemetry_blobs", blob("old", { hash: legacyBlobHash })))?.value).toEqual({ legacyHash: legacyBlobHash });
    expect(await domain.inspect(nodes, "telemetry_blobs", blob("native", { hash: "keyed-blob" }))).toBeNull();
    expect((await domain.inspect(nodes, "telemetry_nodes", node("old-node", "old", { hash: legacyNodeHash })))?.value).toEqual({ legacyHash: legacyNodeHash });
    expect(await domain.inspect(nodes, "telemetry_nodes", node("native-node", "native", { hash: "keyed-node" }))).toBeNull();
  });

  it("inherits a rekeyed (version 2) parent's scheme and leaves nodes of sealed blobs untouched", async () => {
    const nodes = ctx({
      telemetry_blobs: [blob("plain", { content: "{}" }), blob("sealed", { sealed: {} }), blob("other", { content: "{}" })],
      telemetry_nodes: [node("parent", "plain", { legacyHashVersion: 2, legacyContent: { kind: "custody" } })],
    });
    const child = await domain.inspect(nodes, "telemetry_nodes", node("child", "other", { parent: "parent" }));
    expect(child?.value).toEqual({ legacyHash: "hash-child" });
    expect(child?.patch.legacyHashVersion).toBe(2);
    expect(await domain.inspect(nodes, "telemetry_nodes", node("native", "sealed"))).toBeNull();
    expect(await domain.inspect(nodes, "telemetry_nodes", node("keyed", "plain", { legacyHashVersion: 1 }))).toBeNull();
  });

  it("seals keyed plaintext with version 1 and never rekeys its chain neighbours afterwards", async () => {
    const content = '{"role":"user"}';
    const keyed = blob("kb", { content, hash: "keyed-blob-hash" });
    const sealing = await domain.inspect(ctx({ telemetry_blobs: [keyed] }), "telemetry_blobs", keyed);
    expect(sealing?.value).toEqual({ content });
    expect(sealing?.patch).not.toHaveProperty("hash");
    expect(sealing?.patch.legacyHashVersion).toBe(1);

    // After sealing the blob keeps its hash and carries marker 1 beside the sidecar. Nodes that
    // were never marked, and descendants of them, must still be recognised as keyed.
    const sealedBlob = { ...keyed, content: undefined, legacyHashVersion: 1, legacyContent: { kind: "custody" } };
    const nodes = ctx({
      telemetry_blobs: [sealedBlob],
      telemetry_nodes: [
        node("root", "kb", { hash: "keyed-node-1" }),
        node("leaf", "kb", { hash: "keyed-node-2", parent: "root", depth: 2 }),
      ],
    });
    expect(await domain.inspect(nodes, "telemetry_nodes", node("root", "kb", { hash: "keyed-node-1" }))).toBeNull();
    expect(await domain.inspect(nodes, "telemetry_nodes", node("leaf", "kb", { hash: "keyed-node-2", parent: "root", depth: 2 }))).toBeNull();
    // A sidecar without any marker is ambiguous and blocks instead of being guessed unkeyed.
    const unmarked = ctx({ telemetry_blobs: [{ ...sealedBlob, legacyHashVersion: undefined }] });
    await expect(domain.inspect(unmarked, "telemetry_nodes", node("root", "kb", { hash: "keyed-node-1" }))).rejects.toThrow(/marker/);
  });

  it("does not date content-less blobs from a lone 'keyed since' instant any more", async () => {
    const lone = blob("params", { kind: "params", hash: "no-evidence", _creationTime: 350 });
    const only = ctx({ telemetry_requests: [request("r", { params: "params" })] });
    await expect(domain.inspect(only, "telemetry_blobs", lone)).rejects.toThrow(/provenance/);
    // The retired timestamp variable is ignored: it can no longer turn ambiguity into a classification.
    process.env.TELEMETRY_KEYED_HASH_SINCE = "1";
    await expect(domain.inspect(only, "telemetry_blobs", lone)).rejects.toThrow(/provenance/);
    await expect(domain.inspect(only, "telemetry_blobs", { ...lone, _creationTime: 5_000 })).rejects.toThrow(/provenance/);
  });

  it("classifies orphans only inside attested epochs of a keyed -> unkeyed -> keyed history", async () => {
    process.env.TELEMETRY_HASH_PROVENANCE = JSON.stringify([
      { from: 500, until: 600, scheme: "keyed" },
      { from: 100, until: 200, scheme: "keyed" },
      { from: 300, until: 400, scheme: "unkeyed" },
    ]);
    const orphan = (id: string, time: number) => blob(id, { kind: "params", hash: `hash-${id}`, _creationTime: time });
    const only = ctx();
    // First keyed epoch and the rolled-forward keyed epoch keep their native hashes untouched.
    expect(await domain.inspect(only, "telemetry_blobs", orphan("first", 150))).toBeNull();
    expect(await domain.inspect(only, "telemetry_blobs", orphan("third", 550))).toBeNull();
    // The rollback epoch is unkeyed even though a single keyed-since instant would call it keyed.
    const rolledBack = await domain.inspect(only, "telemetry_blobs", orphan("second", 350));
    expect(rolledBack?.value).toEqual({ legacyHash: "hash-second" });
    expect(rolledBack?.patch.legacyHashVersion).toBe(2);
    // Deploy-boundary slack and anything before or after the attested stretches stays ambiguous.
    for (const time of [50, 250, 450, 650]) {
      await expect(domain.inspect(only, "telemetry_blobs", orphan(`gap${time}`, time))).rejects.toThrow(/ambiguous/);
    }
  });

  it("never lets an attestation override exact evidence, and rejects malformed attestations", async () => {
    process.env.TELEMETRY_HASH_PROVENANCE = JSON.stringify([{ from: 300, until: 400, scheme: "unkeyed" }]);
    const orphan = blob("x", { kind: "params", hash: "x-hash", _creationTime: 350 });
    // A keyed node chain proves the blob keyed; an attestation calling the same time unkeyed is an inventory error.
    const keyedChain = ctx({
      telemetry_blobs: [orphan],
      telemetry_nodes: [node("xn", "x", { hash: "keyed-node" })],
    });
    await expect(domain.inspect(keyedChain, "telemetry_blobs", orphan)).rejects.toThrow(/contradicts/);

    const lone = blob("y", { kind: "params", hash: "y-hash", _creationTime: 350 });
    for (const bad of ["not json", "[]", JSON.stringify([{ from: 1, until: 5, scheme: "other" }]),
      JSON.stringify([{ from: 1, until: 5, scheme: "keyed" }, { from: 4, until: 9, scheme: "unkeyed" }])]) {
      process.env.TELEMETRY_HASH_PROVENANCE = bad;
      await expect(domain.inspect(ctx(), "telemetry_blobs", lone)).rejects.toThrow(/TELEMETRY_HASH_PROVENANCE/);
    }
  });

  it("dates orphan blobs by the message-hash session of their request, rekeyed sessions included", async () => {
    const lone = blob("params", { kind: "params", hash: "no-evidence" });
    const withSession = (session: Row) => ctx({
      telemetry_sessions: [{ _id: "s", workspace: "ws", startedAt: 1, ...session }],
      telemetry_requests: [request("r", { params: "params", session: "s" })],
    });
    const dev = await domain.inspect(withSession({ key: "msg:0123456789abcdef" }), "telemetry_blobs", lone);
    expect(dev?.value).toEqual({ legacyHash: "no-evidence" });
    expect(await domain.inspect(withSession({ key: `msg:${"a".repeat(64)}` }), "telemetry_blobs", lone)).toBeNull();
    // A session the migration already rekeyed still proves its requests were captured unkeyed.
    const migrated = withSession({ key: `msg:${"b".repeat(64)}`, legacyHashVersion: 2, legacyContent: { kind: "custody" } });
    expect((await domain.inspect(migrated, "telemetry_blobs", lone))?.value).toEqual({ legacyHash: "no-evidence" });
    // Explicit client session ids say nothing about the hash scheme.
    await expect(domain.inspect(withSession({ key: "claude:abc" }), "telemetry_blobs", lone)).rejects.toThrow(/provenance/);
    // Sources that disagree block instead of choosing one.
    const keyedNode = ctx({
      telemetry_blobs: [blob("m", { hash: "m-hash" })],
      telemetry_nodes: [node("n", "m", { hash: "keyed-node" })],
      telemetry_sessions: [{ _id: "s", workspace: "ws", key: "msg:0123456789abcdef", startedAt: 1 }],
      telemetry_requests: [request("r", { params: "params", input: "n", session: "s" })],
    });
    await expect(domain.inspect(keyedNode, "telemetry_blobs", lone)).rejects.toThrow(/contradictory/);
  });
});

describe("telemetry session keys", () => {
  const session = (id: string, key: string, extra: Row = {}) => ({ _id: id, workspace: "ws", key, startedAt: 1, ...extra });
  const ctx = (rows: Row[] = []) => fakeCtx({
    workspaces: [workspace, { _id: "ws2", ownerId: "owner" }], aisdk_chats: chats, telemetry_sessions: rows,
  });
  const unkeyed = "msg:0123456789abcdef";

  it("rekeys a dev fingerprint exactly once and keeps the original only in the sidecar value", async () => {
    const result = await domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed));
    expect(result?.value).toEqual({ legacyKey: unkeyed });
    expect(result?.patch.key).toMatch(/^msg:[0-9a-f]{64}$/);
    expect(result?.patch.key).not.toBe(unkeyed);
    expect(result?.patch.legacyHashVersion).toBe(2);
    expect(result?.recipient).toMatchObject({ kind: "workspace_owner" });
    expect(result?.workspace).toBe("ws");

    // Deterministic per workspace, separated across workspaces.
    const again = await domain.inspect(ctx(), "telemetry_sessions", session("t", unkeyed));
    expect(again?.patch.key).toBe(result?.patch.key);
    const other = await domain.inspect(ctx(), "telemetry_sessions", session("u", unkeyed, { workspace: "ws2" }));
    expect(other?.patch.key).not.toBe(result?.patch.key);

    // The committed row (new key, marker, sidecar) is terminal: nothing to extract, nothing to rekey again.
    const committed = session("s", result?.patch.key as string, { legacyHashVersion: 2, legacyContent: { kind: "custody" } });
    expect(await domain.inspect(ctx([committed]), "telemetry_sessions", committed)).toBeNull();
  });

  it("leaves native keyed keys and explicit client session ids byte-identical", async () => {
    for (const key of [`msg:${"a".repeat(64)}`, "claude:abc", "header:msg:0123456789abcdef", "chat:k17abc"]) {
      expect(await domain.inspect(ctx(), "telemetry_sessions", session("s", key))).toBeNull();
    }
  });

  it("rekeys key and parentKey with one mapping so a hierarchy agrees in either migration order", async () => {
    const parent = session("p", unkeyed);
    const child = session("c", "claude:child", { parentKey: unkeyed });
    const both = ctx([parent, child]);
    const parentResult = await domain.inspect(both, "telemetry_sessions", parent);
    const childResult = await domain.inspect(both, "telemetry_sessions", child);
    expect(childResult?.value).toEqual({ legacyParentKey: unkeyed });
    expect(childResult?.patch).not.toHaveProperty("key");
    expect(childResult?.patch.parentKey).toBe(parentResult?.patch.key);
    expect(childResult?.patch.legacyHashVersion).toBe(2);

    // A msg: child of a msg: parent maps both fields, and a committed row is terminal.
    const other = "msg:fedcba9876543210";
    const nested = await domain.inspect(ctx(), "telemetry_sessions", session("n", other, { parentKey: unkeyed }));
    expect(nested?.value).toEqual({ legacyKey: other, legacyParentKey: unkeyed });
    expect(nested?.patch.parentKey).toBe(parentResult?.patch.key);
    expect(nested?.patch.key).not.toBe(nested?.patch.parentKey);
    const done = session("n", nested?.patch.key as string, {
      parentKey: nested?.patch.parentKey, legacyHashVersion: 2, legacyContent: { kind: "custody" },
    });
    expect(await domain.inspect(ctx([done]), "telemetry_sessions", done)).toBeNull();
  });

  it("blocks unknown fingerprint shapes, keyed-beside-unkeyed rows and contradictory markers", async () => {
    for (const key of ["msg:0123456789ABCDEF", `msg:${"a".repeat(20)}`, "msg:"]) {
      await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", key))).rejects.toThrow(/unknown/);
    }
    await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", "claude:x", { parentKey: "msg:ZZ" }))).rejects.toThrow(/unknown/);
    await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", `msg:${"a".repeat(64)}`, { parentKey: unkeyed }))).rejects.toThrow(/mixes/);
    await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed, { legacyHashVersion: 2 }))).rejects.toThrow(/marker/);
    await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed, { legacyContent: { kind: "custody" } }))).rejects.toThrow();
    await expect(domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed, { workspace: "missing" }))).rejects.toThrow();
  });

  it("seals a private chat's session key to that chat and reports the chat for the custody index", async () => {
    const result = await domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed, { chatId: "alice-private" }));
    expect(result?.recipient).toEqual({ kind: "chat", keyId: "alice-private" });
    expect(result?.chat).toBe("alice-private");
    const missing = await domain.inspect(ctx(), "telemetry_sessions", session("m", unkeyed, { chatId: "gone" }));
    expect(missing?.recipient).toBeUndefined();
    const visible = await domain.inspect(ctx(), "telemetry_sessions", session("v", unkeyed, { chatId: "shared-visible" }));
    expect(visible?.recipient).toMatchObject({ kind: "workspace_owner" });
    expect(visible?.chat).toBeUndefined();
  });

  it("also removes old affinity fingerprints, preserves the model suffix, and never grants an unattributed hash to the owner", async () => {
    const binding = { _id: "r", workspace: "ws", key: `${unkeyed}::model:priority`, provider: "p", expiresAt: 100 };
    const result = await domain.inspect(ctx(), "routing_sessions", binding);
    const sessionResult = await domain.inspect(ctx(), "telemetry_sessions", session("s", unkeyed));
    expect(result?.patch.key).toBe(`${sessionResult?.patch.key}::model:priority`);
    expect(result?.value).toEqual({ legacyKey: binding.key });
    expect(result?.recipient).toBeUndefined();
    expect(result?.patch.legacyHashVersion).toBe(2);
    expect(await domain.inspect(ctx(), "routing_sessions", { ...binding, ...result?.patch, legacyContent: { kind: "custody" } })).toBeNull();
    expect(await domain.inspect(ctx(), "routing_sessions", { ...binding, key: `msg:${"a".repeat(64)}::model` })).toBeNull();
    expect(await domain.releaseRecipient(ctx(), "routing_sessions", { ...binding, ...result?.patch })).toBeUndefined();
  });
});

describe("proof freshness across cutover", () => {
  const custody = { kind: "custody", keyId: "k", epoch: 1, box: new ArrayBuffer(1) };
  const referrers = (record: string, chatId?: string, count = 1) =>
    Array.from({ length: count }, (_, index) => request(`${record}-${chatId ?? "gateway"}-${index}`, { system: record, ...(chatId ? { chatId } : {}) }));

  function cutoverCtx(state: Row, blobs: Row[], requests: Row[], entries: Row[], proofs: Row[] = [], extra: Record<string, Row[]> = {}) {
    return fakeCtx({
      workspaces: [{ ...workspace }], aisdk_chats: chats.map(chat => ({ ...chat })), telemetry_toolset_tools: [], telemetry_nodes: [],
      telemetry_blobs: blobs, telemetry_requests: requests,
      e2ee_migration_state: [{ _id: "state", key: "global", custodyState: "active", cutoverComplete: false, ...state }],
      e2ee_telemetry_proofs: proofs, e2ee_legacy_custody: entries, e2ee_migration_jobs: [], ...extra,
    }) as never as Fake & Parameters<typeof enqueueProofsPage>[0];
  }

  /** Runs scheduled proof continuations like the scheduler; returns every scheduled function name. */
  async function pump(ctx: Fake & Parameters<typeof enqueueProofsPage>[0]) {
    const names: string[] = [];
    for (let steps = 0; ctx.scheduled.length > 0; steps++) {
      expect(steps).toBeLessThan(500);
      const { name, args } = ctx.scheduled.shift()!;
      const fn = getFunctionName(name as never);
      names.push(fn);
      if (fn === "e2ee_telemetry:enqueueProofs") await enqueueProofsPage(ctx, args as never);
      else if (fn === "e2ee_telemetry:proveNext") await proveNextStep(ctx, args as never);
    }
    return names;
  }

  it("re-proves custody at the post-cutover generation, hints chats, and schedules one registry release", async () => {
    const stale = (record: string, verdict: Row) => ({
      _id: `proof-${record}`,
      table: "telemetry_blobs", record, workspace: "ws", generation: 1, status: "done",
      state: { owner: false, hidden: [], missingChat: false, seen: 1, work: [], tooWide: false }, verdict, updatedAt: 1,
    });
    const ctx = cutoverCtx(
      // finishCutover: unfrozen, complete, and the generation moved 1 -> 2.
      { frozen: false, cutoverComplete: true, generation: 2 },
      [blob("owned", { legacyContent: custody }), blob("hidden", { legacyContent: custody }), blob("big", { legacyContent: custody }),
        blob("mixed", { legacyContent: custody })],
      [...referrers("owned"), ...referrers("hidden", "alice-private"),
        // More referrers than one transaction may scan: only the persisted proof can finish it.
        ...referrers("big", "alice-private", 130),
        ...referrers("mixed"), ...referrers("mixed", "bob-private")],
      ["owned", "hidden", "big", "mixed"].map((record) => ({ _id: `c-${record}`, table: "telemetry_blobs", record, workspace: "ws" })),
      [stale("owned", { kind: "owner" }), stale("hidden", { kind: "chat", chat: "alice-private" })],
    );

    // The generation bump invalidated the finished proofs: nothing may rely on them.
    expect(await persistedAudience(ctx, "telemetry_blobs", "owned")).toBeUndefined();
    expect(await persistedAudience(ctx, "telemetry_blobs", "hidden")).toBeUndefined();
    // The bounded in-transaction proof cannot settle the wide blob, so it stays custodial for now.
    expect(await domain.releaseRecipient(ctx as never, "telemetry_blobs", blob("big", { legacyContent: custody }))).toBeUndefined();

    expect(await scheduleProofRefresh(ctx)).toBe(true);
    const names = await pump(ctx);
    expect(names).toContain("e2ee_telemetry:enqueueProofs");

    expect(await persistedAudience(ctx, "telemetry_blobs", "owned")).toEqual({ kind: "owner" });
    expect(await persistedAudience(ctx, "telemetry_blobs", "hidden")).toEqual({ kind: "chat", chat: "alice-private" });
    expect(await persistedAudience(ctx, "telemetry_blobs", "big")).toEqual({ kind: "chat", chat: "alice-private" });
    expect(await persistedAudience(ctx, "telemetry_blobs", "mixed")).toEqual({ kind: "custody", reason: "mixed" });
    expect(ctx.tables.e2ee_telemetry_proofs!.every((proof) => proof.generation === 2)).toBe(true);

    // The wide blob now reaches its chat key, the mixed one stays custodial and unreleased.
    expect(await domain.releaseRecipient(ctx as never, "telemetry_blobs", blob("big", { legacyContent: custody })))
      .toEqual({ kind: "chat", keyId: "alice-private" });
    expect(await domain.releaseRecipient(ctx as never, "telemetry_blobs", blob("mixed", { legacyContent: custody }))).toBeUndefined();

    // Chat hints let the chat-key hook find blobs; owner and custody verdicts carry none.
    const hint = (record: string) => ctx.tables.e2ee_legacy_custody!.find((entry) => entry.record === record)?.chat;
    expect(hint("hidden")).toBe("alice-private");
    expect(hint("big")).toBe("alice-private");
    expect(hint("owned")).toBeUndefined();
    expect(hint("mixed")).toBeUndefined();

    // One real, unscoped release job follows the finished run (keys may predate the proofs).
    expect(ctx.tables.e2ee_migration_jobs).toHaveLength(1);
    expect(ctx.tables.e2ee_migration_jobs![0]).toMatchObject({ kind: "release", dryRun: false, generation: 2 });
    expect(ctx.tables.e2ee_migration_jobs![0]).not.toHaveProperty("scope");
    expect(names.filter((name) => name === "e2ee_migration_node:runJob")).toHaveLength(1);
  });

  it("never lets a finished proof override a complete fresh proof that saw a later referrer", async () => {
    const done = {
      _id: "proof-late",
      table: "telemetry_blobs", record: "late", workspace: "ws", generation: 2, graphRevision: 0, proofFormat: PROOF_FORMAT, status: "done",
      state: { owner: true, hidden: [], missingChat: false, seen: 1, work: [], tooWide: false }, verdict: { kind: "owner" }, updatedAt: 1,
    };
    const ctx = cutoverCtx(
      { frozen: false, cutoverComplete: true, generation: 2 },
      [blob("late", { legacyContent: custody })],
      // A native capture after the proof now also references the blob from another user's private chat.
      [...referrers("late"), ...referrers("late", "alice-private")],
      [{ _id: "c", table: "telemetry_blobs", record: "late", workspace: "ws" }],
      [done],
    );
    expect(await persistedAudience(ctx, "telemetry_blobs", "late")).toEqual({ kind: "owner" });
    expect(await domain.releaseRecipient(ctx as never, "telemetry_blobs", blob("late", { legacyContent: custody }))).toBeUndefined();
  });

  it("invalidates a wide finished owner proof when a new private referrer arrives after cutover", async () => {
    const row = blob("wide-late", { legacyContent: custody });
    const proof = {
      _id: "p", table: "telemetry_blobs", record: "wide-late", workspace: "ws", generation: 2,
      graphRevision: 0, proofFormat: PROOF_FORMAT, status: "done", state: { owner: true, hidden: [], missingChat: false, seen: 130, work: [], tooWide: false },
      verdict: { kind: "owner" }, updatedAt: 1,
    };
    const ctx = cutoverCtx(
      { frozen: false, cutoverComplete: true, generation: 2 },
      [row], referrers("wide-late", undefined, 130),
      [{ _id: "c", table: "telemetry_blobs", record: "wide-late", workspace: "ws" }], [proof],
    );
    expect(await persistedAudience(ctx, "telemetry_blobs", "wide-late")).toEqual({ kind: "owner" });
    ctx.tables.telemetry_requests!.push(request("private-last", { system: "wide-late", chatId: "alice-private", _creationTime: 9_999_999 }));
    await invalidateTelemetryProofs(ctx, "ws" as never);
    expect(await persistedAudience(ctx, "telemetry_blobs", "wide-late")).toBeUndefined();
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", row)).toBeUndefined();
    await pump(ctx);
    expect(await persistedAudience(ctx, "telemetry_blobs", "wide-late")).toEqual({ kind: "custody", reason: "mixed" });
  });

  it.each(["narrow", "delete"] as const)("invalidates a frozen-generation wide owner proof before %s can release private history", async mode => {
    const row = blob("frozen-wide", { legacyContent: custody });
    const proof = {
      _id: "frozen-proof", table: "telemetry_blobs", record: "frozen-wide", workspace: "ws", generation: 1,
      graphRevision: 0, proofFormat: PROOF_FORMAT, status: "done", state: { owner: true, hidden: [], missingChat: false, seen: 130, work: [], tooWide: false },
      verdict: { kind: "owner" }, updatedAt: 1,
    };
    const ctx = cutoverCtx(
      { frozen: true, cutoverComplete: false, generation: 1 },
      [row], referrers("frozen-wide", "shared-visible", 130),
      [{ _id: "frozen-custody", table: "telemetry_blobs", record: "frozen-wide", workspace: "ws" }], [proof],
    );
    // Alice's workspace-visible history is initially owner-visible; personal history is not.
    await ctx.db.patch("aisdk_chats", "shared-visible" as never, { userId: "alice" });
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", row)).toMatchObject({ kind: "workspace_owner" });
    if (mode === "narrow") await ctx.db.patch("aisdk_chats", "shared-visible" as never, { scope: "personal" });
    else await ctx.db.delete("aisdk_chats", "shared-visible" as never);
    await invalidateTelemetryProofs(ctx, "ws" as never);
    expect(await persistedAudience(ctx, "telemetry_blobs", "frozen-wide")).toBeUndefined();
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", row)).toBeUndefined();
    await pump(ctx);
    expect(await persistedAudience(ctx, "telemetry_blobs", "frozen-wide")).toEqual(
      mode === "narrow" ? { kind: "chat", chat: "shared-visible" } : { kind: "custody", reason: "missing_chat" },
    );
    expect((await domain.releaseRecipient(ctx, "telemetry_blobs", row))?.kind).not.toBe("workspace_owner");
  });

  it("never revives a proof taken under the old workspace revision counter when the dedicated counter reads zero", async () => {
    const row = blob("legacy-wide", { legacyContent: custody });
    // Old code: owner proof at graphRevision 0, taken before 130 references from a now-private chat existed;
    // the workspace document counter has since advanced to 6. The dedicated revision document is absent.
    const proof = {
      _id: "old-proof", table: "telemetry_blobs", record: "legacy-wide", workspace: "ws", generation: 2,
      graphRevision: 0, status: "done", state: { owner: true, hidden: [], missingChat: false, seen: 130, work: [], tooWide: false },
      verdict: { kind: "owner" }, updatedAt: 1,
    };
    const ctx = cutoverCtx(
      { frozen: false, cutoverComplete: true, generation: 2 },
      [row], referrers("legacy-wide", "alice-private", 130),
      [{ _id: "c", table: "telemetry_blobs", record: "legacy-wide", workspace: "ws" }], [proof],
      { workspaces: [{ ...workspace, telemetryProofRevision: 6 }] },
    );
    expect(ctx.tables.e2ee_telemetry_revisions ?? []).toHaveLength(0);
    expect(await persistedAudience(ctx, "telemetry_blobs", "legacy-wide")).toBeUndefined();
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", row)).toBeUndefined();

    // The next pass restarts the unformatted proof (numbers match, format does not) and settles it correctly.
    expect(await scheduleProofRefresh(ctx)).toBe(true);
    await pump(ctx);
    expect(ctx.tables.e2ee_telemetry_proofs![0]).toMatchObject({ proofFormat: PROOF_FORMAT, graphRevision: 0, status: "done" });
    expect(await persistedAudience(ctx, "telemetry_blobs", "legacy-wide")).toEqual({ kind: "chat", chat: "alice-private" });
    expect(await domain.releaseRecipient(ctx, "telemetry_blobs", row)).toEqual({ kind: "chat", keyId: "alice-private" });
  });

  it("refreshes nothing when custody is inactive, writers are open, or no telemetry row is held", async () => {
    const held = [{ _id: "c", table: "telemetry_blobs", record: "owned", workspace: "ws" }];
    const blobs = [blob("owned", { legacyContent: custody })];
    for (const [state, entries] of [
      [{ custodyState: "none", cutoverComplete: true, frozen: false, generation: 2 }, held],
      [{ custodyState: "active", cutoverComplete: false, frozen: false, generation: 2 }, held],
      [{ custodyState: "active", cutoverComplete: true, frozen: false, generation: 2 }, []],
    ] as const) {
      const ctx = cutoverCtx({ ...state }, blobs, referrers("owned"), [...entries]);
      expect(await scheduleProofRefresh(ctx)).toBe(false);
      expect(ctx.scheduled).toHaveLength(0);
    }
  });

  it("marks a proof whose step throws failed, finishes the pass, and retries it on the next pass", async () => {
    const entries = ["good", "bad"].map((record) => ({ _id: `c-${record}`, table: "telemetry_blobs", record, workspace: "ws" }));
    const ctx = cutoverCtx(
      { frozen: false, cutoverComplete: true, generation: 2 },
      [blob("good", { legacyContent: custody }), blob("bad", { legacyContent: custody })],
      // A referrer that crosses workspaces makes the proof scan throw.
      [...referrers("good"), request("foreign", { system: "bad", workspace: "other" })],
      entries,
    );
    const proofOf = (record: string) => ctx.tables.e2ee_telemetry_proofs!.find((proof) => proof.record === record)!;

    expect(await scheduleProofRefresh(ctx)).toBe(true);
    await pump(ctx);
    // The unprovable row is isolated: recorded as failed with its reason, never retried in a loop,
    // and the pass still ends cleanly (pending cleared, one registry release) for the other row.
    expect(proofOf("bad")).toMatchObject({ status: "failed", failure: expect.stringContaining("crosses workspaces") });
    expect(proofOf("bad")).not.toHaveProperty("verdict");
    expect(await persistedAudience(ctx, "telemetry_blobs", "bad")).toBeUndefined();
    expect(await persistedAudience(ctx, "telemetry_blobs", "good")).toEqual({ kind: "owner" });
    expect(ctx.tables.e2ee_migration_state![0]).toMatchObject({ telemetryRefreshPending: false });
    expect(ctx.tables.e2ee_migration_jobs).toHaveLength(1);

    // Once the cause is gone, the next pass restarts the failed proof and finishes it.
    ctx.tables.telemetry_requests!.find((row) => row._id === "foreign")!.workspace = "ws";
    expect(await scheduleProofRefresh(ctx)).toBe(true);
    await pump(ctx);
    expect(proofOf("bad")).toMatchObject({ status: "done", verdict: { kind: "owner" } });
    expect(proofOf("bad")).not.toHaveProperty("failure");
  });

  describe("native captures versus custodial history", () => {
    const held = blob("held", { legacyContent: custody });
    const heldEntry = { _id: "c-held", table: "telemetry_blobs", record: "held", workspace: "ws" };
    const doneProof = (verdict: Row) => ({
      _id: "proof-held", table: "telemetry_blobs", record: "held", workspace: "ws", generation: 2, graphRevision: 0, proofFormat: PROOF_FORMAT, status: "done",
      state: { owner: false, hidden: [], missingChat: false, seen: 130, work: [], tooWide: false }, verdict, updatedAt: 1,
    });

    function capture(extra: Record<string, Row[]>, options: { blobs?: Row[]; proofs?: Row[]; state?: Row } = {}) {
      return cutoverCtx(
        { frozen: false, cutoverComplete: true, generation: 2, ...options.state },
        [held, ...(options.blobs ?? [])], [], [heldEntry], options.proofs, extra,
      );
    }
    type CaptureCtx = Fake & Parameters<typeof enqueueProofsPage>[0];
    const revision = (ctx: CaptureCtx) => (ctx.tables.e2ee_telemetry_revisions?.[0]?.revision as number | undefined) ?? 0;
    const rowOf = (ctx: CaptureCtx, table: string, id: string) => ctx.tables[table]!.find((row) => row._id === id)!;
    const reach = (ctx: CaptureCtx, input: { nodes?: string[]; blobs?: string[]; chatId?: string }) =>
      invalidateForCapturedRequest(ctx, {
        workspace: "ws" as never,
        chatId: input.chatId as never,
        nodes: (input.nodes ?? []).map((id) => rowOf(ctx, "telemetry_nodes", id) as never),
        blobs: (input.blobs ?? []) as never,
      });
    const natives = ["m0", "m1", "m2", "system"].map((id) => blob(id, { sealed: {} }));

    it("neither bumps the revision, patches the workspace, nor schedules a refresh for captures that reach no custody", async () => {
      const ctx = capture(
        { telemetry_nodes: [node("n1", "m1"), node("n2", "m2", { parent: "n1", depth: 2 })] },
        { blobs: natives },
      );
      const workspaceBefore = structuredClone(ctx.tables.workspaces);
      await reach(ctx, { nodes: ["n2"], blobs: ["system"] });
      expect(revision(ctx)).toBe(0);
      expect(ctx.tables.workspaces).toEqual(workspaceBefore);
      expect(ctx.scheduled).toHaveLength(0);
      expect(ctx.tables.e2ee_migration_state![0]).not.toHaveProperty("telemetryRefreshPending");
      // The ancestry walk memoizes the custody-free chain so later requests do not repeat it.
      expect(ctx.tables.telemetry_nodes!.map((row) => row.custodyFree)).toEqual([true, true]);
    });

    it.each([
      ["a custodial ancestor node", [node("n0", "m0", { legacyContent: custody }), node("n1", "m1", { parent: "n0", depth: 2 })], "n0"],
      ["a custodial message blob on an ancestor", [node("n0", "held"), node("n1", "m1", { parent: "n0", depth: 2 })], undefined],
    ])("invalidates for a request reached only through hidden legacy ancestry: %s", async (_name, nodes, custodial) => {
      // The request's own leaf is native and its direct references are clean; only ancestry reaches custody.
      const leaf = node("leaf", "m2", { parent: "n1", depth: 3 });
      const ctx = capture({ telemetry_nodes: [...nodes, leaf] }, { blobs: natives });
      await reach(ctx, { nodes: ["leaf"], blobs: ["system"] });
      expect(revision(ctx)).toBe(1);
      expect(ctx.scheduled.map((entry) => getFunctionName(entry.name as never))).toContain("e2ee_telemetry:enqueueProofs");
      expect(rowOf(ctx, "telemetry_nodes", "leaf").custodyFree).toBe(false);
      // Custodial rows themselves are never patched.
      if (custodial) expect(rowOf(ctx, "telemetry_nodes", custodial)).not.toHaveProperty("custodyFree");
    });

    it("keeps a node whose ancestry is unreadable conservative and unmemoized", async () => {
      const ctx = capture({ telemetry_nodes: [node("orphan", "m1", { parent: "missing", depth: 2 })] }, { blobs: natives });
      await reach(ctx, { nodes: ["orphan"] });
      expect(revision(ctx)).toBe(1);
      expect(rowOf(ctx, "telemetry_nodes", "orphan")).not.toHaveProperty("custodyFree");
    });

    it.each([
      ["owner verdict, private referrer", { kind: "owner" }, "alice-private", true],
      ["owner verdict, gateway referrer", { kind: "owner" }, undefined, false],
      ["owner verdict, owner-visible chat referrer", { kind: "owner" }, "shared-visible", false],
      ["chat verdict, same chat", { kind: "chat", chat: "alice-private" }, "alice-private", false],
      ["chat verdict, another private chat", { kind: "chat", chat: "alice-private" }, "bob-private", true],
      ["chat verdict, gateway referrer", { kind: "chat", chat: "alice-private" }, undefined, true],
      ["mixed verdict, any referrer", { kind: "custody", reason: "mixed" }, "bob-private", false],
      ["orphan verdict, any referrer", { kind: "custody", reason: "orphan" }, undefined, true],
    ])("custodial blob reference with a finished proof: %s", async (_name, verdict, chatId, invalidates) => {
      const ctx = capture({}, { proofs: [doneProof(verdict)] });
      expect(await persistedAudience(ctx, "telemetry_blobs", "held")).toEqual(verdict);
      await reach(ctx, { blobs: ["held"], chatId });
      expect(revision(ctx)).toBe(invalidates ? 1 : 0);
      // A new private referrer must drop the cached wide owner proof; a harmless one keeps it.
      expect(await persistedAudience(ctx, "telemetry_blobs", "held")).toEqual(invalidates ? undefined : verdict);
    });

    it("invalidates for a custodial blob whose proof is missing, stale, or still running", async () => {
      for (const proofs of [[], [{ ...doneProof({ kind: "custody", reason: "mixed" }), generation: 1 }], [{ ...doneProof({ kind: "owner" }), status: "running" }]]) {
        const ctx = capture({}, { proofs });
        await reach(ctx, { blobs: ["held"] });
        expect(revision(ctx)).toBe(1);
      }
    });

    it("checks toolset tools and memoizes a toolset without custodial tools", async () => {
      const ctx = capture(
        {
          telemetry_toolset_tools: [
            { _id: "m-free", workspace: "ws", toolset: "free-set", tool: "free-tool", position: 0 },
            { _id: "m-held", workspace: "ws", toolset: "held-set", tool: "held", position: 0 },
          ],
        },
        { blobs: [blob("free-tool", { kind: "tool", sealed: {} }), blob("free-set", { kind: "toolset", sealed: {} }), blob("held-set", { kind: "toolset", sealed: {} })] },
      );
      await reach(ctx, { blobs: ["free-set"] });
      expect(revision(ctx)).toBe(0);
      expect(rowOf(ctx, "telemetry_blobs", "free-set").custodyFree).toBe(true);
      // The custodial tool has no finished proof, so a request using its toolset must invalidate.
      await reach(ctx, { blobs: ["held-set"] });
      expect(revision(ctx)).toBe(1);
      expect(rowOf(ctx, "telemetry_blobs", "held-set")).not.toHaveProperty("custodyFree");
    });

    it("ignores a custody-free memo from an earlier generation when a hidden ancestor later turns custodial", async () => {
      const ctx = capture(
        { telemetry_nodes: [node("n1", "m1"), node("leaf", "m2", { parent: "n1", depth: 2 })] },
        { blobs: natives },
      );
      await reach(ctx, { nodes: ["leaf"] });
      expect(revision(ctx)).toBe(0);
      expect(ctx.tables.telemetry_nodes!.map((row) => [row.custodyFree, row.custodyFreeGeneration])).toEqual([[true, 2], [true, 2]]);

      // Operator re-freezes after cutover (generation 3), seals the hidden ancestor's message into
      // custody, and thaws again (generation 4). The old `true` memos must not be trusted.
      const state = ctx.tables.e2ee_migration_state![0]!;
      state.generation = 3;
      state.frozen = true;
      await reach(ctx, { nodes: ["leaf"], chatId: "alice-private" });
      expect(revision(ctx)).toBe(0);
      expect(ctx.tables.telemetry_nodes!.map((row) => row.custodyFreeGeneration)).toEqual([2, 2]);
      rowOf(ctx, "telemetry_blobs", "m1").legacyContent = custody;
      delete rowOf(ctx, "telemetry_blobs", "m1").sealed;
      ctx.tables.e2ee_legacy_custody!.push({ _id: "c-m1", table: "telemetry_blobs", record: "m1", workspace: "ws" });
      state.generation = 4;
      state.frozen = false;
      ctx.tables.e2ee_telemetry_proofs!.push({
        _id: "proof-m1", table: "telemetry_blobs", record: "m1", workspace: "ws", generation: 4, graphRevision: 0, proofFormat: PROOF_FORMAT, status: "done",
        state: { owner: true, hidden: [], missingChat: false, seen: 1, work: [], tooWide: false }, verdict: { kind: "owner" }, updatedAt: 1,
      });
      expect(await persistedAudience(ctx, "telemetry_blobs", "m1")).toEqual({ kind: "owner" });

      // A native private request below the now-custodial ancestor must drop the cached owner proof.
      await reach(ctx, { nodes: ["leaf"], chatId: "alice-private" });
      expect(revision(ctx)).toBe(1);
      expect(await persistedAudience(ctx, "telemetry_blobs", "m1")).toBeUndefined();
      expect(ctx.tables.telemetry_nodes!.map((row) => [row.custodyFree, row.custodyFreeGeneration])).toEqual([[false, 4], [false, 4]]);
    });

    it("does nothing before cutover completes or once the workspace holds no custodial telemetry", async () => {
      for (const options of [{ state: { cutoverComplete: false } }, { state: { custodyState: "ended" } }]) {
        const ctx = capture({ telemetry_nodes: [node("n", "held")] }, options);
        await reach(ctx, { nodes: ["n"], blobs: ["held"] });
        expect(revision(ctx)).toBe(0);
        expect(ctx.scheduled).toHaveLength(0);
        expect(rowOf(ctx, "telemetry_nodes", "n")).not.toHaveProperty("custodyFree");
      }
      const empty = cutoverCtx({ frozen: false, cutoverComplete: true, generation: 2 }, [held], [], [], [], { telemetry_nodes: [node("n", "held")] });
      await reach(empty as never, { nodes: ["n"], blobs: ["held"] });
      expect(empty.tables.e2ee_telemetry_revisions ?? []).toHaveLength(0);
    });
  });
});

describe("notifications", () => {
  const ctx = fakeCtx({ workspaces: [workspace], aisdk_chats: chats });
  const generic = { _id: "n", userId: "alice", kind: "session_finished", title: notificationTitle("session_finished"), body: "Workspace" };

  it("seals plaintext title and body to the recipient identity, never the workspace owner", async () => {
    const result = await domain.inspect(ctx, "notifications", { ...generic, workspace: "ws", title: "Build done", body: "My secret chat" });
    expect(result?.value).toEqual({ title: "Build done", body: "My secret chat" });
    expect(result?.patch).toEqual({ title: generic.title, body: "Workspace" });
    expect(result?.recipient).toEqual({ kind: "identity", keyId: "alice" });
  });

  it("moves leftover limit detail into the sidecar and clears it from the row", async () => {
    const limitMetadata = { provider: "OpenAI", credential: "Team key", meter: "Weekly" };
    const unsealed = await domain.inspect(ctx, "notifications", { ...generic, kind: "limit_low", title: notificationTitle("limit_low"), limitMetadata });
    expect(unsealed?.value).toMatchObject({ limitMetadata, body: "Team key · OpenAI · Weekly" });
    expect(unsealed?.patch).toHaveProperty("limitMetadata", undefined);
    const sealed = await domain.inspect(ctx, "notifications", {
      ...generic, kind: "limit_low", title: notificationTitle("limit_low"), limitMetadata, sealed: { keyId: "k", box: new ArrayBuffer(1) },
    });
    expect(sealed?.value).toEqual({ limitMetadata });
  });

  it("ignores generic and natively sealed notifications but blocks sealed rows with plaintext", async () => {
    expect(await domain.inspect(ctx, "notifications", generic)).toBeNull();
    expect(await domain.inspect(ctx, "notifications", { ...generic, sealed: { keyId: "k", box: new ArrayBuffer(1) } })).toBeNull();
    await expect(domain.inspect(ctx, "notifications", { ...generic, body: "leak", sealed: { keyId: "k", box: new ArrayBuffer(1) } })).rejects.toThrow();
  });
});
