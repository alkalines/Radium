import type { Id } from "backend/convex/_generated/dataModel";
import { legacyAad } from "contracts/e2ee/legacy-contract";
import { sealBox, toBase64Url, utf8 } from "radium-crypto";
import { normalizeDisplayName } from "contracts/workspaces/names";
import { trpcClient } from "@/lib/trpc-client";
import { getCurrentMemberPublicKey } from "./workspace-keys";
import { keyManager, KeysLockedError } from "./key-manager";
import { openLegacyContent } from "./legacy-content";

/**
 * Seals names/icons to the verified workspace audience; the server never receives their plaintext.
 * It writes through tRPC without refreshing React Query: callers invalidate the workspace or
 * project lists afterwards.
 */
export async function setEncryptedName(input: {
  target: Id<"workspaces"> | Id<"projects">;
  workspace: Id<"workspaces">;
  table: "workspaces" | "projects";
  name?: string;
  icon?: string;
}): Promise<void> {
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  const client = trpcClient();
  const current = input.table === "workspaces"
    ? await client.workspaces.sealedName.query({ workspace: input.target })
    : await client.projects.sealedName.query({ project: input.target });
  if (current.workspace !== input.workspace) throw new Error("Name workspace changed");
  const previous = current.legacyContent
    ? await openLegacyContent<{ name?: unknown; icon?: unknown }>(current.legacyContent, {
      table: input.table, record: input.target, workspace: input.workspace,
    })
    : current;
  const previousIcon = previous.icon ?? undefined;
  if (typeof previous.name !== "string" || (previousIcon !== undefined && typeof previousIcon !== "string")) throw new Error("Invalid encrypted name");
  const icon = input.icon ?? previousIcon;
  const key = await getCurrentMemberPublicKey(input.workspace);
  if (!key) throw new Error("Set up workspace encryption before editing names");
  const name = normalizeDisplayName(input.name ?? previous.name, input.table === "workspaces" ? "Workspace" : "Project");
  const box = await sealBox({
    recipientPublicKey: key.publicKey,
    plaintext: utf8(JSON.stringify({ name, ...(icon !== undefined ? { icon } : {}) })),
    aad: legacyAad(input.table, input.target, input.workspace),
    pad: "content",
  });
  const change = {
    expected: current.legacyContent ?? null,
    content: { kind: "workspace_member" as const, keyId: key.keyId, epoch: key.epoch, box: toBase64Url(box) },
  };
  if (input.table === "workspaces") {
    await client.workspaces.setName.mutate({ workspace: input.target, ...change });
  } else {
    await client.projects.setName.mutate({ project: input.target, ...change });
  }
}
