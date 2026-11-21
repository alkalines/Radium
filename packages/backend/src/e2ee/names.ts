import { v } from "convex/values";
import { decodeCapsule, decodeEnvelope, CAPSULE_BYTES, equalBytes } from "radium-crypto";
import { query } from "../../convex/_generated/server";
import { mutation } from "../maintenance";
import { authComponent } from "../../convex/auth";
import { requireWorkspaceAccessForUser } from "../../convex/workspaces";
import { canManageProject } from "../workspaces/policy";
import { legacyBoxValidator } from "./legacy-contract";
import { activeLegacyRecipient } from "./legacy-crypto";
import { assertLegacyWritesAllowed, deleteLegacySidecar } from "./migration-contract";

/** Name updates contain ciphertext only; current member-key binding is rechecked atomically. */
export const setName = mutation({
  args: { target: v.union(v.id("workspaces"), v.id("projects")), content: legacyBoxValidator, expected: v.union(v.null(), legacyBoxValidator) },
  returns: v.null(),
  handler: async (ctx, { target, content, expected }) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");
    await assertLegacyWritesAllowed(ctx);
    const workspaceId = ctx.db.normalizeId("workspaces", target);
    const projectId = ctx.db.normalizeId("projects", target);
    const project = projectId ? await ctx.db.get("projects", projectId) : null;
    const owningWorkspace = workspaceId ?? project?.workspace;
    if (!owningWorkspace) throw new Error("Not authorized.");
    const workspace = await requireWorkspaceAccessForUser(ctx, owningWorkspace, identity._id);
    if (workspaceId ? workspace.ownerId !== identity._id : !project || !canManageProject(project, workspace, identity._id)) throw new Error("Not authorized.");
    const previous = workspaceId ? workspace.legacyContent : project?.legacyContent;
    if (expected === null ? previous !== undefined : !previous ||
      previous.kind !== expected.kind || previous.keyId !== expected.keyId ||
      previous.epoch !== expected.epoch || previous.storageId !== expected.storageId ||
      !equalBytes(new Uint8Array(previous.box), new Uint8Array(expected.box))) {
      throw new Error("Encrypted name changed; reopen the editor before saving.");
    }
    const recipient = await activeLegacyRecipient(ctx, { workspace: workspace._id, purpose: "member" });
    if (!recipient || content.kind !== recipient.kind || content.keyId !== recipient.keyId || content.epoch !== recipient.epoch || content.storageId || content.box.byteLength > 16_384) throw new Error("Encrypted name requires the current workspace member key");
    const box = new Uint8Array(content.box);
    const capsule = decodeCapsule(box.subarray(0, CAPSULE_BYTES));
    const envelope = decodeEnvelope(box.subarray(CAPSULE_BYTES));
    if (capsule.suite !== envelope.suite) throw new Error("Invalid encrypted name");
    const table = workspaceId ? "workspaces" : "projects";
    await deleteLegacySidecar(ctx, { table, record: target });
    if (workspaceId) await ctx.db.patch("workspaces", workspaceId, { name: "Workspace", icon: undefined, legacyContent: content });
    else if (projectId) await ctx.db.patch("projects", projectId, { name: "Project", icon: undefined, legacyContent: content });
    return null;
  },
});

/** Returns the authorized current name envelope for local read-modify-write, without decrypting it. */
export const getName = query({
  args: { target: v.union(v.id("workspaces"), v.id("projects")) },
  returns: v.object({
    workspace: v.id("workspaces"), name: v.string(), icon: v.optional(v.string()),
    legacyContent: v.optional(legacyBoxValidator),
  }),
  handler: async (ctx, { target }) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");
    const workspaceId = ctx.db.normalizeId("workspaces", target);
    const projectId = ctx.db.normalizeId("projects", target);
    const project = projectId ? await ctx.db.get("projects", projectId) : null;
    const owningWorkspace = workspaceId ?? project?.workspace;
    if (!owningWorkspace) throw new Error("Not authorized.");
    const workspace = await requireWorkspaceAccessForUser(ctx, owningWorkspace, identity._id);
    const row = workspaceId ? workspace : project!;
    return { workspace: workspace._id, name: row.name, icon: row.icon, legacyContent: row.legacyContent };
  },
});
