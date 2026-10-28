import { credentialPreview } from "../credential_preview";
import type { Doc } from "../../convex/_generated/dataModel";

/** Upper bound on credentials per workspace provider; keeps routing reads and decrypts bounded. */
export const MAX_PROVIDER_CREDENTIALS = 50;

const MAX_LABEL_LENGTH = 64;
type CredentialRow = Pick<
  Doc<"workspace_credentials">,
  "provider" | "secretName" | "label" | "preview" | "enabled" | "priority" | "weight"
>;

/**
 * Secret Store name of a credential inside its workspace provider namespace. Credentials created
 * before pools (and by the legacy migration) occupy the provider-slug name; pooled credentials
 * are named after their row ID.
 */
export function credentialSecretName(credential: Pick<CredentialRow, "provider" | "secretName">) {
  return credential.secretName ?? credential.provider;
}

/** Display name: the owner label, else the first masked preview value. */
export function credentialDisplayName(credential: Pick<CredentialRow, "label" | "preview">) {
  return credential.label ?? Object.values(credential.preview)[0] ?? "Credential";
}

export function isCredentialEnabled(credential: Pick<CredentialRow, "enabled">) {
  return credential.enabled ?? true;
}

/** Effective priority and weight inside the provider (defaults 0 and 1, like providers). */
export function credentialPlacement(credential: Pick<CredentialRow, "priority" | "weight">) {
  return { priority: credential.priority ?? 0, weight: credential.weight ?? 1 };
}

/** Mask every credential value for app-data previews; raw values stay in Secret Store. */
export function maskCredentialValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, credentialPreview(value)]),
  );
}

/** Trimmed owner label, or `undefined` to clear it. Throws when it is too long. */
export function normalizeCredentialLabel(label: string) {
  const trimmed = label.trim();
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`Credential labels must be at most ${MAX_LABEL_LENGTH} characters.`);
  }
  return trimmed || undefined;
}

/** Throw unless every environment variable the provider declares has a non-empty value. */
export function assertRequiredCredentials(env: string[], values: Record<string, string>) {
  for (const requiredName of env) {
    if (!values[requiredName]) {
      throw new Error(`Missing required credential value: ${requiredName}`);
    }
  }
}
