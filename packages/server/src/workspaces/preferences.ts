import { eq } from "drizzle-orm";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { userPreferences } from "./schema";

/**
 * Per-user interface preferences. They follow the user across workspaces and never grant model
 * access: pickers still list only workspace-configured models.
 */

/** Slugs per list. */
const MAX_PREFERRED_MODELS = 200;
export const MAX_MODEL_SLUG_LENGTH = 200;

export type ModelPreferences = { pinnedModels: string[]; hiddenModels: string[] };

/** The user's pinned and hidden model slugs; empty lists when never set. */
export async function getModelPreferences(db: Database, userId: string): Promise<ModelPreferences> {
  const [row] = await db
    .select({
      pinnedModels: userPreferences.pinnedModels,
      hiddenModels: userPreferences.hiddenModels,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row ?? { pinnedModels: [], hiddenModels: [] };
}

/**
 * Adds or removes `model` in one list. Pinned and hidden exclude each other, so adding to one
 * removes it from the other. Lists stay deduplicated in insertion order and capped; repeating a
 * call changes nothing. The row is locked, so concurrent changes from several tabs all apply.
 */
export async function setModelPreference(
  db: Database,
  userId: string,
  model: string,
  list: keyof ModelPreferences,
  enabled: boolean,
): Promise<void> {
  if (model.length === 0 || model.length > MAX_MODEL_SLUG_LENGTH) {
    throw new AppError("BAD_REQUEST", "Invalid model.");
  }
  await db.transaction(async (tx) => {
    if (enabled) {
      await tx.insert(userPreferences).values({ userId }).onConflictDoNothing();
    }
    const [row] = await tx
      .select({
        pinnedModels: userPreferences.pinnedModels,
        hiddenModels: userPreferences.hiddenModels,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .for("update");
    if (!row) {
      return;
    }
    const opposite = list === "pinnedModels" ? "hiddenModels" : "pinnedModels";
    const next = { ...row };
    if (enabled) {
      if (!row[list].includes(model)) {
        if (row[list].length >= MAX_PREFERRED_MODELS) {
          throw new AppError("BAD_REQUEST", "Model preference limit reached.");
        }
        next[list] = [...row[list], model];
      }
      next[opposite] = row[opposite].filter((slug) => slug !== model);
    } else {
      next[list] = row[list].filter((slug) => slug !== model);
    }
    await tx.update(userPreferences).set(next).where(eq(userPreferences.userId, userId));
  });
}
