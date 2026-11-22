import { eq } from "drizzle-orm";
import type { LegacyBox } from "contracts/e2ee/legacy-contract";
import { base64urlBytes } from "contracts/wire";
import { CAPSULE_BYTES, decodeCapsule, decodeEnvelope, toBase64Url } from "radium-crypto";
import { z } from "zod";
import type { StoredJson } from "../db/columns";
import type { Database } from "../drivers/types";
import { currentMemberRecipient } from "../e2ee/workspace-keys";
import { AppError } from "../errors";
import { projects, workspaces } from "./schema";
import { lockWorkspace } from "./workspaces";

/**
 * Workspace and Project names and icons are sealed by clients to the workspace's current member
 * key (`legacy_content`, AAD `legacyAad(table, id, workspace)`); the server never receives them in
 * plaintext and keeps the placeholder `name` with no `icon`. Writes compare-and-swap against the
 * box the editor opened, so two editors cannot silently overwrite each other.
 */

/** Sealed names are small: a name of at most 80 characters and an icon name. */
const MAX_NAME_BOX_BYTES = 16_384;

/** A name box sealed to the current workspace member key. */
export const sealedNameInput = z.object({
  kind: z.literal("workspace_member"),
  keyId: z.string().max(32),
  epoch: z.number().int(),
  box: base64urlBytes(MAX_NAME_BOX_BYTES),
});

export type SealedNameInput = z.output<typeof sealedNameInput>;
type StoredBox = StoredJson<LegacyBox>;

/** The current box the editor opened, as last read (`null` for a never-sealed name). */
export const expectedNameInput = z
  .object({
    kind: z.string().max(32),
    keyId: z.string().max(32),
    epoch: z.number().int(),
    box: z.string().max(Math.ceil((MAX_NAME_BOX_BYTES * 4) / 3) + 4),
    storageId: z.string().max(256).optional(),
  })
  .nullable();

function sameBox(stored: StoredBox | null, expected: z.output<typeof expectedNameInput>) {
  if (stored === null || expected === null) {
    return stored === expected;
  }
  return (
    stored.kind === expected.kind &&
    stored.keyId === expected.keyId &&
    stored.epoch === expected.epoch &&
    stored.box === expected.box &&
    stored.storageId === expected.storageId
  );
}

/**
 * Stores `content` as the sealed name of `target` (a workspace, or a Project of it) after the
 * caller's write authority was checked. Holds the workspace row lock, so the key epoch the box is
 * checked against cannot rotate before commit.
 */
export async function setSealedName(
  db: Database,
  target: { table: "workspaces" | "projects"; id: string; workspace: string },
  content: SealedNameInput,
  expected: z.output<typeof expectedNameInput>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, target.workspace);
    const [row] =
      target.table === "workspaces"
        ? [{ legacyContent: workspace.legacyContent }]
        : await tx
            .select({ legacyContent: projects.legacyContent })
            .from(projects)
            .where(eq(projects.id, target.id))
            .for("update");
    if (!row) {
      throw new AppError("NOT_FOUND", "Project not found.");
    }
    if (!sameBox(row.legacyContent, expected)) {
      throw new AppError("CONFLICT", "Encrypted name changed; reopen the editor before saving.");
    }
    const recipient = await currentMemberRecipient(tx, workspace);
    if (!recipient || content.keyId !== recipient.keyId || content.epoch !== recipient.epoch) {
      throw new AppError("BAD_REQUEST", "Encrypted name requires the current workspace member key");
    }
    try {
      const capsule = decodeCapsule(content.box.subarray(0, CAPSULE_BYTES));
      const envelope = decodeEnvelope(content.box.subarray(CAPSULE_BYTES));
      if (capsule.suite !== envelope.suite) {
        throw new Error("suite mismatch");
      }
    } catch {
      throw new AppError("BAD_REQUEST", "Invalid encrypted name");
    }
    const stored: StoredBox = {
      kind: content.kind,
      keyId: content.keyId,
      epoch: content.epoch,
      box: toBase64Url(content.box),
    };
    if (target.table === "workspaces") {
      await tx
        .update(workspaces)
        .set({ name: "Workspace", icon: null, legacyContent: stored })
        .where(eq(workspaces.id, target.id));
    } else {
      await tx
        .update(projects)
        .set({ name: "Project", icon: null, legacyContent: stored })
        .where(eq(projects.id, target.id));
    }
  });
}
