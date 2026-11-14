import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  createCapsule, encodeCapsule, generateEncryptionKeyPair, sealWithCapsule, utf8,
} from "radium-crypto";
import { keyManager } from "./key-manager";
import * as workspaceKeys from "./workspace-keys";
import { hasSealedTelemetry, openTelemetryData, telemetryContent } from "./telemetry";
import { telemetryToolChanges } from "@/components/gateway/telemetry-utils";
import type { LoadedBlob } from "backend/src/telemetry/store";

const workspace = "telemetry-test" as Id<"workspaces">;
const requestId = "capture-uuid";
const hash = "opaque-keyed-hash";
const wire = (value: Uint8Array) => value.slice().buffer as ArrayBuffer;
afterEach(() => mock.restore());

async function fixture() {
  const owner = await generateEncryptionKeyPair();
  spyOn(keyManager, "getSnapshot").mockReturnValue({
    state: "unlocked", userId: "owner", keyId: "identity", fingerprint: "self",
  });
  spyOn(workspaceKeys, "getOwnerKey").mockResolvedValue({ ...owner, epoch: 3, keyId: "owner-key" });
  const batch = await createCapsule({
    recipientPublicKey: owner.publicKey,
    aad: { table: "telemetry_capsules", workspace, parent: requestId, record: requestId, field: "capsule" },
  });
  const envelope = await sealWithCapsule({
    ...batch, capsuleId: batch.capsule.capsuleId,
    plaintext: utf8(JSON.stringify({ content: '{"role":"assistant","content":"Private answer"}', meta: { role: "assistant" } })),
    aad: { table: "telemetry_blobs", workspace, parent: requestId, record: hash, field: "content" },
    pad: "content",
  });
  const blob = {
    id: "blob" as Id<"telemetry_blobs">, hash, kind: "message" as const, size: 50,
    redacted: false, content: '"unsafe plaintext sibling"', meta: { role: "unsafe sibling" },
    sealed: { epoch: 3, requestId, capsule: wire(encodeCapsule(batch.capsule)), envelope: wire(envelope) },
  };
  return { owner, batch, blob };
}

describe("owner-only telemetry content", () => {
  test("opens inline ciphertext, ignores plaintext siblings and preserves legacy rows", async () => {
    const { blob } = await fixture();
    const source = { blob, legacy: { content: '"legacy"' } };
    expect(hasSealedTelemetry(source)).toBe(true);
    await openTelemetryData(source, workspace);
    const opened = telemetryContent.get(source, workspace)?.data;
    expect(opened?.blob.content).toBe('{"role":"assistant","content":"Private answer"}');
    expect(opened?.blob.meta).toEqual({ role: "assistant" });
    expect(opened?.legacy).toEqual(source.legacy);
    expect(source.blob.content).toBe('"unsafe plaintext sibling"');
    expect(telemetryContent.get(source, "different-workspace" as Id<"workspaces">)).toBeUndefined();
  });

  test("downloads encrypted bytes and decrypts locally rather than linking to ciphertext", async () => {
    const { blob } = await fixture();
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(blob.sealed.envelope));
    const source = { ...blob, sealed: { ...blob.sealed, envelope: undefined, storageUrl: "https://storage.invalid/sealed" } };
    await openTelemetryData(source, workspace);
    expect(telemetryContent.get(source, workspace)?.data?.content).toContain("Private answer");
    expect(telemetryContent.get(source, workspace)?.data?.sealed).toBeUndefined();
  });

  test("wrong workspace, substituted record, corrupted bytes and download failures never use plaintext", async () => {
    const { blob } = await fixture();
    const tampered = blob.sealed.envelope.slice(0);
    new Uint8Array(tampered)[40] ^= 1;
    const cases = [
      { source: { ...blob }, workspace: "other" as Id<"workspaces"> },
      { source: { ...blob, hash: "substituted" }, workspace },
      { source: { ...blob, sealed: { ...blob.sealed, envelope: tampered } }, workspace },
      { source: { ...blob, sealed: { ...blob.sealed, envelope: undefined, storageUrl: "https://storage.invalid/missing" } }, workspace },
    ];
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    for (const item of cases) {
      await openTelemetryData(item.source, item.workspace);
      expect(telemetryContent.get(item.source, item.workspace)).toMatchObject({ failed: true });
      expect(telemetryContent.get(item.source, item.workspace)?.data).toBeUndefined();
    }
  });

  test("a lock during an outstanding download cannot publish decrypted content", async () => {
    const { blob } = await fixture();
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const source = { ...blob, sealed: { ...blob.sealed, envelope: undefined, storageUrl: "https://storage.invalid/delayed" } };
    const opening = openTelemetryData(source, workspace);
    spyOn(keyManager, "getSnapshot").mockReturnValue({ state: "locked", userId: "owner" });
    response.resolve(new Response(blob.sealed.envelope));
    await opening;
    expect(telemetryContent.get(source, workspace)?.data).toBeUndefined();
  });

  test("decrypts request and attempt errors together and rejects a swapped request", async () => {
    const { blob, batch } = await fixture();
    const envelope = await sealWithCapsule({
      ...batch, capsuleId: batch.capsule.capsuleId,
      plaintext: utf8(JSON.stringify({ error: { message: "Private failure", status: 502 }, attempts: [null, "Private upstream error"] })),
      aad: { table: "telemetry_requests", workspace, parent: requestId, record: requestId, field: "error" }, pad: "content",
    });
    const request: {
      requestId: string;
      sealedError: typeof blob.sealed;
      error: { message: string; status?: number };
      attempts: { message?: string }[];
    } = {
      requestId, sealedError: { ...blob.sealed, envelope: wire(envelope) },
      error: { message: "unsafe sibling" },
      attempts: [{ message: "unsafe first" }, { message: "unsafe second" }],
    };
    await openTelemetryData(request, workspace);
    expect(telemetryContent.get(request, workspace)?.data?.error).toEqual({ message: "Private failure", status: 502 });
    expect(telemetryContent.get(request, workspace)?.data?.attempts).toEqual([{ message: undefined }, { message: "Private upstream error" }]);
    const swapped = { ...request, requestId: "different-request" };
    await openTelemetryData(swapped, workspace);
    expect(telemetryContent.get(swapped, workspace)?.failed).toBe(true);
  });

  test("tool diffs compare decrypted names but keyed definition hashes", () => {
    const tool = (name: string, hash: string) => ({
      id: hash as Id<"telemetry_blobs">, hash, kind: "tool", size: 10, redacted: true, meta: { names: [name] },
    } as LoadedBlob);
    const changes = telemetryToolChanges(
      [tool("read", "old"), tool("write", "same")],
      [tool("write", "same"), tool("read", "new"), tool("bash", "added")],
    );
    expect(changes.changed.map((item) => item.name)).toEqual(["read"]);
    expect(changes.added.map((item) => item.name)).toEqual(["bash"]);
    expect(changes.reordered).toBe(true);
  });
});
