import { v } from "convex/values";
import { sealBox, utf8 } from "radium-crypto";
import { internal } from "../../convex/_generated/api";
import { internalAction, internalMutation, internalQuery } from "../../convex/_generated/server";
import { notificationAad, notificationTitle } from "./contract";

/** Only the notification ID is scheduled; content is loaded inside the action. */
export const sealingInput = internalQuery({
  args: { notification: v.id("notifications") },
  handler: async (ctx, { notification }) => {
    const row = await ctx.db.get("notifications", notification);
    if (!row || !row.sealingPending) return null;
    const identity = await ctx.db.query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", row.userId).eq("status", "active"))
      .first();
    if (!identity) return null;
    const chat = row.chat ? await ctx.db.get("aisdk_chats", row.chat) : null;
    return {
      userId: row.userId,
      workspace: row.workspace,
      keyId: identity.keyId,
      publicKey: identity.encryptionPublicKey,
      title: notificationTitle(row.kind),
      // A keyed chat title is unavailable to the backend; never mistake a legacy title for it.
      body: chat ? (chat.e2eeId ? "Session" : chat.title?.trim() || "Untitled session")
        : row.limitMetadata
          ? `${row.limitMetadata.credential} · ${row.limitMetadata.provider}${row.limitMetadata.meter ? ` · ${row.limitMetadata.meter}` : ""}`
          : "Workspace",
    };
  },
});

/** The mutation rechecks identity rotation and never receives plaintext. */
export const finishSealing = internalMutation({
  args: {
    notification: v.id("notifications"),
    sealed: v.optional(v.object({ keyId: v.string(), box: v.bytes() })),
  },
  handler: async (ctx, { notification, sealed }) => {
    const row = await ctx.db.get("notifications", notification);
    if (!row || !row.sealingPending) return null;
    const identity = await ctx.db.query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", row.userId).eq("status", "active"))
      .first();
    await ctx.db.patch("notifications", notification, {
      sealingPending: false,
      ...(sealed && identity?.keyId === sealed.keyId ? { sealed } : {}),
    });
    return null;
  },
});

/** Seals bounded notification content to the recipient's current public identity key. */
export const sealNotification = internalAction({
  args: { notification: v.id("notifications") },
  handler: async (ctx, args) => {
    try {
      const input = await ctx.runQuery(internal.notifications.sealingInput, args);
      if (input) {
        const box = await sealBox({
          recipientPublicKey: new Uint8Array(input.publicKey),
          plaintext: utf8(JSON.stringify({ title: input.title.slice(0, 80), body: input.body.slice(0, 160) })),
          aad: notificationAad(input.userId, input.workspace, args.notification),
          pad: "short",
        });
        await ctx.runMutation(internal.notifications.finishSealing, {
          ...args,
          sealed: { keyId: input.keyId, box: box.slice().buffer },
        });
        return null;
      }
    } catch {
      // Failure is a generic notification, never a plaintext fallback.
    }
    await ctx.runMutation(internal.notifications.finishSealing, args);
    return null;
  },
});
