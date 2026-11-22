import { eq, inArray } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { user } from "./schema";

/** The public profile other domains may show for an account. */
export type UserProfile = { id: string; email: string; name: string };

const profile = { id: user.id, email: user.email, name: user.name };

/**
 * The account with `email`, compared case-insensitively. Better Auth stores sign-up emails
 * lowercased, so the lookup lowercases the input and uses the unique email index.
 */
export async function findUserByEmail(db: Database, email: string): Promise<UserProfile | null> {
  const [row] = await db
    .select(profile)
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()));
  return row ?? null;
}

/** Profiles of `ids`; unknown ids are absent from the result. */
export async function findUsers(db: Database, ids: readonly string[]): Promise<UserProfile[]> {
  if (ids.length === 0) {
    return [];
  }
  return await db
    .select(profile)
    .from(user)
    .where(inArray(user.id, [...ids]));
}
