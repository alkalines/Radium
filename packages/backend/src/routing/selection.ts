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
    if (tier.length === 0) return undefined;
    const last = cursor.lastProvider;
    const next = last ? tier.find((candidate) => candidate.provider > last) : undefined;
    const picked = next ?? tier[0]!;
    return { picked, cursor: { ...cursor, lastProvider: picked.provider } };
  }

  const weighted = tier.filter((candidate) => candidate.weight > 0);
  if (weighted.length === 0) return undefined;
  const result = pickSmoothWeighted(weighted, cursor.weighted);
  return { picked: result.picked, cursor: { ...cursor, weighted: result.state } };
}

/**
 * One nginx smooth weighted round-robin step. Credits survive while a provider is
 * temporarily excluded; they reset only when that provider's configured weight changes.
 */
function pickSmoothWeighted<T extends SelectionCandidate>(
  candidates: T[],
  previous: WeightedState,
): { picked: T; state: WeightedState } {
  const credits = new Map(previous.map((entry) => [entry.provider, entry]));
  let total = 0;
  let picked: T | undefined;
  let pickedCurrent = -Infinity;

  for (const candidate of candidates) {
    const existing = credits.get(candidate.provider);
    const current =
      (existing && existing.weight === candidate.weight ? existing.current : 0) + candidate.weight;
    credits.set(candidate.provider, {
      provider: candidate.provider,
      current,
      weight: candidate.weight,
    });
    total += candidate.weight;
    if (current > pickedCurrent) {
      picked = candidate;
      pickedCurrent = current;
    }
  }

  const chosen = picked!;
  const chosenCredit = credits.get(chosen.provider)!;
  credits.set(chosen.provider, { ...chosenCredit, current: chosenCredit.current - total });
  return { picked: chosen, state: [...credits.values()] };
}
