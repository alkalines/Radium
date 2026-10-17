/** Format a timestamp using the browser locale and timezone. */
export function formatTelemetryDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Format a duration in milliseconds; an absent value represents a running trace. */
export function formatTelemetryDuration(ms: number | undefined): string {
  if (ms === undefined) return "Running";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Format a token count compactly only once it reaches five digits. */
export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

/** Pretty-print valid JSON and preserve the original text when parsing fails. */
export function prettyTelemetryJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
