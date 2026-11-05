import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayKeyStore } from "./gateway.js";
import { forgetWorkerState } from "./state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "radium-gateway-key-"));
  directories.push(path);
  return path;
}

describe("Worker Gateway key storage", () => {
  it("persists and replaces a private secret independently of machine state", async () => {
    const root = await directory();
    const store = createGatewayKeyStore(root);
    expect(await store.get()).toBeNull();
    await store.set({ keyId: "first", key: "first-secret" });
    expect(await createGatewayKeyStore(root).get()).toEqual({
      keyId: "first",
      key: "first-secret",
    });
    const path = join(root, ".worker-gateway-key.json");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    await store.set({ keyId: "second", key: "second-secret" });
    expect(await store.get()).toEqual({ keyId: "second", key: "second-secret" });
    await store.delete();
    expect(await store.get()).toBeNull();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe files and wipes a leftover key even without an identity file", async () => {
    const root = await directory();
    const store = createGatewayKeyStore(root);
    await store.set({ keyId: "id", key: "secret" });
    const path = join(root, ".worker-gateway-key.json");
    await chmod(path, 0o644);
    await expect(store.get()).rejects.toThrow("permissions are too broad");
    await forgetWorkerState(root);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const target = join(root, "target");
    await writeFile(target, "do not touch", { mode: 0o600 });
    await symlink(target, path);
    await expect(store.get()).rejects.toThrow("private regular file");
    await expect(store.delete()).rejects.toThrow("private regular file");
    expect(await readFile(target, "utf8")).toBe("do not touch");
  });
});
