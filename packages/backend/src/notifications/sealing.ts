import { v } from "convex/values";
import { sealBox, utf8 } from "radium-crypto";
import { internal } from "../../convex/_generated/api";
import { internalAction, internalMutation, internalQuery } from "../../convex/_generated/server";
import { limitNotificationBody, notificationAad, notificationTitle } from "contracts/notifications/contract";
import { readMigrationState } from "../e2ee/migration-contract";

/**
 * Native notification sealing. Only the notification ID is scheduled; content is loaded inside the
 * action, so no plaintext ever enters scheduler arguments or a mutation argument.
 *
 * `sealingPending` is the single resume marker:
 * - set by `notify` together with the id-only action;
 * - cleared by `finishSealing` on success, on a permanent skip, or on any failure (generic text
 *   stays, never a plaintext fallback), and by `deliverFallback` once the grace passed unfrozen;
 * - kept while the cutover freeze holds, so `resumeSealing` can retry after unfreeze or
 *   `finishCutover`. Each retry ends in one of the clearing paths above, so retries are bounded.
 *
 * A user without an active identity keeps the generic notification (no recipient key, nothing to
 * seal to). A row that already carries `sealed` or historical `legacyContent` is never sealed
 * again: a native envelope is opaque (no plaintext is available to re-seal, and it must stay
 * byte-identical), and the reader prefers `sealed` over `legacyContent`, so a generic native box
 * written beside a historical row would shadow its content.
 */
export const sealingInput = internalQuery({
  args: { notification: v.id("notifications") },
  handler: async (ctx, { notification }) => {
    // The freeze keeps data stable; the row stays pending and `resumeSealing` retries later.
    if ((await readMigrationState(ctx))?.frozen) return null;
    const row = await ctx.db.get("notifications", notification);
    if (!row || !row.sealingPending || row.sealed || row.legacyContent) return null;
    const identity = await ctx.db.query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", row.userId).eq("status", "active"))
      .first();
    if (!identity) return null;
    const chat = row.chat ? await ctx.db.get("aisdk_chats", row.chat) : null;
    // Limit detail is read from the owner-managed event so notifications never store it in plaintext.
    const limitEvent = row.limitEvent ? await ctx.db.get("limit_events", row.limitEvent) : null;
    return {
      userId: row.userId,
      workspace: row.workspace,
      keyId: identity.keyId,
      publicKey: identity.encryptionPublicKey,
      title: notificationTitle(row.kind),
      // A keyed chat title is unavailable to the backend, and a title moved into a migration
      // sidecar is no longer readable here; neither may be mistaken for a legacy title.
      body: chat ? (chat.e2eeId || chat.legacyContent ? "Session" : chat.title?.trim() || "Untitled session")
        : limitEvent
          ? limitNotificationBody({ credential: limitEvent.credentialName, provider: limitEvent.providerName, meter: limitEvent.meter?.label })
          : "Workspace",
    };
  },
});

/**
 * The mutation rechecks the freeze, the row and the identity without receiving plaintext. While
 * frozen it changes nothing (the pending marker must survive for `resumeSealing`). Otherwise it
 * always clears the marker, and writes `sealed` only when the recipient's active identity is still
 * the one the box was sealed to and the row has neither a native envelope nor historical content.
 */
export const finishSealing = internalMutation({
  args: {
    notification: v.id("notifications"),
    sealed: v.optional(v.object({ keyId: v.string(), box: v.bytes() })),
  },
  handler: async (ctx, { notification, sealed }) => {
    if ((await readMigrationState(ctx))?.frozen) return null;
    const row = await ctx.db.get("notifications", notification);
    if (!row || !row.sealingPending) return null;
    const identity = await ctx.db.query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", row.userId).eq("status", "active"))
      .first();
    const accept = sealed && !row.sealed && !row.legacyContent && identity?.keyId === sealed.keyId;
    await ctx.db.patch("notifications", notification, {
      sealingPending: false,
      ...(accept ? { sealed } : {}),
    });
    return null;
  },
});

/** Pending notifications scheduled per resume page; the rest follows by opaque cursor. */
const RESUME_BATCH = 50;

/**
 * Re-schedules id-only sealing for notifications whose sealing was held by the freeze. Core runs it
 * from `setFrozen(false)` and `finishCutover` (`resumeNotificationSealingReference`); the hourly
 * prune also starts it for stalled rows, so a lost hook cannot hide a notification for good. It
 * never touches delivery, so a resumed row is never pushed a second time. While frozen it does
 * nothing: the next unfreeze starts it again.
 */
export const resumeSealing = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    if ((await readMigrationState(ctx))?.frozen) return null;
    const page = await ctx.db.query("notifications")
      .withIndex("by_sealingPending_and_createdAt", (q) => q.eq("sealingPending", true))
      .paginate({ numItems: RESUME_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(0, internal.notifications.sealNotification, { notification: row._id });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.notifications.resumeSealing, { cursor: page.continueCursor });
    }
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
