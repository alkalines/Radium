import type { RoutingStrategy } from "./settings";

/** An eligible provider as seen by the selection strategies. */
export type SelectionCandidate = {
  provider: string;
  priority: number;
  weight: number;
};

/** Persisted smooth weighted round-robin credits, keyed by provider. */
export type WeightedState = Array<{ provider: string; current: number; weight: number }>;

/** Per workspace+model cursor shared by round-robin and weighted round-robin. */
export type SelectionCursor = {
  lastProvider?: string;
  weighted: WeightedState;
};

/**
 * Candidates in the highest priority tier, sorted by provider slug. Lower tiers are used
 * only when every higher-priority provider is excluded, matching CLIProxyAPI's strict tiers.
 */
export function highestPriorityTier<T extends SelectionCandidate>(candidates: T[]): T[] {
  if (candidates.length === 0) return [];
  const top = Math.max(...candidates.map((candidate) => candidate.priority));
  return candidates
    .filter((candidate) => candidate.priority === top)
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/**
 * Pick one provider from a single priority tier and return the updated cursor.
 * - `round-robin`: the first provider after the last pick in slug order, wrapping. Tracking
 *   identity instead of an index keeps rotation stable when the tier shrinks.
 * - `weighted-round-robin`: nginx smooth WRR; zero-weight providers are never picked.
 * - `fill-first`: always the first provider until it is excluded.
 */
export function pickFromTier<T extends SelectionCandidate>(
  strategy: RoutingStrategy,
  tier: T[],
  cursor: SelectionCursor,
): { picked: T; cursor: SelectionCursor } | undefined {
  if (strategy === "fill-first") {
    const picked = tier[0];
    return picked ? { picked, cursor } : undefined;
  }

  if (strategy === "round-robin") {
    const picked = roundRobinSuccessor(
      tier,
      (candidate) => candidate.provider,
      cursor.lastProvider,
    );
    return picked ? { picked, cursor: { ...cursor, lastProvider: picked.provider } } : undefined;
  }

  const weighted = tier.filter((candidate) => candidate.weight > 0);
  if (weighted.length === 0) return undefined;
  const result = smoothWeightedStep(
    weighted,
    (candidate) => candidate.provider,
    cursor.weighted.map(({ provider, ...credit }) => ({ key: provider, ...credit })),
  );
  const state = result.credits.map(({ key, ...credit }) => ({ provider: key, ...credit }));
  return { picked: result.picked, cursor: { ...cursor, weighted: state } };
}

/**
 * The first item whose key sorts after `last`, wrapping to the first item; `items` must be sorted
 * by key. Following the last pick's identity instead of an index keeps rotation stable when an
 * item drops out or returns.
 */
export function roundRobinSuccessor<T>(
  items: T[],
  key: (item: T) => string,
  last: string | undefined,
): T | undefined {
  const next = last === undefined ? undefined : items.find((item) => key(item) > last);
  return next ?? items[0];
}

/** Smooth weighted round-robin credit of one candidate, keyed by its identity. */
export type SmoothCredit = { key: string; current: number; weight: number };

/**
 * One nginx smooth weighted round-robin step over candidates with positive weights. Credits
 * survive while a candidate is temporarily excluded; they reset only when its configured weight
 * changes.
 */
export function smoothWeightedStep<T extends { weight: number }>(
  candidates: T[],
  key: (candidate: T) => string,
  previous: SmoothCredit[],
): { picked: T; credits: SmoothCredit[] } {
  const credits = new Map(previous.map((entry) => [entry.key, entry]));
  let total = 0;
  let picked: T | undefined;
  let pickedCurrent = -Infinity;

  for (const candidate of candidates) {
    const id = key(candidate);
    const existing = credits.get(id);
    const current =
      (existing && existing.weight === candidate.weight ? existing.current : 0) + candidate.weight;
    credits.set(id, { key: id, current, weight: candidate.weight });
    total += candidate.weight;
    if (current > pickedCurrent) {
      picked = candidate;
      pickedCurrent = current;
    }
  }

  const chosen = picked!;
  const chosenCredit = credits.get(key(chosen))!;
  credits.set(chosenCredit.key, { ...chosenCredit, current: chosenCredit.current - total });
  return { picked: chosen, credits: [...credits.values()] };
}
