import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { resolveWorkspaceForChat } from "../../convex/workspaces";
import { activeLegacyRecipient } from "./legacy-crypto";
import type { LegacyAdapter } from "./migration-contract";

type Ctx = QueryCtx | MutationCtx;

/** Historical plaintext fields per table; everything else on these rows is native or routing data. */
const plaintextFields = {
  aisdk_chats: ["messages", "messages_queue", "title", "emoji"],
  chat_messages: ["message"],
} as const;

/**
 * Chat history uses only its native chat key; every keyless scope stays in custody until a
 * current key exists. Unattached uploads may use the uploader identity. Ambiguous ownership
 * throws so core reports a blocker instead of choosing a broader recipient.
 */
async function audience(ctx: Ctx, table: string, row: Record<string, unknown>) {
  if (table === "chat_files") {
    const file = row as Doc<"chat_files">;
    const parent = file.chat ? await ctx.db.get("aisdk_chats", file.chat) : null;
    if (file.chat && !parent) throw new Error("Attachment has no owning chat");
    const workspace = parent
      ? await resolveWorkspaceForChat(ctx, parent)
      : await ctx.db.get("workspaces", file.workspace);
    if (!workspace || workspace._id !== file.workspace || !file.userId) {
      throw new Error("Attachment has ambiguous ownership");
    }
    // A pending upload belongs to its uploader alone until a message references it.
    const recipient = await activeLegacyRecipient(
      ctx,
      parent
        ? { userId: parent.userId, workspace: workspace._id, chat: parent._id }
        : { userId: file.userId },
    );
    return { recipient, workspace: workspace._id, userId: parent?.userId ?? file.userId };
  }

  const parent =
    table === "aisdk_chats"
      ? (row as Doc<"aisdk_chats">)
      : await ctx.db.get("aisdk_chats", (row as Doc<"chat_messages">).chat);
  if (!parent) throw new Error("Chat history has no owning chat");
  const workspace = await resolveWorkspaceForChat(ctx, parent);
  if (!workspace || !parent.userId) throw new Error("Chat history has ambiguous ownership");
  const recipient = await activeLegacyRecipient(ctx, {
    userId: parent.userId,
    workspace: workspace._id,
    chat: parent._id,
  });
  return { recipient, workspace: workspace._id, userId: parent.userId };
}

/**
 * Extracts only historical plaintext; native ciphertext, message IDs, revisions and row identities
 * are never rewritten. A row that mixes native and plaintext forms keeps its native fields and
 * only the plaintext is sealed, so readers must prefer native content when both exist.
 */
export const domain = {
  tables: ["aisdk_chats", "chat_messages", "chat_files"],

  async inspect(ctx, table, row) {
    if (table === "chat_files") return inspectFile(ctx, row as Doc<"chat_files">);

    const fields = plaintextFields[table as keyof typeof plaintextFields];
    if (!fields) throw new Error(`Chat adapter does not handle ${table}`);
    const value: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    for (const field of fields) {
      // `messages_queue: null` is the consumed-queue marker, not content.
      if (row[field] !== undefined && row[field] !== null) {
        value[field] = row[field];
        patch[field] = undefined;
      }
    }
    // A failed request's error text is readable content. The row keeps its kind and an empty
    // `message` marker, so the Session knows to restore the text from the sidecar.
    const interruption = row.interruption as { kind: string; message?: string } | undefined;
    if (table === "aisdk_chats" && interruption?.message) {
      value.interruptionMessage = interruption.message;
      patch.interruption = { kind: interruption.kind, message: "" };
    }
    if (!Object.keys(value).length) return null;
    // New plaintext beside a sidecar would have to be merged into sealed content; never guess.
    if (row.legacyContent) throw new Error("Chat row has both a sealed sidecar and new plaintext");
    return { value, patch, ...(await audience(ctx, table, row)) };
  },

  async releaseRecipient(ctx, table, row) {
    return (await audience(ctx, table, row)).recipient;
  },
} satisfies LegacyAdapter;

async function inspectFile(ctx: Ctx, file: Doc<"chat_files">) {
  const nativeFields = [file.fileId, file.capsule, file.chatEpoch, file.e2eeParent];
  if (nativeFields.every((field) => field !== undefined)) return null;
  if (nativeFields.some((field) => field !== undefined)) {
    throw new Error("Attachment has incomplete native encryption metadata");
  }
  if (file.legacyContent) {
    if (file.storageId) throw new Error("Attachment has both a sealed sidecar and plaintext storage");
    return null;
  }
  if (!file.storageId) throw new Error("Attachment is missing storage");
  const owner = await audience(ctx, "chat_files", file);
  return {
    // `url` stays as the mapping key of message file parts; the blob it named is deleted by core.
    value: { filename: file.filename ?? null, mediaType: file.mediaType, size: file.size },
    patch: {
      storageId: undefined,
      filename: undefined,
      mediaType: "application/octet-stream",
      size: 0,
    },
    storage: { id: file.storageId as Id<"_storage">, field: "fileBytes", encoding: "base64" as const },
    ...owner,
  };
}
