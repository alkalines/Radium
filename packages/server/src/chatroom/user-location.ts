/**
 * User location passed to web-search tools so results are geographically
 * relevant.
 *
 * @todo This is a mock. Real per-user location requires storing it on the user
 *   (a Better Auth migration); until then every request uses
 *   {@link MOCK_USER_LOCATION}. When that lands, source the location from the
 *   authenticated user and keep these adapters.
 */

/** A user's approximate location. `country` is a two-letter ISO 3166-1 code. */
export type UserLocation = {
  city?: string;
  region?: string;
  /** Two-letter ISO 3166-1 alpha-2 country code (e.g. `"US"`). */
  country?: string;
  /** IANA timezone (e.g. `"America/Los_Angeles"`). */
  timezone?: string;
};

/** Placeholder location used until real per-user location is available. */
export const MOCK_USER_LOCATION: UserLocation = {
  city: "San Francisco",
  region: "California",
  country: "US",
  timezone: "America/Los_Angeles",
};

/**
 * Exa's `userLocation` is a two-letter ISO country code, not a structured
 * object. Returns `undefined` when no country is known.
 */
export function toExaCountry(location: UserLocation = MOCK_USER_LOCATION): string | undefined {
  return location.country;
}
