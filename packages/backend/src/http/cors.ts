/** Credentialed browser routes allow only the configured frontend origin. */
export function allowedSiteOrigin(origin: string): string {
  const siteUrl = process.env.SITE_URL;
  return siteUrl && origin === new URL(siteUrl).origin ? origin : "";
}
