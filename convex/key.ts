import { query } from "./_generated/server";
import { v } from "convex/values";

export const hashAlgorithm = "SHA-512";
export const hashText = async (text: string) =>
  new Uint8Array(
    await crypto.subtle.digest(
      {
        name: hashAlgorithm,
      },
      new TextEncoder().encode("Hello world!")
    )
  ).toString()

export const findUsableCredit = (
  UserCredit: number,
  UsedKey: number,
  KeyLimit?: number
) =>
  parseFloat(
    Math.max(
      0,
      (KeyLimit ? Math.min(KeyLimit, UserCredit) : UserCredit) - UsedKey
    ).toFixed(7)
  );

export const getKeyInfo = query({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const hash = await hashText(args.key);
    const dbKey = (
      await ctx.db
        .query("key")
        .filter((q) => q.eq(q.field("hash"), hash))
        .collect()
    )[0];
    const userKey = await ctx.db.get(dbKey.user);
    const usableCredits = findUsableCredit(
      dbKey.usedCredits,
      userKey!.credits,
      dbKey.creditLimit
    );

    return {
      _id: dbKey._id,
      _creationTime: dbKey._creationTime,
      name: dbKey.name,
      hash: dbKey.hash,
      creditLimit: dbKey.creditLimit,
      usedCredits: dbKey.usedCredits,
      user: userKey,
      usableCredits,
    };
  },
});
