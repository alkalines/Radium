import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors";
import { generateRecoveryKey, generateShortSecret, phraseToEntropy } from "./phrases";
import { fromHex } from "./test-helpers";

// BIP39 reference vector (trezor/python-mnemonic vectors.json): 16 bytes of 0x7f.
const VECTOR_ENTROPY = fromHex("7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f");
const VECTOR_WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";

function expectPhraseError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("BAD_RECOVERY_PHRASE");
    // The message must never echo what the user typed.
    expect((error as CryptoError).message).not.toMatch(/legal|winner|abandon|zzz/);
    return;
  }
  throw new Error("expected BAD_RECOVERY_PHRASE");
}

describe("phrases", () => {
  it("generates 24-word recovery keys and 12-word short secrets that round-trip", () => {
    const recovery = generateRecoveryKey();
    expect(recovery.entropy.length).toBe(32);
    expect(recovery.words.length).toBe(24);
    expect(phraseToEntropy(recovery.words, 24)).toEqual(recovery.entropy);

    const short = generateShortSecret();
    expect(short.entropy.length).toBe(16);
    expect(short.words.length).toBe(12);
    expect(phraseToEntropy(short.words.join(" "), 12)).toEqual(short.entropy);
  });

  it("decodes the BIP39 reference vector", () => {
    expect(phraseToEntropy(VECTOR_WORDS, 12)).toEqual(VECTOR_ENTROPY);
  });

  it("normalizes case, whitespace, line breaks and compatibility forms", () => {
    const messy = `  ${VECTOR_WORDS.toUpperCase().replaceAll(" ", " \n\t ")}  `;
    expect(phraseToEntropy(messy, 12)).toEqual(VECTOR_ENTROPY);
    // Fullwidth letters fold to ASCII under NFKD.
    const fullwidth = VECTOR_WORDS.replace("legal", "ｌｅｇａｌ");
    expect(phraseToEntropy(fullwidth, 12)).toEqual(VECTOR_ENTROPY);
    expect(
      phraseToEntropy(
        VECTOR_WORDS.split(" ").map((word) => ` ${word} `),
        12,
      ),
    ).toEqual(VECTOR_ENTROPY);
  });

  it("rejects bad checksums, unknown words and wrong word counts", () => {
    // Swapping the last word keeps every word valid but breaks the checksum.
    expectPhraseError(() => phraseToEntropy(VECTOR_WORDS.replace(/yellow$/, "winner"), 12));
    expectPhraseError(() => phraseToEntropy(VECTOR_WORDS.replace("wave", "zzz"), 12));
    expectPhraseError(() => phraseToEntropy(VECTOR_WORDS, 24));
    expectPhraseError(() => phraseToEntropy(VECTOR_WORDS.split(" ").slice(1), 12));
    expectPhraseError(() => phraseToEntropy("", 12));
  });
});
