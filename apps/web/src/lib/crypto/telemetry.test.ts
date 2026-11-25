import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  createCapsule, encodeCapsule, fromBase64Url, generateEncryptionKeyPair, sealWithCapsule, toBase64Url, utf8,
} from "radium-crypto";
import { keyManager } from "./key-manager";
import * as workspaceKeys from "./workspace-keys";
import * as legacyContent from "./legacy-content";
import { hasSealedTelemetry, openTelemetryData, telemetryContent } from "./telemetry";
import { telemetryToolChanges } from "@/components/gateway/telemetry-utils";

const workspace = "telemetry-test";
const requestId = "capture-uuid";
const hash = "opaque-keyed-hash";
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
    id: "blob", hash, kind: "message" as const, size: 50,
    redacted: false, content: '"unsafe plaintext sibling"', meta: { role: "unsafe sibling" },
    sealed: { epoch: 3, requestId, capsule: toBase64Url(encodeCapsule(batch.capsule)), envelope: toBase64Url(envelope), storageUrl: null as string | null },
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
    expect(telemetryContent.get(source, "different-workspace")).toBeUndefined();
  });

  test("downloads encrypted bytes and decrypts locally rather than linking to ciphertext", async () => {
    const { blob } = await fixture();
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(fromBase64Url(blob.sealed.envelope).slice().buffer as ArrayBuffer));
    const source = { ...blob, sealed: { ...blob.sealed, envelope: null, storageUrl: "https://storage.invalid/sealed" } };
    await openTelemetryData(source, workspace);
    expect(telemetryContent.get(source, workspace)?.data?.content).toContain("Private answer");
    expect(telemetryContent.get(source, workspace)?.data?.sealed).toBeNull();
  });

  test("wrong workspace, substituted record, corrupted bytes and download failures never use plaintext", async () => {
    const { blob } = await fixture();
    const damaged = fromBase64Url(blob.sealed.envelope);
    damaged[40] ^= 1;
    const tampered = toBase64Url(damaged);
    const cases = [
      { source: { ...blob }, workspace: "other" },
      { source: { ...blob, hash: "substituted" }, workspace },
      { source: { ...blob, sealed: { ...blob.sealed, envelope: tampered } }, workspace },
      { source: { ...blob, sealed: { ...blob.sealed, envelope: null, storageUrl: "https://storage.invalid/missing" } }, workspace },
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
    const source = { ...blob, sealed: { ...blob.sealed, envelope: null, storageUrl: "https://storage.invalid/delayed" } };
    const opening = openTelemetryData(source, workspace);
    spyOn(keyManager, "getSnapshot").mockReturnValue({ state: "locked", userId: "owner" });
    response.resolve(new Response(fromBase64Url(blob.sealed.envelope).slice().buffer as ArrayBuffer));
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
      requestId, sealedError: { ...blob.sealed, envelope: toBase64Url(envelope) },
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

  test("opens historical sidecars by record and keeps custodial parts hidden without failing the request", async () => {
    await fixture();
    const box = (kind: "workspace_owner" | "custody") => ({ kind, keyId: "k", epoch: 3, box: new ArrayBuffer(1) });
    spyOn(legacyContent, "openLegacyContent").mockImplementation(async (sealed, context) => {
      if (sealed.kind === "custody") throw new legacyContent.CustodialContentError();
      if (context.table === "telemetry_blobs") return { content: '"old"', meta: { role: "user" }, legacyHash: "old" } as never;
      return { error: { message: "Old failure" }, attempts: ["Old attempt"] } as never;
    });
    const source = {
      open: { id: "b1", hash: "h1", kind: "message", size: 1, redacted: true, legacyContent: box("workspace_owner") },
      custodial: { id: "b2", hash: "h2", kind: "message", size: 1, redacted: true, legacyContent: box("custody") },
      request: { id: "r1", requestId: "r1", attempts: [{ provider: "p" }], legacyContent: box("workspace_owner") },
    };
    expect(hasSealedTelemetry(source)).toBe(true);
    await openTelemetryData(source, workspace);
    const opened = telemetryContent.get(source, workspace)?.data;
    expect(opened?.open).toMatchObject({ content: '"old"', meta: { role: "user" }, redacted: false });
    expect(opened?.custodial).toMatchObject({ content: null, redacted: true });
    expect(opened?.request).toMatchObject({ error: { message: "Old failure" }, attempts: [{ provider: "p", message: "Old attempt" }] });
  });

  test("tool diffs compare decrypted names but keyed definition hashes", () => {
    const tool = (name: string, hash: string) => ({ hash, content: null, meta: { names: [name] } });
    const changes = telemetryToolChanges(
      [tool("read", "old"), tool("write", "same")],
      [tool("write", "same"), tool("read", "new"), tool("bash", "added")],
    );
    expect(changes.changed.map((item) => item.name)).toEqual(["read"]);
    expect(changes.added.map((item) => item.name)).toEqual(["bash"]);
    expect(changes.reordered).toBe(true);
  });
});
