import { and, eq, isNull, sql } from "drizzle-orm";
import { fromBase64Url, toBase64Url } from "radium-crypto";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { secretEvents, secrets } from "./schema";

/**
 * Secret Store: write-only encrypted values (provider credentials, limit keys), keeping the
 * `convex-secret-store` envelope byte for byte so imported rows decrypt unchanged
 * (`docs/Backend_Migration/Runtime.md`, Secrets).
 *
 * Each value has its own random 256-bit data key (DEK). The value is AES-256-GCM encrypted under
 * the DEK with AAD `JSON(["value", namespace, name])`, and the DEK under the key-encryption key
 * (KEK) of `keyVersion` with AAD `JSON(["dek", namespace, name, keyVersion])`; a null namespace is
 * JSON `null`. Ciphertexts and IVs are unpadded base64url text. The AAD binds every row to its
 * place, so ciphertext moved to another name or namespace fails to decrypt.
 *
 * Values never leave the server: callers keep masked previews in `metadata` or their own rows.
 */

/** Secret namespace of one workspace provider's credentials (`workspace:<id>:provider:<slug>`). */
export function workspaceProviderSecretNamespace(workspace: string, provider: string) {
  return `workspace:${workspace}:provider:${provider}`;
}

/** One versioned key-encryption key from `SECRET_STORE_KEYS`. */
export type SecretStoreKey = { version: number; value: string };

/** Largest stored value, as in `convex-secret-store`. */
const MAX_VALUE_BYTES = 64 * 1024;
const KEK_VALUE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Parses `SECRET_STORE_KEYS` (`version:value,…`; each value the 44-character standard base64 of
 * 32 bytes, as `openssl rand -base64 32` prints). Versions are unique non-negative integers.
 * Error messages name entries by position, never by value.
 */
export function parseSecretStoreKeys(raw: string): SecretStoreKey[] {
  const entries = raw.split(",").map((token, index) => {
    const trimmed = token.trim();
    const colon = trimmed.indexOf(":");
    const versionText = colon < 0 ? "" : trimmed.slice(0, colon).trim();
    const value = colon < 0 ? "" : trimmed.slice(colon + 1).trim();
    const version = Number(versionText);
    if (versionText === "" || !Number.isInteger(version) || version < 0) {
      throw new Error(`entry ${index} must be "version:value" with a non-negative integer version`);
    }
    if (!KEK_VALUE.test(value)) {
      throw new Error(`entry ${index} must be the standard base64 of exactly 32 bytes`);
    }
    return { version, value };
  });
  if (new Set(entries.map((entry) => entry.version)).size !== entries.length) {
    throw new Error("key versions must be unique");
  }
  return entries;
}

/**
 * The configured KEKs. New values are wrapped under the highest version; rows under a version
 * that is no longer configured read as `key_unavailable`.
 */
export class SecretKeyring {
  readonly activeVersion: number;
  private readonly values = new Map<number, string>();
  private readonly imported = new Map<number, Promise<CryptoKey>>();

  constructor(keys: readonly SecretStoreKey[]) {
    if (keys.length === 0) throw new Error("SECRET_STORE_KEYS has no keys");
    for (const key of keys) this.values.set(key.version, key.value);
    this.activeVersion = Math.max(...keys.map((key) => key.version));
  }

  has(version: number) {
    return this.values.has(version);
  }

  /** The KEK of `version`, imported once. Throws when that version is not configured. */
  kek(version: number): Promise<CryptoKey> {
    const value = this.values.get(version);
    if (value === undefined) throw new Error(`Secret Store key version ${version} is unavailable`);
    let key = this.imported.get(version);
    if (!key) {
      const raw = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      this.imported.set(version, key);
    }
    return key;
  }
}

/** Where a secret lives; a null namespace is the store's default one. */
export type SecretLocation = { namespace: string | null; name: string };

/** Plaintext facts kept beside a value, such as the masked preview shown to owners. */
export type SecretMetadata = Record<string, unknown>;

export type SecretReadResult =
  | { ok: true; value: string; metadata: SecretMetadata | null; updatedAt: Date }
  | { ok: false; reason: "not_found" | "expired" | "key_unavailable" };

const encoder = new TextEncoder();

function valueAad(location: SecretLocation) {
  return encoder.encode(JSON.stringify(["value", location.namespace, location.name]));
}

function dekAad(location: SecretLocation, version: number) {
  return encoder.encode(JSON.stringify(["dek", location.namespace, location.name, version]));
}

async function aesGcm(
  mode: "encrypt" | "decrypt",
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
) {
  const params = { name: "AES-GCM", iv, additionalData: aad };
  const result =
    mode === "encrypt"
      ? await crypto.subtle.encrypt(params, key, data)
      : await crypto.subtle.decrypt(params, key, data);
  return new Uint8Array(result);
}

/** Encrypts `value` for `location` under the active KEK: the envelope columns of one row. */
export async function sealSecret(keyring: SecretKeyring, location: SecretLocation, value: string) {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const keyVersion = keyring.activeVersion;
  try {
    const dekKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
    const encryptedValue = await aesGcm("encrypt", dekKey, iv, encoder.encode(value), valueAad(location));
    const wrappedDEK = await aesGcm(
      "encrypt",
      await keyring.kek(keyVersion),
      dekIv,
      dek,
      dekAad(location, keyVersion),
    );
    return {
      encryptedValue: toBase64Url(encryptedValue),
      iv: toBase64Url(iv),
      wrappedDEK: toBase64Url(wrappedDEK),
      dekIv: toBase64Url(dekIv),
      keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

/** Decrypts one envelope; throws (without detail) when it does not authenticate. */
export async function openSecret(
  keyring: SecretKeyring,
  location: SecretLocation,
  envelope: { encryptedValue: string; iv: string; wrappedDEK: string; dekIv: string; keyVersion: number },
): Promise<string> {
  let dek: Uint8Array<ArrayBuffer> | undefined;
  try {
    dek = await aesGcm(
      "decrypt",
      await keyring.kek(envelope.keyVersion),
      fromBase64Url(envelope.dekIv) as Uint8Array<ArrayBuffer>,
      fromBase64Url(envelope.wrappedDEK) as Uint8Array<ArrayBuffer>,
      dekAad(location, envelope.keyVersion),
    );
    const dekKey = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
    const plaintext = await aesGcm(
      "decrypt",
      dekKey,
      fromBase64Url(envelope.iv) as Uint8Array<ArrayBuffer>,
      fromBase64Url(envelope.encryptedValue) as Uint8Array<ArrayBuffer>,
      valueAad(location),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("A stored secret could not be decrypted.");
  } finally {
    dek?.fill(0);
  }
}

function locationFilter(location: SecretLocation) {
  return and(
    location.namespace === null
      ? isNull(secrets.namespace)
      : eq(secrets.namespace, location.namespace),
    eq(secrets.name, location.name),
  );
}

function assertLocation(location: SecretLocation) {
  if (location.namespace === "" || location.name.trim() === "") {
    throw new Error("Secret namespace and name must not be empty.");
  }
}

/**
 * Encrypts and stores `value`, replacing any value at the same place, and appends a `created`
 * or `updated` audit event. `metadata` replaces the stored metadata (`null` clears it; omitted
 * keeps it). Run inside the caller's transaction so the secret commits with the row that
 * references it. The upsert is one statement, so concurrent writers of one place serialize on
 * the unique `(namespace, name)` and the last one wins.
 */
export async function putSecret(
  db: Database,
  keyring: SecretKeyring,
  location: SecretLocation,
  value: string,
  metadata?: SecretMetadata | null,
): Promise<{ id: string; created: boolean }> {
  assertLocation(location);
  if (encoder.encode(value).byteLength > MAX_VALUE_BYTES) {
    throw new AppError("BAD_REQUEST", "The secret value is too large.");
  }
  const envelope = await sealSecret(keyring, location, value);
  const now = new Date();
  const [row] = await db
    .insert(secrets)
    .values({
      namespace: location.namespace,
      name: location.name,
      ...envelope,
      metadata: metadata ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [secrets.namespace, secrets.name],
      set: {
        ...envelope,
        ...(metadata === undefined ? {} : { metadata }),
        expiresAt: null,
        updatedAt: now,
      },
    })
    // `xmax = 0` only on a freshly inserted row version.
    .returning({ id: secrets.id, created: sql<boolean>`(xmax = 0)` });
  await db.insert(secretEvents).values({
    secret: row!.id,
    namespace: location.namespace,
    name: location.name,
    type: row!.created ? "created" : "updated",
  });
  return row!;
}

/**
 * Reads and decrypts the value at `location`. Missing, expired and unconfigured-key rows are
 * reported, not thrown; a row that fails authentication throws, because it needs recovery
 * rather than being treated as absent.
 */
export async function getSecret(
  db: Database,
  keyring: SecretKeyring,
  location: SecretLocation,
  now = new Date(),
): Promise<SecretReadResult> {
  assertLocation(location);
  const [row] = await db.select().from(secrets).where(locationFilter(location));
  if (!row) return { ok: false, reason: "not_found" };
  if (row.expiresAt !== null && now >= row.expiresAt) return { ok: false, reason: "expired" };
  if (!keyring.has(row.keyVersion)) return { ok: false, reason: "key_unavailable" };
  const value = await openSecret(keyring, location, row);
  return { ok: true, value, metadata: row.metadata, updatedAt: row.updatedAt };
}

/**
 * Deletes the value at `location`, recording a `deleted` event first (the event keeps namespace
 * and name; its link is cleared by the delete). Returns whether a value existed.
 */
export async function removeSecret(db: Database, location: SecretLocation): Promise<boolean> {
  assertLocation(location);
  const [row] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(locationFilter(location))
    .for("update");
  if (!row) return false;
  await db.insert(secretEvents).values({
    secret: row.id,
    namespace: location.namespace,
    name: location.name,
    type: "deleted",
    metadata: { reason: "removed" },
  });
  await db.delete(secrets).where(eq(secrets.id, row.id));
  return true;
}
