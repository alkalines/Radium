import { query } from "./_generated/server";
import { v } from "convex/values";

export const hashAlgorithm = "SHA-512";
export const hashText = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        {
          name: hashAlgorithm,
        },
        new TextEncoder().encode(text)
      )
    )
  ).map((b) => b.toString(16).padStart(2, "0"))
    .join(""); 

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
    console.log(`From: ${args.key}\nHash: ${hash}`)
    const dbKey = (
      await ctx.db
        .query("keys")
        .filter((q) => q.eq(q.field("hash"), hash))
        .collect()
    )[0];
    if (!dbKey) throw new Error('This key is invalid!')
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
