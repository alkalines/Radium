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

export function formatTelemetryDuration(ms: number | undefined): string {
  if (ms === undefined) return "Running";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function prettyTelemetryJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
