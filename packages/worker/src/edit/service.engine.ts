import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { WorkerEditService } from "./service.js";
import type { WorkerEditRequest } from "backend/src/worker/edit-contract";
import { WorkerDirectoryEdits } from "./directories.js";

type WorkerWriteMode = "edit" | "create";

const temporaryDirectories: string[] = [];
const services: WorkerEditService[] = [];
const directoryEditors: WorkerDirectoryEdits[] = [];

afterEach(async () => {
  await Promise.all(directoryEditors.splice(0).map((editor) => editor.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("reads hashline snapshots, previews with the native engine, and writes only after apply", async () => {
  const { root, service } = await newService();
  const file = join(root, "sample.txt");
  await writeFile(file, "first\nsecond\n");

  const read = await request(service, { kind: "read", path: "sample.txt" });
  expect(read.ok).toBe(true);
  expect(read.content).toContain("[sample.txt#");
  expect(read.content).toContain("1:first\n2:second");
  expect(read.instructions).toContain("Hashline patches");
  expect(read.grammar).toContain("file_header");
  const header = String(read.content).split("\n", 1)[0];

  const preview = await request(service, {
    kind: "preview",
    patch: `${header}\nPUT 2.=2:\n+SECOND\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  expect(preview.previewId).toEqual(expect.any(String));
  expect(preview.result.files[0]).toMatchObject({ path: "sample.txt", op: "update" });
  expect(preview.result.files[0].diff).toContain("SECOND");
  expect(await readFile(file, "utf8")).toBe("first\nsecond\n");

  const applied = await request(service, {
    kind: "apply",
    previewId: String(preview.previewId),
  });
  expect(applied.ok).toBe(true);
  expect(applied.result.files[0].diff).toContain("SECOND");
  expect(await readFile(file, "utf8")).toBe("first\nSECOND\n");

  const refreshedHeader = String(applied.result.files[0].text).split("\n", 1)[0];
  const nextPreview = await request(service, {
    kind: "preview",
    patch: `${refreshedHeader}\nPUT 1.=1:\n+FIRST\n*** End Patch`,
  });
  expect(nextPreview.ok).toBe(true);
  const nextApply = await request(service, {
    kind: "apply",
    previewId: String(nextPreview.previewId),
  });
  expect(nextApply.ok).toBe(true);
  expect(await readFile(file, "utf8")).toBe("FIRST\nSECOND\n");
});

test("native stale-snapshot rejection returns engine context and does not write", async () => {
  const { root, service } = await newService();
  const file = join(root, "stale.txt");
  await writeFile(file, "before\nafter\n");
  const read = await request(service, { kind: "read", path: "stale.txt" });
  const header = String(read.content).split("\n", 1)[0];
  await writeFile(file, "changed\nafter\n");

  const preview = await request(service, {
    kind: "preview",
    patch: `${header}\nPUT 1.=1:\n+replacement\n*** End Patch`,
  });
  expect(preview).toMatchObject({ ok: false, code: "EDIT_REJECTED" });
  expect(preview.message).toContain("file changed between read and edit");
  expect(await readFile(file, "utf8")).toBe("changed\nafter\n");
});

test("apply refuses a preview whose target changed after approval was requested", async () => {
  const { root, service } = await newService();
  const file = join(root, "pending.txt");
  await writeFile(file, "original\n");
  const read = await request(service, { kind: "read", path: "pending.txt" });
  const preview = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n", 1)[0]}\nPUT 1.=1:\n+edited\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  await writeFile(file, "concurrent change\n");

  const applied = await request(service, {
    kind: "apply",
    previewId: String(preview.previewId),
  });
  expect(applied).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
  expect(await readFile(file, "utf8")).toBe("concurrent change\n");
});

test("uses host preimages when native results prune large old/new text snapshots", async () => {
  const { root, service } = await newService();
  const file = join(root, "large.txt");
  const original = `replace me\n${Array.from({ length: 3_000 }, () => "unchanged padding").join("\n")}\n`;
  await writeFile(file, original);
  const read = await request(service, { kind: "read", path: "large.txt" });
  expect(read.truncated).toBe(true);

  const preview = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n", 1)[0]}\nPUT 1.=1:\n+replaced\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  const applied = await request(service, {
    kind: "apply",
    previewId: String(preview.previewId),
  });
  expect(applied.ok).toBe(true);
  expect(await readFile(file, "utf8")).toBe(original.replace("replace me", "replaced"));
});

test("each request session has independent native snapshots and stale recovery state", async () => {
  const { root, service } = await newService();
  const file = join(root, "isolation.txt");
  await writeFile(file, "alpha\nbeta\ngamma\n");
  const read = await request(service, { kind: "read", path: "isolation.txt" }, "session-a");
  const header = String(read.content).split("\n", 1)[0];
  await writeFile(file, "preamble\nalpha\nbeta\ngamma\n");
  const patch = `${header}\nPUT 2.=2:\n+BETA\n*** End Patch`;

  const isolated = await request(service, { kind: "preview", patch }, "session-b");
  expect(isolated).toMatchObject({ ok: false, code: "EDIT_REJECTED" });

  const recovering = await request(service, { kind: "preview", patch }, "session-a");
  expect(recovering.ok).toBe(true);
  expect(recovering.result.files[0].diff).toContain("BETA");
  expect(await readFile(file, "utf8")).toBe("preamble\nalpha\nbeta\ngamma\n");
});

test("native move and delete requests are staged and applied as filesystem operations", async () => {
  const { root, service } = await newService();
  const source = join(root, "source.txt");
  const deleted = join(root, "deleted.txt");
  await writeFile(source, "move me\n");
  await chmod(source, 0o755);
  await writeFile(deleted, "remove me\n");

  const sourceRead = await request(service, { kind: "read", path: "source.txt" });
  const movePreview = await request(service, {
    kind: "preview",
    patch: `${String(sourceRead.content).split("\n", 1)[0]}\nMV moved.txt\n*** End Patch`,
  });
  expect(movePreview.ok).toBe(true);
  expect(movePreview.result.files[0].moveTo).toBe("moved.txt");
  expect(await readFile(source, "utf8")).toBe("move me\n");
  const moveResult = await request(service, {
    kind: "apply",
    previewId: String(movePreview.previewId),
  });
  expect(moveResult.ok).toBe(true);
  expect(await readFile(join(root, "moved.txt"), "utf8")).toBe("move me\n");
  expect((await stat(join(root, "moved.txt"))).mode & 0o777).toBe(0o755);
  await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });

  const deleteRead = await request(service, { kind: "read", path: "deleted.txt" });
  const deletePreview = await request(service, {
    kind: "preview",
    patch: `${String(deleteRead.content).split("\n", 1)[0]}\nREM\n*** End Patch`,
  });
  expect(deletePreview.ok).toBe(true);
  expect(await readFile(deleted, "utf8")).toBe("remove me\n");
  const deleteResult = await request(service, {
    kind: "apply",
    previewId: String(deletePreview.previewId),
  });
  expect(deleteResult.ok).toBe(true);
  await expect(readFile(deleted)).rejects.toMatchObject({ code: "ENOENT" });
});

test("native hashline insert and cut/paste operations preserve the engine diff and result", async () => {
  const { root, service } = await newService();
  const inserted = join(root, "insert.txt");
  const movedLine = join(root, "register.txt");
  await writeFile(inserted, "one\ntwo\n");
  await writeFile(movedLine, "one\ntwo\n");

  const readInsert = await request(service, { kind: "read", path: "insert.txt" });
  const insertPreview = await request(service, {
    kind: "preview",
    patch: `${String(readInsert.content).split("\n", 1)[0]}\nPUT >1:\n+inserted\n*** End Patch`,
  });
  expect(insertPreview.ok).toBe(true);
  expect(insertPreview.result.files[0].diff).toContain("inserted");
  const insertResult = await request(service, {
    kind: "apply",
    previewId: String(insertPreview.previewId),
  });
  expect(insertResult.ok).toBe(true);
  expect(await readFile(inserted, "utf8")).toBe("one\ninserted\ntwo\n");

  const readRegister = await request(service, { kind: "read", path: "register.txt" });
  const registerPreview = await request(service, {
    kind: "preview",
    patch: `${String(readRegister.content).split("\n", 1)[0]}\nCUT 1.=1 @line\nPUT >2 @line\n*** End Patch`,
  });
  expect(registerPreview.ok).toBe(true);
  expect(registerPreview.result.files[0].diff).toContain("one");
  const registerResult = await request(service, {
    kind: "apply",
    previewId: String(registerPreview.previewId),
  });
  expect(registerResult.ok).toBe(true);
  expect(await readFile(movedLine, "utf8")).toBe("two\none\n");
});

test("native apply_patch creates files through the guarded host writer", async () => {
  const { root, service } = await newService();
  const file = join(root, "created", "new.txt");
  const patch = "*** Begin Patch\n*** Add File: created/new.txt\n+new file\n*** End Patch";

  const preview = await request(service, { kind: "preview", patch });
  expect(preview).toMatchObject({ ok: true, mode: "apply_patch" });
  expect(preview.grammar).toContain("add_hunk");
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });

  const applied = await request(service, {
    kind: "apply",
    previewId: String(preview.previewId),
  });
  expect(applied.ok).toBe(true);
  expect(await readFile(file, "utf8")).toBe("new file\n");
});

test("edit mode rejects native file creation before staging", async () => {
  const { root, service } = await newService();
  const file = join(root, "new.txt");
  const patch = "*** Begin Patch\n*** Add File: new.txt\n+new file\n*** End Patch";

  const preview = await request(service, { kind: "preview", patch }, "session-default", "edit");
  expect(preview).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("create mode rejects native file updates before staging", async () => {
  const { root, service } = await newService();
  const file = join(root, "existing.txt");
  await writeFile(file, "original\n");
  const patch =
    "*** Begin Patch\n*** Update File: existing.txt\n@@\n-original\n+changed\n*** End Patch";

  const preview = await request(service, { kind: "preview", patch }, "session-default", "create");
  expect(preview).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  expect(await readFile(file, "utf8")).toBe("original\n");
});

test("a mixed native patch is rejected without accepting any staged writes", async () => {
  const { root, service } = await newService();
  const existing = join(root, "existing.txt");
  const created = join(root, "created.txt");
  await writeFile(existing, "original\n");
  const patch =
    "*** Begin Patch\n*** Update File: existing.txt\n@@\n-original\n+changed\n*** Add File: created.txt\n+new file\n*** End Patch";

  const preview = await request(service, { kind: "preview", patch }, "session-default", "edit");
  expect(preview).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  expect(await readFile(existing, "utf8")).toBe("original\n");
  await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
});

test("edit mode rejects native delete and move intents", async () => {
  const { root, service } = await newService();
  const deleted = join(root, "deleted.txt");
  const source = join(root, "source.txt");
  const destination = join(root, "destination.txt");
  await writeFile(deleted, "keep deleted file\n");
  await writeFile(source, "keep source file\n");

  const deleteRead = await request(service, { kind: "read", path: "deleted.txt" }, "delete-mode");
  const deletePreview = await request(
    service,
    {
      kind: "preview",
      patch: `${String(deleteRead.content).split("\n", 1)[0]}\nREM\n*** End Patch`,
    },
    "delete-mode",
    "edit",
  );
  expect(deletePreview).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  expect(await readFile(deleted, "utf8")).toBe("keep deleted file\n");

  const moveRead = await request(service, { kind: "read", path: "source.txt" }, "move-mode");
  const movePreview = await request(
    service,
    {
      kind: "preview",
      patch: `${String(moveRead.content).split("\n", 1)[0]}\nMV destination.txt\n*** End Patch`,
    },
    "move-mode",
    "edit",
  );
  expect(movePreview).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  expect(await readFile(source, "utf8")).toBe("keep source file\n");
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("apply requires the preview's write mode and keeps a mismatched preview unapplied", async () => {
  const { root, service } = await newService();
  const file = join(root, "new.txt");
  const patch = "*** Begin Patch\n*** Add File: new.txt\n+new file\n*** End Patch";
  const preview = await request(service, { kind: "preview", patch }, "session-default", "create");
  expect(preview.ok).toBe(true);

  const mismatch = await request(
    service,
    { kind: "apply", previewId: String(preview.previewId) },
    "session-default",
    "edit",
  );
  expect(mismatch).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });

  const applied = await request(
    service,
    { kind: "apply", previewId: String(preview.previewId) },
    "session-default",
    "create",
  );
  expect(applied.ok).toBe(true);
  expect(await readFile(file, "utf8")).toBe("new file\n");
});

test("mode-constrained native creation and hashline updates apply when modes match", async () => {
  const { root, service } = await newService();
  const created = join(root, "created.txt");
  const createPreview = await request(
    service,
    {
      kind: "preview",
      patch: "*** Begin Patch\n*** Add File: created.txt\n+created\n*** End Patch",
    },
    "create-session",
    "create",
  );
  expect(createPreview.ok).toBe(true);
  expect(
    (
      await request(
        service,
        { kind: "apply", previewId: String(createPreview.previewId) },
        "create-session",
        "create",
      )
    ).ok,
  ).toBe(true);
  expect(await readFile(created, "utf8")).toBe("created\n");

  const edited = join(root, "edited.txt");
  await writeFile(edited, "before\nafter\n");
  const read = await request(service, { kind: "read", path: "edited.txt" }, "edit-session");
  const editPreview = await request(
    service,
    {
      kind: "preview",
      patch: `${String(read.content).split("\n", 1)[0]}\nPUT 1.=1:\n+changed\n*** End Patch`,
    },
    "edit-session",
    "edit",
  );
  expect(editPreview.ok).toBe(true);
  expect(
    (
      await request(
        service,
        { kind: "apply", previewId: String(editPreview.previewId) },
        "edit-session",
        "edit",
      )
    ).ok,
  ).toBe(true);
  expect(await readFile(edited, "utf8")).toBe("changed\nafter\n");
});

test("a constrained apply also checks writes from a legacy unrestricted preview", async () => {
  const { root, service } = await newService();
  const file = join(root, "legacy.txt");
  const preview = await request(service, {
    kind: "preview",
    patch: "*** Begin Patch\n*** Add File: legacy.txt\n+new file\n*** End Patch",
  });
  expect(preview.ok).toBe(true);
  const denied = await request(
    service,
    {
      kind: "apply",
      previewId: String(preview.previewId),
    },
    "session-default",
    "edit",
  );
  expect(denied).toMatchObject({ ok: false, code: "WRITE_MODE_DENIED" });
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects traversal and symlink escapes for reads, deletes, and new move destinations", async () => {
  const temp = await temporaryDirectory();
  temporaryDirectories.push(temp);
  const root = join(temp, "root");
  const outside = join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await writeFile(join(root, "source.txt"), "source\n");
  await symlink(outside, join(root, "escape"));
  const service = await WorkerEditService.create(root);
  services.push(service);

  expect(await request(service, { kind: "read", path: "../outside/secret.txt" })).toMatchObject({
    ok: false,
    code: "PATH_OUTSIDE_ROOT",
  });
  expect(await request(service, { kind: "read", path: "escape/secret.txt" })).toMatchObject({
    ok: false,
    code: "PATH_OUTSIDE_ROOT",
  });

  const deletePreview = await request(service, {
    kind: "preview",
    patch: "[escape/secret.txt#0000]\nREM\n*** End Patch",
  });
  expect(deletePreview).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" });
  const read = await request(service, { kind: "read", path: "source.txt" });
  const move = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n", 1)[0]}\nMV escape/new.txt\n*** End Patch`,
  });
  expect(move).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" });
  const create = await request(service, {
    kind: "preview",
    patch: "*** Begin Patch\n*** Add File: escape/created.txt\n+outside\n*** End Patch",
  });
  expect(create).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" });
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(outside, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

async function newService(): Promise<{ root: string; service: WorkerEditService }> {
  const temp = await temporaryDirectory();
  temporaryDirectories.push(temp);
  const root = join(temp, "root");
  await mkdir(root);
  const service = await WorkerEditService.create(root);
  services.push(service);
  return { root, service };
}

async function temporaryDirectory(): Promise<string> {
  const base = join(tmpdir(), "opencode");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "radium-worker-edit-"));
}

async function request(
  service: WorkerEditService,
  action: WorkerEditRequest["action"],
  sessionId = "session-default",
  writeMode?: WorkerWriteMode,
): Promise<Record<string, any>> {
  const workerRequest: WorkerEditRequest = {
    sessionId,
    action,
    ...(writeMode === undefined ? {} : { writeMode }),
  };
  return JSON.parse(await service.execute(workerRequest)) as Record<string, any>;
}

test("paged reads retain visible-line provenance across the beginning and end of a file", async () => {
  const { root, service } = await newService();
  const lines = Array.from({ length: 100 }, (_, index) => `${index + 1} ${"x".repeat(1000)}`);
  await writeFile(join(root, "pages.txt"), lines.join("\n") + "\n");
  const first = await request(service, { kind: "read", path: "pages.txt", maxLines: 2 });
  expect(first).toMatchObject({ truncated: true, nextLine: 3 });
  const last = await request(service, {
    kind: "read",
    path: "pages.txt",
    startLine: 100,
    maxLines: 1,
  });
  expect(last.content).toContain("100:100");
  const header = String(last.content).split("\n", 1)[0];
  const preview = await request(service, {
    kind: "preview",
    patch: `${header}\nPUT 1.=1:\n+first\nPUT 100.=100:\n+last\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  const applied = await request(service, { kind: "apply", previewId: preview.previewId });
  expect(applied.ok).toBe(true);
  const edited = (await readFile(join(root, "pages.txt"), "utf8")).split("\n");
  expect(edited[0]).toBe("first");
  expect(edited[99]).toBe("last");
});

test("concurrent session applies serialize so a competing stale preview cannot overwrite an edit", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "shared.txt"), "original\n");
  const readA = await request(service, { kind: "read", path: "shared.txt" }, "a");
  const readB = await request(service, { kind: "read", path: "shared.txt" }, "b");
  const a = await request(
    service,
    {
      kind: "preview",
      patch: `${String(readA.content).split("\n")[0]}\nPUT 1.=1:\n+A\n*** End Patch`,
    },
    "a",
  );
  const b = await request(
    service,
    {
      kind: "preview",
      patch: `${String(readB.content).split("\n")[0]}\nPUT 1.=1:\n+B\n*** End Patch`,
    },
    "b",
  );
  const results = await Promise.all([
    request(service, { kind: "apply", previewId: a.previewId }, "a"),
    request(service, { kind: "apply", previewId: b.previewId }, "b"),
  ]);
  expect(results[0]?.ok).toBe(true);
  expect(results[1]).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
  expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("A\n");
});

test("replacing the configured root with an external symlink cannot redirect later requests", async () => {
  const { root, service } = await newService();
  const outside = join(root, "..", "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside\n");
  await rename(root, `${root}-original`);
  await symlink(outside, root);
  expect(await request(service, { kind: "read", path: "secret.txt" })).toMatchObject({
    ok: false,
    code: "PATH_OUTSIDE_ROOT",
  });
  expect(
    await request(service, {
      kind: "preview",
      patch: "*** Begin Patch\n*** Add File: created.txt\n+outside\n*** End Patch",
    }),
  ).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" });
  await expect(readFile(join(outside, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("session disposal and consumed previews cannot replay an edit", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "once.txt"), "old\n");
  const read = await request(service, { kind: "read", path: "once.txt" });
  const preview = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n")[0]}\nPUT 1.=1:\n+new\n*** End Patch`,
  });
  expect((await request(service, { kind: "apply", previewId: preview.previewId })).ok).toBe(true);
  expect(await request(service, { kind: "apply", previewId: preview.previewId })).toMatchObject({
    ok: false,
    code: "UNKNOWN_PREVIEW",
  });
  await request(service, { kind: "close" });
  expect(await request(service, { kind: "apply", previewId: preview.previewId })).toMatchObject({
    ok: false,
    code: "UNKNOWN_SESSION",
  });
});

test("UTF-8 BOM text remains intact when editing another line", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "bom.txt"), "\uFEFFkeep\nold\n");
  const read = await request(service, { kind: "read", path: "bom.txt" });
  const preview = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n")[0]}\nPUT 2.=2:\n+new\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  expect((await request(service, { kind: "apply", previewId: preview.previewId })).ok).toBe(true);
  expect(await readFile(join(root, "bom.txt"), "utf8")).toBe("\uFEFFkeep\nnew\n");
});

test("native syntax-block replacement keeps the neighboring function intact", async () => {
  const { root, service } = await newService();
  await writeFile(
    join(root, "blocks.ts"),
    "function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n",
  );
  const read = await request(service, { kind: "read", path: "blocks.ts" });
  const preview = await request(service, {
    kind: "preview",
    patch: `${String(read.content).split("\n")[0]}\nPUT 1*:\n+function first() {\n+  return 3;\n+}\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  expect((await request(service, { kind: "apply", previewId: preview.previewId })).ok).toBe(true);
  expect(await readFile(join(root, "blocks.ts"), "utf8")).toBe(
    "function first() {\n  return 3;\n}\nfunction second() {\n  return 2;\n}\n",
  );
});

test("native named registers persist across staged and applied calls within one session", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "from.txt"), "move me\nkeep\n");
  await writeFile(join(root, "to.txt"), "destination\n");
  const from = await request(service, { kind: "read", path: "from.txt" });
  const to = await request(service, { kind: "read", path: "to.txt" });
  const cut = await request(service, {
    kind: "preview",
    patch: `${String(from.content).split("\n")[0]}\nCUT 1.=1 @saved\n*** End Patch`,
  });
  expect(cut.ok).toBe(true);
  expect((await request(service, { kind: "apply", previewId: cut.previewId })).ok).toBe(true);
  const paste = await request(service, {
    kind: "preview",
    patch: `${String(to.content).split("\n")[0]}\nPUT >1 @saved\n*** End Patch`,
  });
  expect(paste.ok).toBe(true);
  expect((await request(service, { kind: "apply", previewId: paste.previewId })).ok).toBe(true);
  expect(await readFile(join(root, "from.txt"), "utf8")).toBe("keep\n");
  expect(await readFile(join(root, "to.txt"), "utf8")).toBe("destination\nmove me\n");
});

test("a rejected oversized read does not grant visible-line provenance for its undisplayed page", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "escaped.txt"), `shown\n${"\u0001".repeat(40000)}\n`);
  const shown = await request(service, { kind: "read", path: "escaped.txt", maxLines: 1 });
  expect(shown.ok).toBe(true);
  const hidden = await request(service, {
    kind: "read",
    path: "escaped.txt",
    startLine: 2,
    maxLines: 1,
  });
  expect(hidden).toMatchObject({ ok: false, code: "OUTPUT_TOO_LARGE" });
  const preview = await request(service, {
    kind: "preview",
    patch: `${String(shown.content).split("\n")[0]}\nCUT 2.=2\n*** End Patch`,
  });
  expect(preview).toMatchObject({ ok: false, code: "EDIT_REJECTED" });
  expect(await readFile(join(root, "escaped.txt"), "utf8")).toBe(
    `shown\n${"\u0001".repeat(40000)}\n`,
  );
});

test("unapplied CUT state cannot be consumed by a later preview", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "cut.txt"), "keep on disk\n");
  await writeFile(join(root, "paste.txt"), "destination\n");
  const cutRead = await request(service, { kind: "read", path: "cut.txt" });
  const pasteRead = await request(service, { kind: "read", path: "paste.txt" });
  const cut = await request(service, {
    kind: "preview",
    patch: `${String(cutRead.content).split("\n")[0]}\nCUT 1.=1 @pending\n*** End Patch`,
  });
  expect(cut.ok).toBe(true);
  const pastePatch = `${String(pasteRead.content).split("\n")[0]}\nPUT >1 @pending\n*** End Patch`;
  expect(await request(service, { kind: "preview", patch: pastePatch })).toMatchObject({
    ok: false,
    code: "PENDING_PREVIEW",
  });
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
  try {
    const refreshed = await request(service, { kind: "read", path: "paste.txt" });
    const expiredPaste = `${String(refreshed.content).split("\n")[0]}\nPUT >1 @pending\n*** End Patch`;
    expect((await request(service, { kind: "preview", patch: expiredPaste })).ok).toBe(false);
  } finally {
    clock.mockRestore();
  }
  expect(await readFile(join(root, "cut.txt"), "utf8")).toBe("keep on disk\n");
  expect(await readFile(join(root, "paste.txt"), "utf8")).toBe("destination\n");
});

test("failed first reads release session slots", async () => {
  const { root, service } = await newService();
  for (let index = 0; index < 65; index += 1) {
    expect(
      await request(service, { kind: "read", path: "missing.txt" }, `failed-${index}`),
    ).toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
  }
  await writeFile(join(root, "valid.txt"), "readable\n");
  expect((await request(service, { kind: "read", path: "valid.txt" }, "valid")).ok).toBe(true);
});

test("the published hashline grammar's Begin Patch envelope selects hashline mode", async () => {
  const { root, service } = await newService();
  await writeFile(join(root, "envelope.txt"), "old\n");
  const read = await request(service, { kind: "read", path: "envelope.txt" });
  const preview = await request(service, {
    kind: "preview",
    patch: `*** Begin Patch\n${String(read.content).split("\n")[0]}\nPUT 1.=1:\n+new\n*** End Patch`,
  });
  expect(preview).toMatchObject({ ok: true, mode: "hashline" });
  expect((await request(service, { kind: "apply", previewId: preview.previewId })).ok).toBe(true);
  expect(await readFile(join(root, "envelope.txt"), "utf8")).toBe("new\n");
});

test("backend directories select the filesystem and bind previews until the session closes", async () => {
  const { root } = await newService();
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(join(a, "file.txt"), "A\n");
  await writeFile(join(b, "file.txt"), "B\n");
  const editor = new WorkerDirectoryEdits();
  directoryEditors.push(editor);
  const run = async (
    directory: string,
    action: WorkerEditRequest["action"],
    sessionId = "backend-session",
  ) => JSON.parse(await editor.execute({ directory, sessionId, action }));
  const read = await run(a, { kind: "read", path: "file.txt" });
  expect(read.content).toContain("1:A");
  const preview = await run(a, {
    kind: "preview",
    patch: `${String(read.content).split("\n")[0]}\nPUT 1.=1:\n+changed A\n*** End Patch`,
  });
  expect(preview.ok).toBe(true);
  expect(await run(b, { kind: "apply", previewId: preview.previewId })).toMatchObject({
    ok: false,
    code: "SESSION_DIRECTORY_CHANGED",
  });
  expect((await run(a, { kind: "apply", previewId: preview.previewId })).ok).toBe(true);
  expect(await readFile(join(a, "file.txt"), "utf8")).toBe("changed A\n");
  expect(await readFile(join(b, "file.txt"), "utf8")).toBe("B\n");
  expect(await run(a, { kind: "read", path: "../b/file.txt" })).toMatchObject({
    ok: false,
    code: "PATH_OUTSIDE_ROOT",
  });
  await run(a, { kind: "close" });
  const switched = await run(b, { kind: "read", path: "file.txt" });
  expect(switched.content).toContain("1:B");
  expect(await run(b, { kind: "apply", previewId: preview.previewId })).toMatchObject({
    ok: false,
    code: "UNKNOWN_PREVIEW",
  });
});
