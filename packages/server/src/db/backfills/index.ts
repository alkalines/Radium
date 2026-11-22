import type { Backfill } from "../migrate";

/**
 * Every data backfill, oldest first. Each lives in `./NNNN_<name>.ts` and stays here for as long
 * as an install could still be upgrading across it (`docs/Backend_Migration/Runtime.md`).
 */
export const backfills: readonly Backfill[] = [];
