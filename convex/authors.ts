import { v } from "convex/values";
import { query } from "./_generated/server";

export const listAuthors = query({
  handler(ctx) {
    return ctx.db.query("authors").collect()
  },
})

export const authorInfo = query({
  args: {
    slug: v.string(),
  },
  handler(ctx, args) {
    return ctx.db
      .query("authors")
      .filter((q) => q.eq(q.field("slug"), args.slug))
      .first();
  },
});