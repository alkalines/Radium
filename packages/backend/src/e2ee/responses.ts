import { v } from "convex/values";
import schema from "../../convex/schema";
/** Public workspace key-state response; only the caller's own grants are returned. */
export const workspaceKeyStateValidator = v.object({
  role: v.union(v.literal("owner"), v.literal("member")),
  ownerId: v.string(),
  keyEpoch: v.union(v.number(), v.null()),
  epochs: v.array(schema.doc("e2ee_workspace_epochs")),
  roster: v.union(schema.doc("e2ee_rosters"), v.null()),
  myGrants: v.array(schema.doc("e2ee_workspace_grants")),
  members: v.array(
    v.object({
      userId: v.string(),
      role: v.union(v.literal("owner"), v.literal("member")),
      keyId: v.union(v.string(), v.null()),
      grantedEpoch: v.union(v.number(), v.null()),
    }),
  ),
  joinRequests: v.array(schema.doc("e2ee_join_requests")),
  phrase: v.union(
    v.object({ epoch: v.number(), phraseId: v.string(), wrapper: v.bytes() }),
    v.null(),
  ),
  invites: v.array(
    v.object({ inviteId: v.string(), invitedUserId: v.string(), expiresAt: v.number() }),
  ),
});
/** Authorized chat key metadata and recipient-filtered seed wraps. */
export const chatKeysResultValidator = v.object({
  chat: v.id("aisdk_chats"),
  workspace: v.id("workspaces"),
  e2eeId: v.union(v.string(), v.null()),
  keyEpoch: v.union(v.number(), v.null()),
  scope: v.union(v.literal("personal"), v.literal("shared"), v.literal("workspace")),
  creatorId: v.string(),
  rekey: v.boolean(),
  workspaceKeyEpoch: v.union(v.number(), v.null()),
  /** The chat's current key epoch predates the workspace's current key; rotate before writing. */
  staleForWorkspace: v.boolean(),
  members: v.array(v.string()),
  epochs: v.array(schema.doc("e2ee_chat_keys")),
  wraps: v.array(schema.doc("e2ee_chat_key_wraps")),
});
/** Paginated stale-wrap response, preserving Convex's split-page metadata. */
export const staleWrapsResultValidator = v.object({
  page: v.array(schema.doc("e2ee_chat_key_wraps")),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
  ),
});
