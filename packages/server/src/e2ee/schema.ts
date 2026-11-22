import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "../auth/schema";
import { chats } from "../chatroom/schema";
import { bytes, checkIn, createdAt, id, instant } from "../db/columns";
import { workerEnrollments, workers } from "../worker/schema";
import { workspaces } from "../workspaces/schema";

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

/*
 * Trust and workspace key records (`docs/E2EE/Keys.md`). Every private key is stored only as a box
 * (capsule + envelope) sealed to a public key the backend cannot open; public keys, epochs and
 * signatures are plaintext. All ids named `*_key_id`, `invite_id`, `phrase_id` and `capsule_id`
 * are unpadded base64url of 16 random client bytes.
 */

/** One per user: pinned keys, encrypted under a key derived from the AMK; versioned for rollback checks. */
export const e2eeTrustStores = pgTable(
  "e2ee_trust_stores",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Saved with compare-and-swap: `update … where user_id = $1 and version = $expected`, or an
     * insert for the first save; a stale device cannot overwrite a newer trust decision.
     */
    version: integer("version").notNull(),
    envelope: bytes("envelope").notNull(),
    updatedAt: instant("updated_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("e2ee_trust_stores_version", sql`${table.version} >= 1`),
    // One store per user; also its only lookup.
    uniqueIndex("e2ee_trust_stores_user").on(table.userId),
  ],
);

/** Public halves of one workspace key epoch (member key and owner key). */
export const e2eeWorkspaceEpochs = pgTable(
  "e2ee_workspace_epochs",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    suite: integer("suite").notNull(),
    memberKeyId: text("member_key_id").notNull(),
    memberPublicKey: bytes("member_public_key").notNull(),
    ownerKeyId: text("owner_key_id").notNull(),
    ownerPublicKey: bytes("owner_public_key").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    /**
     * Roster archive chain value `A_epoch` (base64url, Keys.md "Roster") copied from the newest stored
     * owner-signed roster whose `archive.through` is this epoch. Readers use it only as the claimed
     * prefix for verifying newer archived epochs; null while the epoch is in the roster window and
     * for epochs archived together by a version 1/2 → 3 conversion.
     */
    rosterArchiveHash: text("roster_archive_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    check("e2ee_workspace_epochs_epoch", sql`${table.epoch} >= 1`),
    check("e2ee_workspace_epochs_distinct_keys", sql`${table.memberKeyId} <> ${table.ownerKeyId}`),
    // One row per epoch; point reads, the newest-first roster window and archived epoch pages.
    uniqueIndex("e2ee_workspace_epochs_workspace_epoch").on(table.workspace, table.epoch),
  ],
);

const GRANT_PURPOSES = ["member", "owner"] as const;

/**
 * A workspace private key sealed to one identity, signed by the granter's identity. One grant per
 * recipient, epoch and purpose: a new grant replaces the previous one in the same transaction.
 */
export const e2eeWorkspaceGrants = pgTable(
  "e2ee_workspace_grants",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    purpose: text("purpose", { enum: GRANT_PURPOSES }).notNull(),
    /** The recipient. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    recipientKeyId: text("recipient_key_id").notNull(),
    granterUserId: text("granter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    granterKeyId: text("granter_key_id").notNull(),
    sealed: bytes("sealed").notNull(),
    signature: bytes("signature").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("e2ee_workspace_grants_purpose", table.purpose, GRANT_PURPOSES),
    // A grant names an existing epoch of its workspace.
    foreignKey({
      name: "e2ee_workspace_grants_epoch_fk",
      columns: [table.workspace, table.epoch],
      foreignColumns: [e2eeWorkspaceEpochs.workspace, e2eeWorkspaceEpochs.epoch],
    }).onDelete("cascade"),
    // One grant per recipient, epoch and purpose (storeGrant replaces); also a user's grants in a
    // workspace by epoch range (workspaceKeyState, workspaceArchivedEpochs, requestKeys).
    uniqueIndex("e2ee_workspace_grants_recipient").on(
      table.workspace,
      table.userId,
      table.epoch,
      table.purpose,
    ),
    // All grants of one epoch (workspaceKeyAvailable); also the epoch foreign key.
    index("e2ee_workspace_grants_workspace_epoch").on(table.workspace, table.epoch),
  ],
);

/** Owner-signed roster versions; the highest version is current. */
export const e2eeRosters = pgTable(
  "e2ee_rosters",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: bytes("body").notNull(),
    signature: bytes("signature").notNull(),
    signerKeyId: text("signer_key_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("e2ee_rosters_version", sql`${table.version} >= 1`),
    // Versions are strictly increasing per workspace; two concurrent publishes of one version
    // cannot both land. Also the latest roster (latestRoster, newest first).
    uniqueIndex("e2ee_rosters_workspace_version").on(table.workspace, table.version),
  ],
);

/**
 * A Worker's current E2EE key set: public keys, the Worker's self-signature and the pairing-secret
 * MAC. One row per Worker; re-pairing replaces it and revocation deletes it. Certified only while
 * the newest roster lists this `key_id`.
 */
export const e2eeWorkerKeys = pgTable(
  "e2ee_worker_keys",
  {
    id: id(),
    worker: text("worker")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    suite: integer("suite").notNull(),
    encryptionPublicKey: bytes("encryption_public_key").notNull(),
    signingPublicKey: bytes("signing_public_key").notNull(),
    selfSignature: bytes("self_signature").notNull(),
    pairingMac: bytes("pairing_mac").notNull(),
    /** The pairing the key set was published from; that pairing is deleted once certified. */
    pairingId: text("pairing_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One key set per Worker; the Worker's lookup and, joined from `workers`, the workspace's
    // Worker keys (workerKeys, roster admission).
    uniqueIndex("e2ee_worker_keys_worker").on(table.worker),
  ],
);

/**
 * The owner's copy of one Worker pairing secret, sealed to the owner's own identity key. Bound to
 * a setup enrollment or an enrolled Worker (an enrollment pairing gets its Worker when that Worker
 * publishes keys); deleted once the Worker is certified, on revocation, or a retention period after
 * expiry.
 */
export const e2eeWorkerPairings = pgTable(
  "e2ee_worker_pairings",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    pairingId: text("pairing_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    worker: text("worker"),
    enrollment: text("enrollment").references(() => workerEnrollments.id, {
      onDelete: "cascade",
    }),
    sealedSecret: bytes("sealed_secret").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "e2ee_worker_pairings_target",
      sql`num_nonnulls(${table.worker}, ${table.enrollment}) >= 1`,
    ),
    // The bound Worker belongs to the pairing's workspace.
    foreignKey({
      name: "e2ee_worker_pairings_worker_fk",
      columns: [table.worker, table.workspace],
      foreignColumns: [workers.id, workers.workspace],
    }).onDelete("cascade"),
    // Pairing ids are unique per workspace; also the workspace's pairings (workerPairings,
    // createWorkerPairing's bound, revocation cleanup).
    uniqueIndex("e2ee_worker_pairings_workspace_pairing").on(table.workspace, table.pairingId),
    // Retention: pairings past expiry plus the retention period (retention job).
    index("e2ee_worker_pairings_expires_at").on(table.expiresAt),
  ],
);

/** Single-use access link payloads; the link secret stays in the URL fragment. */
export const e2eeInvites = pgTable(
  "e2ee_invites",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inviteId: text("invite_id").notNull(),
    invitedUserId: text("invited_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    epoch: integer("epoch").notNull(),
    sealed: bytes("sealed").notNull(),
    /** The link secret sealed to the workspace owner key, for checking the join proof later. */
    ownerSecret: bytes("owner_secret").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: instant("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "e2ee_invites_epoch_fk",
      columns: [table.workspace, table.epoch],
      foreignColumns: [e2eeWorkspaceEpochs.workspace, e2eeWorkspaceEpochs.epoch],
    }).onDelete("cascade"),
    // Invite ids are global: the link names exactly one invite (getInvite, acceptInvite, revokeInvite).
    uniqueIndex("e2ee_invites_invite_id").on(table.inviteId),
    // One pending invite per invited member (createInvite replaces); also the workspace's invites
    // (workspaceKeyState, clearWorkspaceJoins).
    uniqueIndex("e2ee_invites_workspace_user").on(table.workspace, table.invitedUserId),
    // Retention: expired invites (retention job).
    index("e2ee_invites_expires_at").on(table.expiresAt),
  ],
);

/** The member key of one epoch wrapped under the optional workspace key phrase. */
export const e2eePhrases = pgTable(
  "e2ee_phrases",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    phraseId: text("phrase_id").notNull(),
    wrapper: bytes("wrapper").notNull(),
    /** The phrase entropy sealed to the workspace owner key, for checking join proofs. */
    ownerSecret: bytes("owner_secret").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "e2ee_phrases_epoch_fk",
      columns: [table.workspace, table.epoch],
      foreignColumns: [e2eeWorkspaceEpochs.workspace, e2eeWorkspaceEpochs.epoch],
    }).onDelete("cascade"),
    // One phrase per epoch (setPhrase replaces); also the current phrase (workspaceKeyState,
    // acceptPhrase) and the workspace's phrases (removePhrase).
    uniqueIndex("e2ee_phrases_workspace_epoch").on(table.workspace, table.epoch),
  ],
);

const JOIN_SOURCES = ["invite", "phrase", "request"] as const;

/**
 * A member's pending key request or join proof, resolved by an owner (or a holder, for
 * re-grants). `invite`/`phrase` proofs carry the MAC, the owner-sealed secret, the epoch and the
 * `invite_id`/`phrase_id` they came from (the AAD record of `owner_secret`); a `request` carries
 * none of them.
 */
export const e2eeJoinRequests = pgTable(
  "e2ee_join_requests",
  {
    id: id(),
    workspace: text("workspace")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The requester. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    keyId: text("key_id").notNull(),
    source: text("source", { enum: JOIN_SOURCES }).notNull(),
    mac: bytes("mac"),
    ownerSecret: bytes("owner_secret"),
    sourceId: text("source_id"),
    epoch: integer("epoch"),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("e2ee_join_requests_source", table.source, JOIN_SOURCES),
    check(
      "e2ee_join_requests_proof",
      sql`num_nonnulls(${table.mac}, ${table.ownerSecret}, ${table.sourceId}, ${table.epoch}) = case when ${table.source} = 'request' then 0 else 4 end`,
    ),
    foreignKey({
      name: "e2ee_join_requests_epoch_fk",
      columns: [table.workspace, table.epoch],
      foreignColumns: [e2eeWorkspaceEpochs.workspace, e2eeWorkspaceEpochs.epoch],
    }).onDelete("cascade"),
    // One request per requester identity (join and requestKeys replace); also a user's requests
    // (storeGrant resolution, requestKeys) and the workspace's requests (workspaceKeyState,
    // clearWorkspaceJoins).
    uniqueIndex("e2ee_join_requests_workspace_user_key").on(
      table.workspace,
      table.userId,
      table.keyId,
    ),
  ],
);

/**
 * Public half of one chat key epoch, signed by the identity that created it. The signer columns
 * are null only while a chat created on a locked device waits for its creator to sign it.
 */
export const e2eeChatKeys = pgTable(
  "e2ee_chat_keys",
  {
    id: id(),
    chat: text("chat")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    keyId: text("key_id").notNull(),
    suite: integer("suite").notNull(),
    publicKey: bytes("public_key").notNull(),
    signerUserId: text("signer_user_id").references(() => user.id, { onDelete: "restrict" }),
    signerKeyId: text("signer_key_id"),
    signature: bytes("signature"),
    /** Purpose proof that additionally binds the chat id and declared audience for new encryption. */
    bindingSignature: bytes("binding_signature"),
    /** Original raw picked members authenticated by `binding_signature`; proves safe removal. */
    bindingMembers: text("binding_members").array(),
    createdAt: createdAt(),
  },
  (table) => [
    check("e2ee_chat_keys_epoch", sql`${table.epoch} >= 1`),
    check(
      "e2ee_chat_keys_signer",
      sql`num_nonnulls(${table.signerUserId}, ${table.signerKeyId}, ${table.signature}) in (0, 3)`,
    ),
    check(
      "e2ee_chat_keys_binding",
      sql`(${table.bindingSignature} is null or ${table.signature} is not null) and (${table.bindingMembers} is null or ${table.bindingSignature} is not null)`,
    ),
    // One row per chat epoch (of two concurrent setups only the first commits); point reads and the
    // newest-first epoch window (chatKeys).
    uniqueIndex("e2ee_chat_keys_chat_epoch").on(table.chat, table.epoch),
  ],
);

const WRAP_RECIPIENTS = ["workspace", "identity"] as const;

/**
 * One chat key epoch's seed sealed to a workspace member key epoch (`workspace_epoch`) or to one
 * identity (`user_id`). A trusted writer (chat creator, workspace owner) replaces the wrap of the
 * same recipient key; anyone else's duplicate is skipped.
 */
export const e2eeChatKeyWraps = pgTable(
  "e2ee_chat_key_wraps",
  {
    id: id(),
    chat: text("chat").notNull(),
    /** The chat's workspace, whose member key a `workspace` wrap is sealed to. */
    workspace: text("workspace").notNull(),
    chatEpoch: integer("chat_epoch").notNull(),
    recipient: text("recipient", { enum: WRAP_RECIPIENTS }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
    workspaceEpoch: integer("workspace_epoch"),
    recipientKeyId: text("recipient_key_id").notNull(),
    sealed: bytes("sealed").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    checkIn("e2ee_chat_key_wraps_recipient", table.recipient, WRAP_RECIPIENTS),
    check(
      "e2ee_chat_key_wraps_recipient_target",
      sql`case ${table.recipient} when 'identity' then ${table.userId} is not null and ${table.workspaceEpoch} is null else ${table.userId} is null and ${table.workspaceEpoch} is not null end`,
    ),
    foreignKey({
      name: "e2ee_chat_key_wraps_chat_fk",
      columns: [table.chat, table.workspace],
      foreignColumns: [chats.id, chats.workspace],
    }).onDelete("cascade"),
    foreignKey({
      name: "e2ee_chat_key_wraps_chat_epoch_fk",
      columns: [table.chat, table.chatEpoch],
      foreignColumns: [e2eeChatKeys.chat, e2eeChatKeys.epoch],
    }).onDelete("cascade"),
    foreignKey({
      name: "e2ee_chat_key_wraps_workspace_epoch_fk",
      columns: [table.workspace, table.workspaceEpoch],
      foreignColumns: [e2eeWorkspaceEpochs.workspace, e2eeWorkspaceEpochs.epoch],
    }).onDelete("cascade"),
    // One wrap per chat epoch and recipient key (insertChatWraps); the caller's own wrap (Home
    // titles, chatKeys) and every wrap of an epoch.
    uniqueIndex("e2ee_chat_key_wraps_chat_epoch_recipient").on(
      table.chat,
      table.chatEpoch,
      table.recipientKeyId,
    ),
    // Newest workspace wrap of a chat epoch (newestWorkspaceWrap); workspace wraps dropped when a
    // chat leaves workspace scope (changeChatScope).
    index("e2ee_chat_key_wraps_chat_workspace_epoch")
      .on(table.chat, table.chatEpoch, table.workspaceEpoch)
      .where(sql`${table.workspaceEpoch} is not null`),
    // Workspace wraps under an older workspace epoch, for the owner's rewrap (staleWorkspaceWraps);
    // also the workspace epoch foreign key.
    index("e2ee_chat_key_wraps_workspace_epoch")
      .on(table.workspace, table.workspaceEpoch)
      .where(sql`${table.workspaceEpoch} is not null`),
  ],
);

/** Key capsules of chat write batches (one per turn or client write), deleted with the chat. */
export const e2eeCapsules = pgTable(
  "e2ee_capsules",
  {
    id: id(),
    chat: text("chat")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    capsuleId: text("capsule_id").notNull(),
    chatEpoch: integer("chat_epoch").notNull(),
    capsule: bytes("capsule").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // A capsule id names one capsule of its chat (message writes refuse a reused id); also the
    // chat's capsules (GetChatMessages).
    uniqueIndex("e2ee_capsules_chat_capsule").on(table.chat, table.capsuleId),
  ],
);
