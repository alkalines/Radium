/**
 * Stable tile color identifiers accepted for persisted workspace and Project appearance. The web
 * app maps each name to a `--tile-<name>` CSS token; `brand` is the Radium orange default.
 */
export const TILE_COLOR_NAMES = [
  "brand",
  "red",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "slate",
] as const;

export type TileColorName = (typeof TILE_COLOR_NAMES)[number];

/** Default color for tiles without a supported color identifier. */
export const DEFAULT_TILE_COLOR: TileColorName = "brand";

/** Check whether an untrusted string is one of the supported tile colors. */
export function isTileColorName(value: string): value is TileColorName {
  return (TILE_COLOR_NAMES as readonly string[]).includes(value);
}

/** Resolve missing or retired color identifiers to the stable default. */
export function resolveTileColorName(value?: string): TileColorName {
  return value && isTileColorName(value) ? value : DEFAULT_TILE_COLOR;
}
