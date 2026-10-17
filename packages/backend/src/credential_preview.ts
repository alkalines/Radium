/** Show a masked credential preview without exposing any but its final four characters. */
export function credentialPreview(credential: string) {
  if (credential.length <= 4) return "****";
  return `****${credential.slice(-4)}`;
}
