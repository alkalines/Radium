import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { legacyAad } from "contracts/e2ee/legacy-contract";
import { sealBox, utf8 } from "radium-crypto";
import { normalizeDisplayName } from "contracts/workspaces/names";
import { getCurrentMemberPublicKey } from "./workspace-keys";
import { cryptoClient, buffer } from "./runtime";
import { keyManager, KeysLockedError } from "./key-manager";
import { openLegacyContent } from "./legacy-content";

/** Seals names/icons to the verified workspace audience; the server never receives their plaintext. */
export async function setEncryptedName(input: {
  target: Id<"workspaces"> | Id<"projects">;
  workspace: Id<"workspaces">;
  table: "workspaces" | "projects";
  name?: string;
  icon?: string;
}): Promise<void> {
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const current = await cryptoClient().query(api.e2ee_legacy.getName, { target: input.target });
  if (current.workspace !== input.workspace) throw new Error("Name workspace changed");
  const previous = current.legacyContent
    ? await openLegacyContent<{ name?: unknown; icon?: unknown }>(current.legacyContent, {
      table: input.table, record: input.target, workspace: input.workspace,
    })
    : current;
  if (typeof previous.name !== "string" || (previous.icon !== undefined && typeof previous.icon !== "string")) throw new Error("Invalid encrypted name");
  const icon = input.icon ?? previous.icon;
  const key = await getCurrentMemberPublicKey(input.workspace);
  if (!key) throw new Error("Set up workspace encryption before editing names");
  const name = normalizeDisplayName(input.name ?? previous.name, input.table === "workspaces" ? "Workspace" : "Project");
  const box = await sealBox({
    recipientPublicKey: key.publicKey,
    plaintext: utf8(JSON.stringify({ name, ...(icon !== undefined ? { icon } : {}) })),
    aad: legacyAad(input.table, input.target, input.workspace),
    pad: "content",
  });
  await cryptoClient().mutation(api.e2ee_legacy.setName, {
    target: input.target,
    expected: current.legacyContent ?? null,
    content: { kind: "workspace_member", keyId: key.keyId, epoch: key.epoch, box: buffer(box) },
  });
}
