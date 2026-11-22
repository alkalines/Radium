import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, id } from "../db/columns";
import { workspaces } from "../workspaces/schema";

/**
 * A Worker machine identity (Convex `workerIdentity.workers`). `active` means not revoked, not
 * online. `identity_epoch` is the revocation version carried in access tokens: revoking bumps it,
 * so every token issued before stops working at its next request.
 */
export const workers = pgTable(
  "workers",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capabilities: text("capabilities").array().notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull(),
    identityEpoch: integer("identity_epoch").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("workers_status", sql`${table.status} in ('active', 'revoked')`),
    // A workspace's Workers.
    index("workers_workspace").on(table.workspace),
  ],
);

/** A Worker's proof key (Convex `workerIdentity.keys`): canonical public JWK and thumbprint. */
export const workerKeys = pgTable(
  "worker_keys",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    algorithm: text("algorithm").notNull(),
    material: text("material").notNull(),
    thumbprint: text("thumbprint").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One identity per key; enrollment looks keys up by thumbprint.
    uniqueIndex("worker_keys_thumbprint").on(table.thumbprint),
    // Cascade from `workers`.
    index("worker_keys_worker").on(table.worker),
  ],
);
