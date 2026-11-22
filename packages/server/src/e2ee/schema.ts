import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "../auth/schema";
import { bytes, createdAt, id, instant } from "../db/columns";

/**
 * Account identities: public keys, the identity seeds sealed under the AMK, and the AMK wrapped
 * under the recovery key. Never deleted; a replaced identity is `retired` so old personal data
 * stays openable with a later recovery key.
 */
export const e2eeIdentities = pgTable(
  "e2ee_identities",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /** Unpadded base64url of the 16-byte key id (also the envelope keyRef). */
    keyId: text("key_id").notNull(),
    suite: integer("suite").notNull(),
    encryptionPublicKey: bytes("encryption_public_key").notNull(),
    signingPublicKey: bytes("signing_public_key").notNull(),
    secrets: bytes("secrets").notNull(),
    selfSignature: bytes("self_signature").notNull(),
    recoveryWrapper: bytes("recovery_wrapper").notNull(),
    status: text("status", { enum: ["pending", "active", "retired"] }).notNull(),
    retiredAt: instant("retired_at"),
    createdAt: createdAt(),
  },
  (table) => [
    check("e2ee_identities_status", sql`${table.status} in ('pending', 'active', 'retired')`),
    // Key ids are global: an envelope's keyRef names exactly one identity.
    uniqueIndex("e2ee_identities_key_id").on(table.keyId),
    // A user has at most one active identity; activation retires the previous one in the same
    // transaction.
    uniqueIndex("e2ee_identities_one_active")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    // Activation: the user's active identities.
    index("e2ee_identities_user_status").on(table.userId, table.status),
  ],
);

/** The AMK wrapped under one OPAQUE credential version's export key; see `./keys.ts`. */
export const e2eeKeyBundles = pgTable(
  "e2ee_key_bundles",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    credentialVersion: text("credential_version").notNull(),
    identity: text("identity")
      .notNull()
      .references(() => e2eeIdentities.id, { onDelete: "restrict" }),
    passwordWrapper: bytes("password_wrapper").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One bundle per credential version; also the lookup of every hook.
    uniqueIndex("e2ee_key_bundles_user_version").on(table.userId, table.credentialVersion),
  ],
);
