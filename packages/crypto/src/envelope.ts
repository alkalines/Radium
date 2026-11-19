import { buildAad, type AadParts } from "./aad";
import { assertLength, bufferSource, concatBytes, randomBytes } from "./encoding";
import { CryptoError } from "./errors";
import { pad, unpad } from "./padding";
import {
  assertSupportedSuite,
  ENVELOPE_VERSION,
  KEY_ID_BYTES,
  SUITE_1,
  type SuiteId,
} from "./suite";

/**
 * One encrypted field (Keys.md "Envelope format"). `kind` says where the key comes from: `capsule`
 * (an object key derived from a key capsule) or `sym` (a symmetric key the reader already holds).
 * `keyRef` names that key (capsule ID, key ID/epoch, or account key ID).
 */
export type Envelope = {
  version: number;
  suite: SuiteId;
  kind: "capsule" | "sym";
  keyRef: Uint8Array;
  nonce: Uint8Array;
  body: Uint8Array;
};

const KIND_CAPSULE = 1;
const KIND_SYM = 2;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
// version(1) suite(1) kind(1) keyRef(16)
const AUTHENTICATED_HEADER_BYTES = 3 + KEY_ID_BYTES;
const HEADER_BYTES = AUTHENTICATED_HEADER_BYTES + NONCE_BYTES;

function kindToByte(kind: Envelope["kind"]): number {
  if (kind === "capsule") {
    return KIND_CAPSULE;
  }
  if (kind === "sym") {
    return KIND_SYM;
  }
  throw new CryptoError("BAD_INPUT", "Invalid envelope kind");
}

/** Serializes an envelope after checking field sizes; does not encrypt. */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new CryptoError("BAD_INPUT", "Unsupported envelope version");
  }
  assertSupportedSuite(envelope.suite);
  assertLength(envelope.keyRef, KEY_ID_BYTES, "keyRef");
  assertLength(envelope.nonce, NONCE_BYTES, "nonce");
  if (envelope.body.length < TAG_BYTES) {
    throw new CryptoError("BAD_INPUT", "Envelope body is shorter than the tag");
  }

  const header = Uint8Array.of(envelope.version, envelope.suite, kindToByte(envelope.kind));
  return concatBytes(header, envelope.keyRef, envelope.nonce, envelope.body);
}

/**
 * Parses an envelope without decrypting it. Throws `BAD_ENVELOPE` for an unknown version or kind or a
 * buffer too short to hold the header and tag, and `UNSUPPORTED_SUITE` for a suite this package cannot
 * open. Returned fields are copies.
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < HEADER_BYTES + TAG_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Envelope too short");
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new CryptoError("BAD_ENVELOPE", "Unsupported envelope version");
  }
  assertSupportedSuite(bytes[1]!);

  let kind: Envelope["kind"];
  if (bytes[2] === KIND_CAPSULE) {
    kind = "capsule";
  } else if (bytes[2] === KIND_SYM) {
    kind = "sym";
  } else {
    throw new CryptoError("BAD_ENVELOPE", "Unknown envelope kind");
  }

  return {
    version: bytes[0],
    suite: bytes[1]!,
    kind,
    keyRef: bytes.slice(3, AUTHENTICATED_HEADER_BYTES),
    nonce: bytes.slice(AUTHENTICATED_HEADER_BYTES, HEADER_BYTES),
    body: bytes.slice(HEADER_BYTES),
  };
}

/**
 * AES-GCM additional data: the envelope header (version, suite, kind, keyRef; fixed 19 bytes) followed
 * by `buildAad(parts)`. Binding the header means changing any header byte fails decryption instead of
 * redirecting the reader to another key, kind or suite.
 */
function envelopeAad(
  envelope: Pick<Envelope, "version" | "suite" | "kind" | "keyRef">,
  parts: AadParts,
): Uint8Array {
  const header = Uint8Array.of(envelope.version, envelope.suite, kindToByte(envelope.kind));
  return concatBytes(header, envelope.keyRef, buildAad(parts));
}

function importAesKey(key: Uint8Array, usage: "encrypt" | "decrypt") {
  assertLength(key, AES_KEY_BYTES, "key");
  return crypto.subtle.importKey("raw", bufferSource(key), "AES-GCM", false, [usage]);
}

/**
 * Encrypts `plaintext` with AES-256-GCM under `key` and a fresh random 96-bit nonce, and returns the
 * encoded envelope. Padding defaults to `content`; pass `none` only where the plaintext length is fixed
 * and public (key wrappers). The reader must use the same AAD parts and, if `none` was used, `none`.
 * Uses randomness: call from a client or Convex action, never a query or mutation.
 */
export async function sealSym(input: {
  key: Uint8Array;
  keyRef: Uint8Array;
  plaintext: Uint8Array;
  aad: AadParts;
  kind?: "sym" | "capsule";
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  assertLength(input.keyRef, KEY_ID_BYTES, "keyRef");
  const padMode = input.pad ?? "content";
  const kind = input.kind ?? "sym";

  const aesKey = await importAesKey(input.key, "encrypt");
  const nonce = randomBytes(NONCE_BYTES);
  const header = { version: ENVELOPE_VERSION, suite: SUITE_1, kind, keyRef: input.keyRef };
  const data = padMode === "none" ? input.plaintext : pad(input.plaintext, padMode);

  const body = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(nonce),
      additionalData: bufferSource(envelopeAad(header, input.aad)),
      tagLength: TAG_BYTES * 8,
    },
    aesKey,
    bufferSource(data),
  );

  return encodeEnvelope({ ...header, nonce, body: new Uint8Array(body) });
}

/**
 * Decrypts an envelope produced by `sealSym` and removes padding (unless `pad` is `none`). A wrong key,
 * wrong AAD part or any modified byte throws `DECRYPT_FAILED`; malformed envelopes throw `BAD_ENVELOPE`
 * or `UNSUPPORTED_SUITE`. It does not check `keyRef` against an expected value: callers that know which
 * key they hold compare it themselves (the account helpers do).
 */
export async function openSym(input: {
  key: Uint8Array;
  envelope: Uint8Array;
  aad: AadParts;
  pad?: "short" | "content" | "none";
}): Promise<Uint8Array> {
  const envelope = decodeEnvelope(input.envelope);
  const aesKey = await importAesKey(input.key, "decrypt");

  let data: Uint8Array;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bufferSource(envelope.nonce),
        additionalData: bufferSource(envelopeAad(envelope, input.aad)),
        tagLength: TAG_BYTES * 8,
      },
      aesKey,
      bufferSource(envelope.body),
    );
    data = new Uint8Array(plaintext);
  } catch {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }

  if ((input.pad ?? "content") === "none") {
    return data;
  }
  return unpad(data);
}
