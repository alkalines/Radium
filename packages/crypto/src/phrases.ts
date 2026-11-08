import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { randomBytes } from "./encoding";
import { CryptoError } from "./errors";

/**
 * Creates a recovery key: 32 random bytes shown once as 24 BIP39 English words (the last word carries
 * an 8-bit checksum). The entropy feeds `deriveKek(entropy, "recoveryKek")`. Uses randomness.
 */
export function generateRecoveryKey(): { entropy: Uint8Array; words: string[] } {
  const entropy = randomBytes(32);
  return { entropy, words: entropyToMnemonic(entropy, wordlist).split(" ") };
}

/**
 * Creates a short one-time secret: 16 random bytes as 12 BIP39 words (4-bit checksum), used for device
 * recovery hand-off. Uses randomness.
 */
export function generateShortSecret(): { entropy: Uint8Array; words: string[] } {
  const entropy = randomBytes(16);
  return { entropy, words: entropyToMnemonic(entropy, wordlist).split(" ") };
}

/**
 * Turns typed words back into entropy. Accepts an array or one string, ignores case, surrounding and
 * repeated whitespace (including line breaks) and Unicode compatibility forms, then requires exactly
 * `expectedWords` words from the English list with a valid checksum. Any failure throws
 * `BAD_RECOVERY_PHRASE` with a fixed message that never echoes the words.
 */
export function phraseToEntropy(words: string[] | string, expectedWords: 12 | 24): Uint8Array {
  const text = typeof words === "string" ? words : words.join(" ");
  const normalized = text.normalize("NFKD").toLowerCase().trim().split(/\s+/u);

  if (normalized.length !== expectedWords) {
    throw new CryptoError("BAD_RECOVERY_PHRASE", `Expected ${expectedWords} words`);
  }

  try {
    return mnemonicToEntropy(normalized.join(" "), wordlist);
  } catch {
    throw new CryptoError("BAD_RECOVERY_PHRASE", "Invalid recovery phrase");
  }
}
