type EncryptedCredentialValue = {
  iv: string;
  ciphertext: string;
};

export type EncryptedCredentialRecord = Record<string, EncryptedCredentialValue>;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string) {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex encoded credential value.");

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = parseInt(hex.slice(index, index + 2), 16);
  }

  return bytes;
}

async function getEncryptionKey(secret: string) {
  if (!secret) throw new Error("PROVIDER_CREDENTIALS_SECRET is required for BYOK storage.");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCredentialRecord(secret: string, credentials: Record<string, string>) {
  const key = await getEncryptionKey(secret);
  const encrypted: EncryptedCredentialRecord = {};

  for (const [name, value] of Object.entries(credentials)) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value),
    );

    encrypted[name] = {
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(new Uint8Array(ciphertext)),
    };
  }

  return encrypted;
}

export async function decryptCredentialRecord(
  secret: string,
  encrypted: EncryptedCredentialRecord,
) {
  const key = await getEncryptionKey(secret);
  const credentials: Record<string, string> = {};

  for (const [name, value] of Object.entries(encrypted)) {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(value.iv) },
      key,
      hexToBytes(value.ciphertext),
    );

    credentials[name] = new TextDecoder().decode(plaintext);
  }

  return credentials;
}

export function credentialPreview(value: string) {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
