import { query } from "./_generated/server";

export const listAuthors = query({
  handler(ctx) {
    return ctx.db.query("authors").collect()
  },
})