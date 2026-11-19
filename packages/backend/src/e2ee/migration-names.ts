import type { Id } from "../../convex/_generated/dataModel";
import { activeLegacyRecipient } from "./legacy-crypto";
import type { LegacyAdapter } from "./migration-contract";

/** Names and user-selected icons are content; execution folders remain approved routing metadata. */
export const domain: LegacyAdapter = {
  tables: ["workspaces", "projects"],
  async inspect(ctx, table, row) {
    const placeholder = table === "workspaces" ? "Workspace" : "Project";
    if (row.legacyContent) {
      if (row.name !== placeholder || row.icon !== undefined) throw new Error("Plaintext name conflicts with an existing encrypted name");
      return null;
    }
    if (row.name === placeholder && row.icon === undefined) return null;
    if (typeof row.name !== "string") throw new Error("Legacy name is missing");
    const workspace = table === "workspaces" ? row._id as Id<"workspaces"> : row.workspace as Id<"workspaces">;
    if (!workspace) throw new Error("Legacy name has no workspace");
    const parent = await ctx.db.get("workspaces", workspace);
    if (!parent) throw new Error("Legacy name workspace is missing");
    return {
      value: { name: row.name, ...(row.icon !== undefined ? { icon: row.icon } : {}) },
      patch: { name: placeholder, icon: undefined },
      workspace,
      userId: parent.ownerId,
      recipient: await activeLegacyRecipient(ctx, { workspace, purpose: "member" }),
    };
  },
  async releaseRecipient(ctx, table, row) {
    const workspace = table === "workspaces" ? row._id as Id<"workspaces"> : row.workspace as Id<"workspaces">;
    if (!workspace) throw new Error("Legacy name has no workspace");
    return activeLegacyRecipient(ctx, { workspace, purpose: "member" });
  },
};
