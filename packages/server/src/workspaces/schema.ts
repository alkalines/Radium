import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "../auth/schema";
import { createdAt, id, instant } from "../db/columns";

/**
 * A workspace is the ownership and credential boundary for Gateway resources. Ownership is
 * personal-user only; explicit members are in {@link workspaceMembers}. Better Auth organizations
 * do not grant access.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    icon: text("icon"),
    /** Tile color name from `contracts/workspaces/colors`; unknown names resolve to the default. */
    color: text("color"),
    /** Archived workspaces refuse every request (`../trpc/procedures.ts`). */
    archivedAt: instant("archived_at"),
    createdAt: createdAt(),
  },
  (table) => [
    // The workspaces a user owns.
    index("workspaces_owner").on(table.ownerId),
  ],
);

/** Direct workspace access for an existing user; no invitation acceptance. */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member"] }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("workspace_members_role", sql`${table.role} in ('member')`),
    // One membership per user and workspace; also the access check's lookup.
    uniqueIndex("workspace_members_workspace_user").on(table.workspace, table.userId),
    // The workspaces a user is a member of.
    index("workspace_members_user").on(table.userId),
  ],
);
