import { v } from "convex/values";
import { query } from "../../convex/_generated/server";
import { mutation } from "../maintenance";
import { requireAccessibleChat } from "../../convex/workspaces";
import { acpError, accessibleSession, admitWarm, findSession, relayFrozen } from "./policy";
import { validAcpToken } from "contracts/acp/contract";

/**
 * Heartbeat only an authorized visible chat; non-ACP chats do not create presence rows. While the
 * encryption cutover is frozen nothing is written (no viewer row, no warming): a warm session would
 * block sealing of its rows and frames, and the panel is hidden anyway. It reports the stored state.
 */
export const Watch = mutation({
  args: { chat: v.id("aisdk_chats"), tab: v.string() },
  returns: v.object({ warm: v.boolean() }),
  handler: async (ctx, args) => {
    const { chat, userId } = await requireAccessibleChat(ctx, args.chat);
    if (!chat.agent) return { warm: false };
    if (!validAcpToken(args.tab, 64)) acpError("ACP_INVALID_TAB");
    const session = await findSession(ctx, args.chat);
    if (!session) acpError("ACP_NOT_ACP");
    if (await relayFrozen(ctx)) return { warm: session.warm };
    const viewer = (
      await ctx.db
        .query("chat_viewers")
        .withIndex("by_chat_and_tab", (q) => q.eq("chat", args.chat).eq("tab", args.tab))
        .take(1)
    )[0];
    if (viewer) await ctx.db.patch(viewer._id, { user: userId, lastSeenAt: Date.now() });
    else
      await ctx.db.insert("chat_viewers", {
        chat: args.chat,
        tab: args.tab,
        user: userId,
        lastSeenAt: Date.now(),
      });
    if (!session.warm) {
      const now = Date.now();
      await ctx.db.patch(session._id, { ...(await admitWarm(ctx, session, now)), updatedAt: now });
    }
    return { warm: true };
  },
});

/** Read one authorized stream page in sequence order; output never crosses chat visibility. */
export const LiveFrames = query({
  args: { chat: v.id("aisdk_chats"), stream: v.string(), fromSeq: v.number() },
  handler: async (ctx, args) => {
    await accessibleSession(ctx, args.chat);
    const frames = await ctx.db
      .query("chat_frames")
      .withIndex("by_chat_and_stream_and_seqFrom", (q) =>
        q.eq("chat", args.chat).eq("stream", args.stream).gte("seqFrom", args.fromSeq),
      )
      .take(64);
    // Only a sealed historical frame needs its row id (it binds the sidecar's AAD); native frames
    // keep the original wire shape.
    return frames.map(({ _id, seqFrom, seqTo, kind, payload, legacyContent }) =>
      legacyContent
        ? { _id, seqFrom, seqTo, kind, payload, legacyContent }
        : { seqFrom, seqTo, kind, payload },
    );
  },
});
