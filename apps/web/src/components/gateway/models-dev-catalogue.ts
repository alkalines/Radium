import { useEffect, useState } from "react";

import { fetchModelsDev, type ModelsDevApi } from "@/utils/models_dev";

/** Module-level cache so reopening dialogs doesn't refetch ~2 MB of catalogue. */
let catalogueCache: Promise<ModelsDevApi> | null = null;

export function loadCatalogue(): Promise<ModelsDevApi> {
  catalogueCache ??= fetchModelsDev().catch((error) => {
    catalogueCache = null;
    throw error;
  });
  return catalogueCache;
}

/**
 * Lazily load the shared models.dev catalogue once `enabled` becomes true.
 * Returns the catalogue, a load error, and a loading flag so consumers can
 * render their own states.
 */
export function useModelsDevCatalogue(enabled: boolean) {
  const [catalogue, setCatalogue] = useState<ModelsDevApi | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || catalogue) return;
    let active = true;
    loadCatalogue()
      .then((data) => active && setCatalogue(data))
      .catch(
        (err: unknown) => active && setError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      active = false;
    };
  }, [enabled, catalogue]);

  return { catalogue, error, loading: enabled && !catalogue && !error };
}

/** Compact token count (e.g. `128K`, `1M`). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Per-token price string (as stored) rendered as a per-million dollar figure. */
export function formatPerMillion(perToken: string): string {
  const value = parseFloat(perToken) * 1_000_000;
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
