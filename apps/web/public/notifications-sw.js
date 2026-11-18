// ../../packages/crypto/src/errors.ts
class CryptoError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}
// ../../packages/crypto/src/suite.ts
var SUITE_1 = 1;
var ENVELOPE_VERSION = 1;
var KEY_ID_BYTES = 16;
var ENCRYPTION_PUBLIC_KEY_BYTES = 1216;
var SIGNING_PUBLIC_KEY_BYTES = 32;
var SIGNATURE_BYTES = 64;
function assertSupportedSuite(suite) {
  if (suite !== SUITE_1) {
    throw new CryptoError("UNSUPPORTED_SUITE", "Unsupported crypto suite");
  }
}
// ../../packages/crypto/src/encoding.ts
var BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var base64UrlLookup;
function getBase64UrlLookup() {
  if (base64UrlLookup === undefined) {
    const lookup = new Int16Array(128).fill(-1);
    for (let index = 0;index < BASE64URL_ALPHABET.length; index++) {
      lookup[BASE64URL_ALPHABET.charCodeAt(index)] = index;
    }
    base64UrlLookup = lookup;
  }
  return base64UrlLookup;
}
function toBase64Url(bytes) {
  let text = "";
  let index = 0;
  for (;index + 2 < bytes.length; index += 3) {
    const chunk = bytes[index] << 16 | bytes[index + 1] << 8 | bytes[index + 2];
    text += BASE64URL_ALPHABET[chunk >> 18] + BASE64URL_ALPHABET[chunk >> 12 & 63] + BASE64URL_ALPHABET[chunk >> 6 & 63] + BASE64URL_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    text += BASE64URL_ALPHABET[chunk >> 18] + BASE64URL_ALPHABET[chunk >> 12 & 63];
  } else if (remaining === 2) {
    const chunk = bytes[index] << 16 | bytes[index + 1] << 8;
    text += BASE64URL_ALPHABET[chunk >> 18] + BASE64URL_ALPHABET[chunk >> 12 & 63] + BASE64URL_ALPHABET[chunk >> 6 & 63];
  }
  return text;
}
function fromBase64Url(text) {
  if (text.length % 4 === 1) {
    throw new CryptoError("BAD_INPUT", "Invalid base64url length");
  }
  const lookup = getBase64UrlLookup();
  const output = new Uint8Array(Math.floor(text.length * 3 / 4));
  let buffer = 0;
  let bufferedBits = 0;
  let outputIndex = 0;
  for (let index = 0;index < text.length; index++) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? lookup[code] : -1;
    if (value < 0) {
      throw new CryptoError("BAD_INPUT", "Invalid base64url character");
    }
    buffer = (buffer << 6 | value) & 16777215;
    bufferedBits += 6;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      output[outputIndex++] = buffer >> bufferedBits & 255;
    }
  }
  if ((buffer & (1 << bufferedBits) - 1) !== 0) {
    throw new CryptoError("BAD_INPUT", "Non-canonical base64url encoding");
  }
  return output;
}
function utf8(text) {
  return new TextEncoder().encode(text);
}
function randomBytes(length) {
  if (!Number.isInteger(length) || length < 0) {
    throw new CryptoError("BAD_INPUT", "Invalid random length");
  }
  const bytes = new Uint8Array(length);
  for (let offset = 0;offset < length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));
  }
  return bytes;
}
function equalBytes(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0;index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
function concatBytes(...parts) {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function lengthPrefixed(parts) {
  let length = 0;
  for (const part of parts) {
    length += 4 + part.length;
  }
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    output.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return output;
}
function toHex(bytes) {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}
function assertLength(bytes, length, name) {
  if (bytes.length !== length) {
    throw new CryptoError("BAD_INPUT", `${name} must be ${length} bytes`);
  }
}
function bufferSource(bytes) {
  return bytes;
}
// ../../packages/crypto/src/kdf.ts
var LABELS = {
  accountKek: "radium/v1/account-kek",
  recoveryKek: "radium/v1/recovery-kek",
  deviceRecovery: "radium/v1/device-recovery",
  deviceRecoveryId: "radium/v1/device-recovery-id",
  object: "radium/v1/object",
  response: "radium/v1/response",
  invite: "radium/v1/invite",
  workspacePhrase: "radium/v1/workspace-phrase",
  workspacePhraseMac: "radium/v1/workspace-phrase-mac",
  inviteMac: "radium/v1/invite-mac",
  trustStore: "radium/v1/trust-store",
  deviceWrap: "radium/v1/device-wrap",
  workerPairing: "radium/v1/worker-pairing"
};
var MAX_HKDF_BYTES = 255 * 32;
async function hkdf(ikm, info, length = 32, salt = new Uint8Array(0)) {
  if (ikm.length === 0) {
    throw new CryptoError("BAD_INPUT", "HKDF input key material is empty");
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_HKDF_BYTES) {
    throw new CryptoError("BAD_INPUT", "Invalid HKDF output length");
  }
  const infoBytes = typeof info === "string" ? utf8(info) : info;
  const key = await crypto.subtle.importKey("raw", bufferSource(ikm), "HKDF", false, [
    "deriveBits"
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bufferSource(salt), info: bufferSource(infoBytes) }, key, length * 8);
  return new Uint8Array(bits);
}
// ../../packages/crypto/src/aad.ts
var AAD_PREFIX = "radium/v1";
function buildAad(parts) {
  return lengthPrefixed([
    utf8(AAD_PREFIX),
    utf8(parts.table),
    utf8(parts.workspace),
    utf8(parts.parent),
    utf8(parts.record),
    utf8(parts.field)
  ]);
}
// ../../packages/crypto/src/padding.ts
var LENGTH_PREFIX_BYTES = 4;
var SHORT_BUCKET_BYTES = 32;
var CONTENT_MIN_BYTES = 32;
var CONTENT_PAGE_BYTES = 4096;
var MAX_DATA_BYTES = 4294967295 - LENGTH_PREFIX_BYTES;
function paddedLength(framedLength, mode) {
  if (mode === "short") {
    return Math.ceil(framedLength / SHORT_BUCKET_BYTES) * SHORT_BUCKET_BYTES;
  }
  if (framedLength > CONTENT_PAGE_BYTES) {
    return Math.ceil(framedLength / CONTENT_PAGE_BYTES) * CONTENT_PAGE_BYTES;
  }
  let bucket = CONTENT_MIN_BYTES;
  while (bucket < framedLength) {
    bucket *= 2;
  }
  return bucket;
}
function pad(data, mode) {
  if (data.length > MAX_DATA_BYTES) {
    throw new CryptoError("BAD_INPUT", "Data too large to pad");
  }
  const padded = new Uint8Array(paddedLength(LENGTH_PREFIX_BYTES + data.length, mode));
  new DataView(padded.buffer).setUint32(0, data.length);
  padded.set(data, LENGTH_PREFIX_BYTES);
  return padded;
}
function unpad(padded) {
  if (padded.length < LENGTH_PREFIX_BYTES) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }
  const dataLength = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  const dataEnd = LENGTH_PREFIX_BYTES + dataLength;
  if (dataEnd > padded.length) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }
  let fill = 0;
  for (let index = dataEnd;index < padded.length; index++) {
    fill |= padded[index];
  }
  if (fill !== 0) {
    throw new CryptoError("BAD_INPUT", "Invalid padding");
  }
  return padded.slice(LENGTH_PREFIX_BYTES, dataEnd);
}
// ../../packages/crypto/src/envelope.ts
var KIND_CAPSULE = 1;
var KIND_SYM = 2;
var NONCE_BYTES = 12;
var TAG_BYTES = 16;
var AES_KEY_BYTES = 32;
var AUTHENTICATED_HEADER_BYTES = 3 + KEY_ID_BYTES;
var HEADER_BYTES = AUTHENTICATED_HEADER_BYTES + NONCE_BYTES;
function kindToByte(kind) {
  if (kind === "capsule") {
    return KIND_CAPSULE;
  }
  if (kind === "sym") {
    return KIND_SYM;
  }
  throw new CryptoError("BAD_INPUT", "Invalid envelope kind");
}
function encodeEnvelope(envelope) {
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
function decodeEnvelope(bytes) {
  if (bytes.length < HEADER_BYTES + TAG_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Envelope too short");
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new CryptoError("BAD_ENVELOPE", "Unsupported envelope version");
  }
  assertSupportedSuite(bytes[1]);
  let kind;
  if (bytes[2] === KIND_CAPSULE) {
    kind = "capsule";
  } else if (bytes[2] === KIND_SYM) {
    kind = "sym";
  } else {
    throw new CryptoError("BAD_ENVELOPE", "Unknown envelope kind");
  }
  return {
    version: bytes[0],
    suite: bytes[1],
    kind,
    keyRef: bytes.slice(3, AUTHENTICATED_HEADER_BYTES),
    nonce: bytes.slice(AUTHENTICATED_HEADER_BYTES, HEADER_BYTES),
    body: bytes.slice(HEADER_BYTES)
  };
}
function envelopeAad(envelope, parts) {
  const header = Uint8Array.of(envelope.version, envelope.suite, kindToByte(envelope.kind));
  return concatBytes(header, envelope.keyRef, buildAad(parts));
}
function importAesKey(key, usage) {
  assertLength(key, AES_KEY_BYTES, "key");
  return crypto.subtle.importKey("raw", bufferSource(key), "AES-GCM", false, [usage]);
}
async function sealSym(input) {
  assertLength(input.keyRef, KEY_ID_BYTES, "keyRef");
  const padMode = input.pad ?? "content";
  const kind = input.kind ?? "sym";
  const aesKey = await importAesKey(input.key, "encrypt");
  const nonce = randomBytes(NONCE_BYTES);
  const header = { version: ENVELOPE_VERSION, suite: SUITE_1, kind, keyRef: input.keyRef };
  const data = padMode === "none" ? input.plaintext : pad(input.plaintext, padMode);
  const body = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: bufferSource(nonce),
    additionalData: bufferSource(envelopeAad(header, input.aad)),
    tagLength: TAG_BYTES * 8
  }, aesKey, bufferSource(data));
  return encodeEnvelope({ ...header, nonce, body: new Uint8Array(body) });
}
async function openSym(input) {
  const envelope = decodeEnvelope(input.envelope);
  const aesKey = await importAesKey(input.key, "decrypt");
  let data;
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: bufferSource(envelope.nonce),
      additionalData: bufferSource(envelopeAad(envelope, input.aad)),
      tagLength: TAG_BYTES * 8
    }, aesKey, bufferSource(envelope.body));
    data = new Uint8Array(plaintext);
  } catch {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }
  if ((input.pad ?? "content") === "none") {
    return data;
  }
  return unpad(data);
}
// ../../node_modules/.bun/hpke@1.1.8/node_modules/hpke/index.js
function ComputeNonce(base_nonce, seq, Nn) {
  const nonce = new Uint8Array(Nn);
  nonce.set(base_nonce);
  let s = seq;
  for (let i = Nn - 1;i >= 0 && s > 0; i--) {
    nonce[i] = nonce[i] ^ s & 255;
    s = Math.floor(s / 256);
  }
  return nonce;
}
function MaxSeq(Nn) {
  return Math.min(2 ** (8 * Nn) - 1, Number.MAX_SAFE_INTEGER);
}
function IncrementSeq(seq, maxSeq) {
  if (seq >= maxSeq) {
    throw new MessageLimitReachedError("Sequence number overflow");
  }
  return ++seq;
}
async function Export_OneStage(KDF, suite_id, exporter_secret, exporter_context, L) {
  checkLength(exporter_context, "Exporter context", MAX_LENGTH_ONE_STAGE);
  return await LabeledDerive(KDF, suite_id, exporter_secret, L_sec, exporter_context, L);
}
async function Export_TwoStage(KDF, suite_id, exporter_secret, exporter_context, L) {
  checkLength(exporter_context, "Exporter context", MAX_LENGTH_TWO_STAGE);
  return await LabeledExpand(KDF, suite_id, exporter_secret, L_sec, exporter_context, L);
}
async function ContextExport(suite, exporterSecret, exporterContext, L) {
  checkUint8Array(exporterContext, "exporterContext");
  const stages = KDFStages(suite.KDF);
  if (!Number.isInteger(L) || L <= 0 || L > 65535) {
    throw new TypeError('"L" must be a positive integer not exceeding 65535');
  }
  if (stages === 2 && L > 255 * suite.KDF.Nh) {
    throw new TypeError('"L" must not exceed 255*Nh of the cipher suite KDF');
  }
  const Export = stages === 1 ? Export_OneStage : Export_TwoStage;
  return await Export(suite.KDF, suite.id, exporterSecret, exporterContext, L);
}

class Mutex {
  #locked = Promise.resolve();
  async lock() {
    let releaseLock;
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.#locked;
    this.#locked = nextLock;
    await previousLock;
    return releaseLock;
  }
}
function createContextState(suite, mode, key, base_nonce, exporter_secret) {
  return {
    suite,
    mode,
    key,
    base_nonce,
    exporter_secret,
    max_seq: MaxSeq(suite.AEAD.Nn),
    seq: 0,
    mutex: undefined
  };
}

class SenderContext {
  #state;
  constructor(suite, mode, key, base_nonce, exporter_secret) {
    this.#state = createContextState(suite, mode, key, base_nonce, exporter_secret);
  }
  get mode() {
    return this.#state.mode;
  }
  get seq() {
    return this.#state.seq;
  }
  async Seal(plaintext, aad) {
    checkUint8Array(plaintext, "plaintext");
    aad ??= new Uint8Array;
    checkUint8Array(aad, "aad");
    const state = this.#state;
    if (state.suite.AEAD.id === EXPORT_ONLY) {
      throw new TypeError("Export-only AEAD cannot be used with Seal");
    }
    state.mutex ??= new Mutex;
    const release = await state.mutex.lock();
    let ct;
    try {
      ct = await state.suite.AEAD.Seal(state.key, ComputeNonce(state.base_nonce, state.seq, state.suite.AEAD.Nn), aad, plaintext);
      state.seq = IncrementSeq(state.seq, state.max_seq);
      return ct;
    } finally {
      release();
    }
  }
  async Export(exporterContext, length) {
    return await ContextExport(this.#state.suite, this.#state.exporter_secret, exporterContext, length);
  }
  get Nt() {
    return this.#state.suite.AEAD.Nt;
  }
}

class RecipientContext {
  #state;
  constructor(suite, mode, key, base_nonce, exporter_secret) {
    this.#state = createContextState(suite, mode, key, base_nonce, exporter_secret);
  }
  get mode() {
    return this.#state.mode;
  }
  get seq() {
    return this.#state.seq;
  }
  async Open(ciphertext, aad) {
    checkUint8Array(ciphertext, "ciphertext");
    aad ??= new Uint8Array;
    checkUint8Array(aad, "aad");
    const state = this.#state;
    if (state.suite.AEAD.id === EXPORT_ONLY) {
      throw new TypeError("Export-only AEAD cannot be used with Open");
    }
    state.mutex ??= new Mutex;
    const release = await state.mutex.lock();
    try {
      let pt;
      try {
        pt = await state.suite.AEAD.Open(state.key, ComputeNonce(state.base_nonce, state.seq, state.suite.AEAD.Nn), aad, ciphertext);
      } catch (cause) {
        if (cause instanceof MessageLimitReachedError || cause instanceof NotSupportedError) {
          throw cause;
        }
        throw new OpenError("AEAD decryption failed", { cause });
      }
      state.seq = IncrementSeq(state.seq, state.max_seq);
      return pt;
    } finally {
      release();
    }
  }
  async Export(exporterContext, length) {
    return await ContextExport(this.#state.suite, this.#state.exporter_secret, exporterContext, length);
  }
}
var validate = (factory, type) => {
  try {
    const result = factory();
    if (result.type !== type) {
      throw new Error(`Invalid "${type}" return discriminator`);
    }
    return result;
  } catch (cause) {
    throw new TypeError(`Invalid "${type}"`, { cause });
  }
};

class CipherSuite {
  #suite;
  constructor(KEM, KDF, AEAD) {
    const kem = validate(KEM, "KEM");
    const kdf = validate(KDF, "KDF");
    const aead = validate(AEAD, "AEAD");
    this.#suite = {
      KEM: kem,
      KDF: kdf,
      AEAD: aead,
      id: concat(L_HPKE, I2OSP(kem.id, 2), I2OSP(kdf.id, 2), I2OSP(aead.id, 2))
    };
  }
  get KEM() {
    return {
      id: this.#suite.KEM.id,
      name: this.#suite.KEM.name,
      Nsecret: this.#suite.KEM.Nsecret,
      Nenc: this.#suite.KEM.Nenc,
      Npk: this.#suite.KEM.Npk,
      Nsk: this.#suite.KEM.Nsk
    };
  }
  get KDF() {
    return {
      id: this.#suite.KDF.id,
      name: this.#suite.KDF.name,
      stages: this.#suite.KDF.stages,
      Nh: this.#suite.KDF.Nh
    };
  }
  get AEAD() {
    return {
      id: this.#suite.AEAD.id,
      name: this.#suite.AEAD.name,
      Nk: this.#suite.AEAD.Nk,
      Nn: this.#suite.AEAD.Nn,
      Nt: this.#suite.AEAD.Nt
    };
  }
  async GenerateKeyPair(extractable) {
    extractable ??= false;
    checkExtractable(extractable);
    return await this.#suite.KEM.GenerateKeyPair(extractable);
  }
  async DeriveKeyPair(ikm, extractable) {
    extractable ??= false;
    checkExtractable(extractable);
    checkUint8Array(ikm, "ikm");
    if (ikm.byteLength < this.#suite.KEM.Nsk) {
      throw new DeriveKeyPairError('Insufficient "ikm" length');
    }
    try {
      return await this.#suite.KEM.DeriveKeyPair(ikm, extractable);
    } catch (cause) {
      if (cause instanceof NotSupportedError) {
        throw cause;
      }
      throw new DeriveKeyPairError("Key derivation failed", { cause });
    }
  }
  async SerializePrivateKey(privateKey) {
    isKey(privateKey, "private", true);
    return await this.#suite.KEM.SerializePrivateKey(privateKey);
  }
  async SerializePublicKey(publicKey) {
    isKey(publicKey, "public", true);
    return await this.#suite.KEM.SerializePublicKey(publicKey);
  }
  async DeserializePrivateKey(privateKey, extractable) {
    extractable ??= false;
    checkExtractable(extractable);
    checkUint8Array(privateKey, "privateKey");
    try {
      if (privateKey.byteLength !== this.#suite.KEM.Nsk) {
        throw new Error('Invalid "privateKey" length');
      }
      return await this.#suite.KEM.DeserializePrivateKey(privateKey, extractable);
    } catch (cause) {
      if (cause instanceof NotSupportedError) {
        throw cause;
      }
      throw new DeserializeError("Private key deserialization failed", { cause });
    }
  }
  async DeserializePublicKey(publicKey) {
    checkUint8Array(publicKey, "publicKey");
    try {
      if (publicKey.byteLength !== this.#suite.KEM.Npk) {
        throw new Error('Invalid "publicKey" length');
      }
      return await this.#suite.KEM.DeserializePublicKey(publicKey);
    } catch (cause) {
      if (cause instanceof NotSupportedError) {
        throw cause;
      }
      throw new DeserializeError("Public key deserialization failed", { cause });
    }
  }
  async Seal(publicKey, plaintext, options) {
    if (this.#suite.AEAD.id === EXPORT_ONLY) {
      throw new TypeError("Export-only AEAD cannot be used with Seal");
    }
    const { encapsulatedSecret, ctx } = await this.SetupSender(publicKey, options);
    const ciphertext = await ctx.Seal(plaintext, options?.aad);
    return { encapsulatedSecret, ciphertext };
  }
  async Open(privateKey, encapsulatedSecret, ciphertext, options) {
    if (this.#suite.AEAD.id === EXPORT_ONLY) {
      throw new TypeError("Export-only AEAD cannot be used with Open");
    }
    const ctx = await this.SetupRecipient(privateKey, encapsulatedSecret, options);
    return await ctx.Open(ciphertext, options?.aad);
  }
  async SendExport(publicKey, exporterContext, length, options) {
    const { encapsulatedSecret, ctx } = await this.SetupSender(publicKey, options);
    const exportedSecret = await ctx.Export(exporterContext, length);
    return { encapsulatedSecret, exportedSecret };
  }
  async ReceiveExport(privateKey, encapsulatedSecret, exporterContext, length, options) {
    const ctx = await this.SetupRecipient(privateKey, encapsulatedSecret, options);
    return await ctx.Export(exporterContext, length);
  }
  async SetupSender(publicKey, options) {
    isKey(publicKey, "public");
    let shared_secret;
    let enc;
    try {
      const result = await this.#suite.KEM.Encap(publicKey);
      shared_secret = result.shared_secret;
      enc = result.enc;
    } catch (cause) {
      if (cause instanceof ValidationError || cause instanceof NotSupportedError) {
        throw cause;
      }
      throw new EncapError("Encapsulation failed", { cause });
    }
    const mode = options?.psk?.byteLength ? MODE_PSK : MODE_BASE;
    const { key, base_nonce, exporter_secret } = await KeySchedule(this.#suite, mode, shared_secret, options?.info, options?.psk, options?.pskId);
    const ctx = new SenderContext(this.#suite, mode, key, base_nonce, exporter_secret);
    return { encapsulatedSecret: enc, ctx };
  }
  async SetupRecipient(privateKey, encapsulatedSecret, options) {
    const { skR, pkR } = this.#extractRecipientKeys(privateKey);
    checkUint8Array(encapsulatedSecret, "encapsulatedSecret");
    if (encapsulatedSecret.byteLength !== this.#suite.KEM.Nenc) {
      throw new DecapError("Invalid encapsulated secret length");
    }
    let shared_secret;
    try {
      shared_secret = await this.#suite.KEM.Decap(encapsulatedSecret, skR, pkR);
    } catch (cause) {
      if (cause instanceof ValidationError || cause instanceof NotSupportedError) {
        throw cause;
      }
      throw new DecapError("Decapsulation failed", { cause });
    }
    const mode = options?.psk?.byteLength ? MODE_PSK : MODE_BASE;
    const { key, base_nonce, exporter_secret } = await KeySchedule(this.#suite, mode, shared_secret, options?.info, options?.psk, options?.pskId);
    return new RecipientContext(this.#suite, mode, key, base_nonce, exporter_secret);
  }
  #extractRecipientKeys(skR) {
    if (isKeyPair(skR)) {
      return { skR: skR.privateKey, pkR: skR.publicKey };
    }
    isKey(skR, "private");
    return { skR, pkR: undefined };
  }
}

class ValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ValidationError";
    Error.captureStackTrace?.(this, ValidationError);
  }
}

class DeserializeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DeserializeError";
    Error.captureStackTrace?.(this, DeserializeError);
  }
}

class EncapError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EncapError";
    Error.captureStackTrace?.(this, EncapError);
  }
}

class DecapError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DecapError";
    Error.captureStackTrace?.(this, DecapError);
  }
}

class OpenError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OpenError";
    Error.captureStackTrace?.(this, OpenError);
  }
}

class MessageLimitReachedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MessageLimitReachedError";
    Error.captureStackTrace?.(this, MessageLimitReachedError);
  }
}

class DeriveKeyPairError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DeriveKeyPairError";
    Error.captureStackTrace?.(this, DeriveKeyPairError);
  }
}

class NotSupportedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NotSupportedError";
    Error.captureStackTrace?.(this, NotSupportedError);
  }
}
var MODE_BASE = 0;
var MODE_PSK = 1;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
function slice(buffer, start, end) {
  return Uint8Array.prototype.slice.call(buffer, start, end);
}
function encode(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0;i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127) {
      throw new TypeError("Input string must contain only ASCII characters");
    }
    bytes[i] = code;
  }
  return bytes;
}
function I2OSP(n, w) {
  if (!Number.isSafeInteger(w) || w <= 0) {
    throw new Error("w must be a positive safe integer");
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("n must be a non-negative safe integer");
  }
  const max = Math.pow(256, w);
  if (n >= max) {
    throw new Error("n too large to fit in w-length byte string");
  }
  const ret = new Uint8Array(w);
  let num = n;
  for (let i = 0;i < w && num; i++) {
    ret[w - (i + 1)] = num % 256;
    num = Math.floor(num / 256);
  }
  return ret;
}
var L_HPKE_v1 = /* @__PURE__ */ encode("HPKE-v1");
var L_HPKE = /* @__PURE__ */ encode("HPKE");
var L_KEM = /* @__PURE__ */ encode("KEM");
var L_sec = /* @__PURE__ */ encode("sec");
var L_secret = /* @__PURE__ */ encode("secret");
var L_key = /* @__PURE__ */ encode("key");
var L_base_nonce = /* @__PURE__ */ encode("base_nonce");
var L_exp = /* @__PURE__ */ encode("exp");
var L_psk_id_hash = /* @__PURE__ */ encode("psk_id_hash");
var L_info_hash = /* @__PURE__ */ encode("info_hash");
var L_DeriveKeyPair = /* @__PURE__ */ encode("DeriveKeyPair");
function lengthPrefixed2(x) {
  return concat(I2OSP(x.byteLength, 2), x);
}
var MAX_LENGTH_TWO_STAGE = 65535;
var MAX_LENGTH_ONE_STAGE = 65535;
function checkLength(data, name, maxLength) {
  if (data.byteLength > maxLength) {
    throw new TypeError(`${name} length must not exceed ${maxLength} bytes`);
  }
}
function checkUint8Array(input, name) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError(`"${name}" must be Uint8Array`);
  }
  if (typeof SharedArrayBuffer !== "undefined" && input.buffer instanceof SharedArrayBuffer) {
    throw new TypeError(`"${name}" must not be backed by a SharedArrayBuffer`);
  }
}
function checkExtractable(extractable) {
  if (typeof extractable !== "boolean") {
    throw new TypeError('"extractable" must be boolean');
  }
}
async function LabeledDerive(KDF, suite_id, ikm, label, context, L) {
  const labeled_ikm = concat(ikm, L_HPKE_v1, suite_id, lengthPrefixed2(label), I2OSP(L, 2), context);
  return await KDF.Derive(labeled_ikm, L);
}
async function LabeledExtract(KDF, suite_id, salt, label, ikm) {
  const labeled_ikm = concat(L_HPKE_v1, suite_id, label, ikm);
  return await KDF.Extract(salt, labeled_ikm);
}
async function LabeledExpand(KDF, suite_id, prk, label, info, L) {
  const labeled_info = concat(I2OSP(L, 2), L_HPKE_v1, suite_id, label, info);
  return await KDF.Expand(prk, labeled_info, L);
}
function isKeyPair(skR) {
  if (!skR || typeof skR !== "object")
    return false;
  if ("publicKey" in skR && "privateKey" in skR) {
    const pkR = skR.publicKey;
    skR = skR.privateKey;
    try {
      isKey(pkR, "public");
      isKey(skR, "private");
      if (pkR.algorithm.name !== skR.algorithm.name) {
        throw new TypeError("key pair algorithms do not match");
      }
    } catch (cause) {
      throw new TypeError('Invalid "privateKey"', { cause });
    }
    return true;
  }
  return false;
}
function isKey(key, type, extractable) {
  const k = key;
  if (typeof k.algorithm !== "object" || typeof k.algorithm.name !== "string" || typeof k.extractable !== "boolean" || typeof k.type !== "string" || k.type !== type) {
    throw new TypeError(`Invalid "${type}Key"`);
  }
  if (extractable && k.extractable !== true) {
    throw new TypeError(`"${type}Key" must be extractable`);
  }
}
function KDFStages(KDF) {
  if (KDF.stages === 1 || KDF.stages === 2) {
    return KDF.stages;
  }
  throw new Error("unreachable");
}
async function CombineSecrets_OneStage(suite, mode, shared_secret, info, psk, psk_id) {
  checkLength(psk, "PSK", MAX_LENGTH_ONE_STAGE);
  checkLength(psk_id, "PSK ID", MAX_LENGTH_ONE_STAGE);
  checkLength(info, "Info", MAX_LENGTH_ONE_STAGE);
  const secrets = concat(lengthPrefixed2(psk), lengthPrefixed2(shared_secret));
  const context = concat(I2OSP(mode, 1), lengthPrefixed2(psk_id), lengthPrefixed2(info));
  const secret = await LabeledDerive(suite.KDF, suite.id, secrets, L_secret, context, suite.AEAD.Nk + suite.AEAD.Nn + suite.KDF.Nh);
  const key = slice(secret, 0, suite.AEAD.Nk);
  const base_nonce = slice(secret, suite.AEAD.Nk, suite.AEAD.Nk + suite.AEAD.Nn);
  const exporter_secret = slice(secret, suite.AEAD.Nk + suite.AEAD.Nn);
  return { key, base_nonce, exporter_secret };
}
async function CombineSecrets_TwoStage(suite, mode, shared_secret, info, psk, psk_id) {
  checkLength(psk, "PSK", MAX_LENGTH_TWO_STAGE);
  checkLength(psk_id, "PSK ID", MAX_LENGTH_TWO_STAGE);
  checkLength(info, "Info", MAX_LENGTH_TWO_STAGE);
  const [psk_id_hash, info_hash] = await Promise.all([
    LabeledExtract(suite.KDF, suite.id, new Uint8Array, L_psk_id_hash, psk_id),
    LabeledExtract(suite.KDF, suite.id, new Uint8Array, L_info_hash, info)
  ]);
  const key_schedule_context = concat(I2OSP(mode, 1), psk_id_hash, info_hash);
  const secret = await LabeledExtract(suite.KDF, suite.id, shared_secret, L_secret, psk);
  if (suite.AEAD.id === EXPORT_ONLY) {
    const exporter_secret = await LabeledExpand(suite.KDF, suite.id, secret, L_exp, key_schedule_context, suite.KDF.Nh);
    return { key: new Uint8Array, base_nonce: new Uint8Array, exporter_secret };
  }
  const [key, base_nonce, exporter_secret] = await Promise.all([
    LabeledExpand(suite.KDF, suite.id, secret, L_key, key_schedule_context, suite.AEAD.Nk),
    LabeledExpand(suite.KDF, suite.id, secret, L_base_nonce, key_schedule_context, suite.AEAD.Nn),
    LabeledExpand(suite.KDF, suite.id, secret, L_exp, key_schedule_context, suite.KDF.Nh)
  ]);
  return { key, base_nonce, exporter_secret };
}
async function KeySchedule(suite, mode, shared_secret, info, psk, pskId) {
  info ??= new Uint8Array;
  checkUint8Array(info, "info");
  psk ??= new Uint8Array;
  checkUint8Array(psk, "psk");
  pskId ??= new Uint8Array;
  checkUint8Array(pskId, "pskId");
  const stages = KDFStages(suite.KDF);
  const CombineSecrets = stages === 1 ? CombineSecrets_OneStage : CombineSecrets_TwoStage;
  VerifyPSKInputs(psk, pskId);
  return await CombineSecrets(suite, mode, shared_secret, info, psk, pskId);
}
function VerifyPSKInputs(psk, psk_id) {
  if (psk.byteLength && psk_id.byteLength) {
    if (psk.byteLength < 32) {
      throw new TypeError("Insufficient PSK length");
    }
    return;
  }
  if (!psk.byteLength && !psk_id.byteLength) {
    return;
  }
  throw new TypeError("Inconsistent PSK inputs");
}
var NotApplicable = () => {
  throw new Error("unreachable");
};
var EXPORT_ONLY = 65535;
var AES_GCM_P_MAX = 2 ** 36 - 31;
var CHACHA20_POLY1305_P_MAX = 2 ** 38 - 64;
async function subtle(promise, name) {
  try {
    return await promise(crypto.subtle);
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof DOMException && cause.name === "NotSupportedError") {
      throw new NotSupportedError(`${name} is unsupported in this runtime`, { cause });
    }
    throw cause;
  }
}
async function getCachedCryptoKey(cache, keyBytes, init) {
  const cached = cache.get(keyBytes);
  if (cached && cached.bytes.byteLength === keyBytes.byteLength && cached.bytes.every((byte, index) => byte === keyBytes[index])) {
    return cached.key;
  }
  const bytes = slice(keyBytes);
  const entry = { bytes, key: init(bytes) };
  cache.set(keyBytes, entry);
  try {
    return await entry.key;
  } catch (cause) {
    if (cache.get(keyBytes) === entry)
      cache.delete(keyBytes);
    throw cause;
  }
}
function HKDF_SHARED() {
  let emptySalt;
  async function importKey(salt) {
    return await subtle((c) => c.importKey("raw", salt, { name: "HMAC", hash: this.hash }, false, ["sign"]), this.name);
  }
  const cache = new WeakMap;
  return {
    stages: 2,
    Derive: NotApplicable,
    async Extract(salt, ikm) {
      const key = salt.byteLength === 0 ? emptySalt ??= await importKey.call(this, new ArrayBuffer(this.Nh)) : await importKey.call(this, salt);
      return new Uint8Array(await subtle((c) => c.sign("HMAC", key, ikm), this.name));
    },
    async Expand(prk, info, L) {
      if (prk.byteLength < this.Nh) {
        throw new Error("prk.byteLength < this.Nh");
      }
      if (L > 255 * this.Nh) {
        throw new Error("L must be <= 255*Nh");
      }
      const N = Math.ceil(L / this.Nh);
      const key = await getCachedCryptoKey(cache, prk, (bytes) => importKey.call(this, bytes));
      const T = new Uint8Array(N * this.Nh);
      let T_prev = new Uint8Array;
      for (let i = 0;i < N; i++) {
        const input = new Uint8Array(T_prev.byteLength + info.byteLength + 1);
        input.set(T_prev);
        input.set(info, T_prev.byteLength);
        input[T_prev.byteLength + info.byteLength] = i + 1;
        const T_i = new Uint8Array(await subtle((c) => c.sign("HMAC", key, input), this.name));
        T.set(T_i, i * this.Nh);
        T_prev = T_i;
      }
      return slice(T, 0, L);
    }
  };
}
var KDF_HKDF_SHA256 = function() {
  return { id: 1, type: "KDF", name: "HKDF-SHA256", Nh: 32, hash: "SHA-256", ...HKDF_SHARED() };
};
async function ShakeDerive(name, variant, ikm, L) {
  const bits = L << 3;
  const alg = { name: variant, length: bits, outputLength: bits };
  return new Uint8Array(await subtle((c) => c.digest(alg, ikm), name));
}
function SHAKE_SHARED() {
  return {
    stages: 1,
    async Derive(labeled_ikm, L) {
      return await ShakeDerive(this.name, this.algorithm, labeled_ikm, L);
    },
    Extract: NotApplicable,
    Expand: NotApplicable
  };
}
var KDF_SHAKE256 = function() {
  return {
    id: 17,
    type: "KDF",
    name: "SHAKE256",
    Nh: 64,
    algorithm: "cSHAKE256",
    ...SHAKE_SHARED()
  };
};
async function getPublicKeyByExport(name, key, usages) {
  if (!key.extractable) {
    throw new TypeError('"privateKey" must be extractable or a Key Pair must be used in this runtime');
  }
  return await subtle(async (c) => {
    const jwk = await c.exportKey("jwk", key);
    return c.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, key.algorithm, true, usages);
  }, name);
}
async function getPublicKey(name, key, usages) {
  return await subtle((c) => c.getPublicKey?.(key, usages), name) || await getPublicKeyByExport(name, key, usages);
}
function assertKeyAlgorithm(key, expectedAlgorithm) {
  if (key.algorithm.name !== expectedAlgorithm.name) {
    throw new TypeError(`key algorithm must be ${expectedAlgorithm.name}`);
  }
  if (key.algorithm.namedCurve !== expectedAlgorithm.namedCurve) {
    throw new TypeError(`key namedCurve must be ${expectedAlgorithm.namedCurve}`);
  }
}
function assertCryptoKey(key) {
  if (key[Symbol.toStringTag] !== "CryptoKey") {
    if (key instanceof CryptoKey)
      return;
    throw new TypeError("unexpected key constructor");
  }
}
async function CurveKeyFromD(name, Nsk, template, algorithm, key, extractable) {
  const tmpl = slice(template);
  const pkcs8 = new Uint8Array(Nsk + tmpl.byteLength);
  pkcs8.set(tmpl);
  pkcs8.set(key, tmpl.byteLength);
  return await subtle((c) => c.importKey("pkcs8", pkcs8, algorithm, extractable, ["deriveBits"]), name);
}
function DIRECT_KEM_SHARED() {
  return {
    async DeriveKeyPair(ikm, extractable) {
      const dk = await LabeledDerive(this.kdf, this.suite_id, ikm, L_DeriveKeyPair, new Uint8Array, this.Nsk);
      const privateKey = await this.DeserializePrivateKey(dk, extractable);
      const usages = ["encapsulateBits"];
      const publicKey = await getPublicKey(this.name, privateKey, usages);
      return { privateKey, publicKey };
    },
    async GenerateKeyPair(extractable) {
      const usages = ["encapsulateBits", "decapsulateBits"];
      return await subtle((c) => c.generateKey(this.algorithm, extractable, usages), this.name);
    },
    async SerializePublicKey(key) {
      assertKeyAlgorithm(key, this.algorithm);
      assertCryptoKey(key);
      const format = "raw-public";
      return new Uint8Array(await subtle((c) => c.exportKey(format, key), this.name));
    },
    async DeserializePublicKey(key) {
      const format = "raw-public";
      const usages = ["encapsulateBits"];
      return await subtle((c) => c.importKey(format, key, this.algorithm, true, usages), this.name);
    },
    async SerializePrivateKey(key) {
      assertKeyAlgorithm(key, this.algorithm);
      assertCryptoKey(key);
      const format = "raw-seed";
      return new Uint8Array(await subtle((c) => c.exportKey(format, key), this.name));
    },
    async DeserializePrivateKey(key, extractable) {
      const format = "raw-seed";
      const usages = ["decapsulateBits"];
      return await subtle((c) => c.importKey(format, key, this.algorithm, extractable, usages), this.name);
    },
    async Encap(pkR) {
      assertKeyAlgorithm(pkR, this.algorithm);
      const { sharedKey, ciphertext } = await subtle((c) => c.encapsulateBits(this.algorithm, pkR), this.name);
      return { shared_secret: new Uint8Array(sharedKey), enc: new Uint8Array(ciphertext) };
    },
    async Decap(enc, skR, _pkR) {
      assertKeyAlgorithm(skR, this.algorithm);
      return new Uint8Array(await subtle((c) => c.decapsulateBits(this.algorithm, skR, enc), this.name));
    }
  };
}
function createDirectKEM({ id, name, Nsecret, Nenc, Npk, Nsk }) {
  const kdf = KDF_SHAKE256();
  kdf.name = name;
  return {
    id,
    suite_id: concat(L_KEM, I2OSP(id, 2)),
    type: "KEM",
    name,
    Nsecret,
    Nenc,
    Npk,
    Nsk,
    algorithm: { name },
    kdf,
    ...DIRECT_KEM_SHARED()
  };
}
function AEAD_SHARED(P_MAX) {
  const cache = new WeakMap;
  async function importKey(key) {
    return await subtle((c) => c.importKey(this.keyFormat, key, this.algorithm, false, [
      "encrypt",
      "decrypt"
    ]), this.name);
  }
  return {
    async Seal(key, nonce, aad, pt) {
      if (pt.byteLength > P_MAX) {
        throw new RangeError('"pt" exceeds P_MAX');
      }
      const cryptoKey = await getCachedCryptoKey(cache, key, (bytes) => importKey.call(this, bytes));
      return new Uint8Array(await subtle((c) => c.encrypt({
        name: this.algorithm,
        iv: nonce,
        additionalData: aad
      }, cryptoKey, pt), this.name));
    },
    async Open(key, nonce, aad, ct) {
      const cryptoKey = await getCachedCryptoKey(cache, key, (bytes) => importKey.call(this, bytes));
      return new Uint8Array(await subtle((c) => c.decrypt({
        name: this.algorithm,
        iv: nonce,
        additionalData: aad
      }, cryptoKey, ct), this.name));
    }
  };
}
var AEAD_AES_256_GCM = function() {
  return {
    id: 2,
    type: "AEAD",
    name: "AES-256-GCM",
    Nk: 32,
    Nn: 12,
    Nt: 16,
    algorithm: "AES-GCM",
    keyFormat: "raw",
    ...AEAD_SHARED(AES_GCM_P_MAX)
  };
};
var InvalidInvocation = (_) => {
  if (_ !== priv) {
    throw new Error("invalid invocation");
  }
};
var priv = /* @__PURE__ */ Symbol();

class HybridKey {
  #algorithm;
  #type;
  #extractable;
  #t;
  #pq;
  #seed;
  #publicKey;
  static #isValid(key) {
    return key.#algorithm !== undefined;
  }
  static validate(key, extractable) {
    try {
      if (!HybridKey.#isValid(key)) {
        throw new TypeError("unexpected key constructor");
      }
    } catch {
      throw new TypeError("unexpected key constructor");
    }
    if (extractable && !key.extractable) {
      throw new TypeError("key must be extractable");
    }
  }
  constructor(_, algorithm, type, extractable, pq, t, seed, publicKey) {
    InvalidInvocation(_);
    this.#algorithm = algorithm;
    this.#type = type;
    this.#extractable = extractable;
    this.#pq = pq;
    this.#t = t;
    this.#seed = seed;
    this.#publicKey = publicKey;
  }
  get algorithm() {
    return { name: this.#algorithm.name };
  }
  get extractable() {
    return this.#extractable;
  }
  get type() {
    return this.#type;
  }
  getPublicKey(_) {
    InvalidInvocation(_);
    return this.#publicKey;
  }
  getSeed(_) {
    InvalidInvocation(_);
    return slice(this.#seed);
  }
  getT(_) {
    InvalidInvocation(_);
    return this.#t;
  }
  getPq(_) {
    InvalidInvocation(_);
    return this.#pq;
  }
}
function split(N1, N2, x) {
  if (x.byteLength !== N1 + N2) {
    throw new Error("x.byteLength !== N1 + N2");
  }
  const x1 = slice(x, 0, N1);
  const x2 = slice(x, -N2);
  return [x1, x2];
}
async function expandDecapsKeyG(kem, seed) {
  const Nout = kem.pq.Nseed + kem.t.Nseed;
  const bits = Nout << 3;
  const algorithm = { name: "cSHAKE256", length: bits, outputLength: bits };
  const seed_full = await subtle((c) => c.digest(algorithm, seed), kem.name);
  const [seed_PQ, seed_T] = split(kem.pq.Nseed, kem.t.Nseed, new Uint8Array(seed_full));
  const format = "raw-seed";
  const usages = ["decapsulateBits", "encapsulateBits"];
  const dk_PQ = await subtle((c) => c.importKey(format, seed_PQ, kem.pq.algorithm, true, [usages[0]]), kem.name);
  const ek_PQ = await getPublicKey(kem.name, dk_PQ, [usages[1]]);
  const sk = kem.t.RandomScalar?.(seed_T) ?? seed_T;
  const { privateKey: dk_T, publicKey: ek_T } = await kem.t.GetKeyPair(sk);
  return { ek_PQ, ek_T, dk_PQ, dk_T };
}
async function C2PRICombiner(kem, ss_PQ, ss_T, ct_T, _ek_T, label) {
  const ek_T = new Uint8Array(await subtle((c) => c.exportKey("raw", _ek_T), kem.name));
  const data = concat(ss_PQ, ss_T, ct_T, ek_T, label);
  return new Uint8Array(await subtle((c) => c.digest("SHA3-256", data), kem.name));
}
async function prepareEncapsG(kem, ek_PQ, ek_T) {
  const res = await subtle((c) => c.encapsulateBits(kem.pq.algorithm, ek_PQ), kem.name);
  const ss_PQ = new Uint8Array(res.sharedKey);
  const ct_PQ = new Uint8Array(res.ciphertext);
  const { privateKey: sk_E, publicKey } = await subtle((c) => c.generateKey(kem.t.algorithm, true, ["deriveBits"]), kem.name);
  const ct_T = new Uint8Array(await subtle((c) => c.exportKey("raw", publicKey), kem.name));
  const ss_T = new Uint8Array(await subtle((c) => c.deriveBits({ name: kem.t.algorithm.name, public: ek_T }, sk_E, kem.t.Nss << 3), kem.name));
  return [ss_PQ, ss_T, ct_PQ, ct_T];
}
async function prepareDecapsG(kem, dk_PQ, dk_T, ct_PQ, ct_T) {
  const ss_PQ = new Uint8Array(await subtle((c) => c.decapsulateBits(kem.pq.algorithm, dk_PQ, ct_PQ), kem.name));
  const pub = await subtle((c) => c.importKey("raw", ct_T, kem.t.algorithm, true, []), kem.name);
  const ss_T = new Uint8Array(await subtle((c) => c.deriveBits({ name: kem.t.algorithm.name, public: pub }, dk_T, kem.t.Nss << 3), kem.name));
  return [ss_PQ, ss_T];
}
function COMPOSITE_HYBRID_KEM_SHARED() {
  Object.freeze(HybridKey.prototype);
  return {
    async DeriveKeyPair(ikm, extractable) {
      const seed = await LabeledDerive(this.kdf, this.suite_id, ikm, L_DeriveKeyPair, new Uint8Array, 32);
      const { ek_PQ, ek_T, dk_PQ, dk_T } = await expandDecapsKeyG(this, seed);
      const publicKey = new HybridKey(priv, this.algorithm, "public", true, ek_PQ, ek_T);
      const privateKey = new HybridKey(priv, this.algorithm, "private", extractable, dk_PQ, dk_T, seed, publicKey);
      return { privateKey, publicKey };
    },
    async GenerateKeyPair(extractable) {
      return await this.DeriveKeyPair(crypto.getRandomValues(new Uint8Array(32)), extractable);
    },
    async SerializePublicKey(key) {
      assertKeyAlgorithm(key, this.algorithm);
      HybridKey.validate(key, true);
      const format = "raw-public";
      const ek_PQ = new Uint8Array(await subtle((c) => c.exportKey(format, key.getPq(priv)), this.name));
      const ek_T = new Uint8Array(await subtle((c) => c.exportKey("raw", key.getT(priv)), this.name));
      return concat(ek_PQ, ek_T);
    },
    async DeserializePublicKey(key) {
      const format = "raw-public";
      const usages = ["encapsulateBits"];
      const pubPq = key.subarray(0, this.pq.Npk);
      const pubT = key.subarray(this.pq.Npk);
      const [ek_PQ, ek_T] = await Promise.all([
        subtle((c) => c.importKey(format, pubPq, this.pq.algorithm, true, usages), this.name),
        subtle((c) => c.importKey("raw", pubT, this.t.algorithm, true, []), this.name)
      ]);
      return new HybridKey(priv, this.algorithm, "public", true, ek_PQ, ek_T);
    },
    async SerializePrivateKey(key) {
      assertKeyAlgorithm(key, this.algorithm);
      HybridKey.validate(key, true);
      return key.getSeed(priv);
    },
    async DeserializePrivateKey(key, extractable) {
      const seed = slice(key);
      const { ek_PQ, ek_T, dk_PQ, dk_T } = await expandDecapsKeyG(this, seed);
      const publicKey = new HybridKey(priv, this.algorithm, "public", true, ek_PQ, ek_T);
      const privateKey = new HybridKey(priv, this.algorithm, "private", extractable, dk_PQ, dk_T, seed, publicKey);
      return privateKey;
    },
    async Encap(pkR) {
      assertKeyAlgorithm(pkR, this.algorithm);
      HybridKey.validate(pkR);
      const ek_PQ = pkR.getPq(priv);
      const ek_T = pkR.getT(priv);
      const [ss_PQ, ss_T, ct_PQ, ct_T] = await prepareEncapsG(this, ek_PQ, ek_T);
      const ss_H = await C2PRICombiner(this, ss_PQ, ss_T, ct_T, ek_T, this.label);
      const ct_H = concat(ct_PQ, ct_T);
      return { shared_secret: ss_H, enc: ct_H };
    },
    async Decap(enc, skR, pkR) {
      assertKeyAlgorithm(skR, this.algorithm);
      HybridKey.validate(skR);
      if (pkR) {
        assertKeyAlgorithm(pkR, this.algorithm);
        HybridKey.validate(pkR);
      }
      const [ct_PQ, ct_T] = split(this.pq.Nct, this.t.Nct, enc);
      const ek = pkR ?? skR.getPublicKey(priv);
      const ek_T = ek.getT(priv);
      const dk_PQ = skR.getPq(priv);
      const dk_T = skR.getT(priv);
      const [ss_PQ, ss_T] = await prepareDecapsG(this, dk_PQ, dk_T, ct_PQ, ct_T);
      const ss_H = await C2PRICombiner(this, ss_PQ, ss_T, ct_T, ek_T, this.label);
      return ss_H;
    }
  };
}
function createCompositeHybridKEM(parameters) {
  const kdf = KDF_SHAKE256();
  kdf.name = parameters.name;
  return {
    ...parameters,
    suite_id: concat(L_KEM, I2OSP(parameters.id, 2)),
    type: "KEM",
    algorithm: { name: parameters.name },
    kdf,
    ...COMPOSITE_HYBRID_KEM_SHARED()
  };
}
var KEM_MLKEM768_X25519 = function() {
  const id = 25722;
  const name = "MLKEM768-X25519";
  const Nsecret = 32;
  const Nenc = 1120;
  const Npk = 1216;
  const Nsk = 32;
  const kem = { id, name, Nsecret, Nenc, Npk, Nsk };
  if (SubtleCrypto.supports?.("generateKey", name) ?? false) {
    return createDirectKEM(kem);
  }
  const pkcs8 = Uint8Array.of(48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32);
  return createCompositeHybridKEM({
    ...kem,
    pq: { algorithm: { name: "ML-KEM-768" }, Nseed: 64, Npk: 1184, Nct: 1088 },
    t: {
      algorithm: { name: "X25519" },
      Nseed: 32,
      Npk: 32,
      Nss: 32,
      Nsk: 32,
      Nct: 32,
      async GetKeyPair(sk) {
        const privateKey = await CurveKeyFromD(name, this.Nsk, pkcs8, this.algorithm, sk, true);
        const publicKey = await getPublicKey(name, privateKey, []);
        return { privateKey, publicKey };
      }
    },
    label: Uint8Array.of(92, 46, 47, 47, 94, 92)
  });
};

// ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split2(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0;i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === undefined || value.length === length))
    return value;
  if (length !== undefined)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== undefined ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, undefined, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0;i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : undefined;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== undefined)
    aopts(opts, title);
  const merged = Object.assign(Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes2(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha3.js
var _0n = BigInt(0);
var _1n = BigInt(1);
var _2n = BigInt(2);
var _7n = BigInt(7);
var _256n = BigInt(256);
var _0x71n = BigInt(113);
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0;round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0;j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n)
      t ^= _1n << (_1n << BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split2(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
var B = new Uint32Array(5 * 2);
function keccakP(s, rounds = 24) {
  if (!(s instanceof Uint32Array))
    throw new TypeError('"s" expected Uint32Array(50), got type=' + typeof s);
  if (s.length !== 50)
    throw new RangeError('"s" expected Uint32Array(50), got length=' + s.length);
  anumber(rounds, "rounds");
  if (rounds < 1 || rounds > 24)
    throw new Error('"rounds" expected integer 1..24');
  for (let round = 24 - rounds;round < 24; round++) {
    for (let x = 0;x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0;x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0;y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0;t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0;y < 50; y += 10) {
      const b0 = s[y], b1 = s[y + 1], b2 = s[y + 2], b3 = s[y + 3];
      s[y] ^= ~s[y + 2] & s[y + 4];
      s[y + 1] ^= ~s[y + 3] & s[y + 5];
      s[y + 2] ^= ~s[y + 4] & s[y + 6];
      s[y + 3] ^= ~s[y + 5] & s[y + 7];
      s[y + 4] ^= ~s[y + 6] & s[y + 8];
      s[y + 5] ^= ~s[y + 7] & s[y + 9];
      s[y + 6] ^= ~s[y + 8] & b0;
      s[y + 7] ^= ~s[y + 9] & b1;
      s[y + 8] ^= ~b0 & b2;
      s[y + 9] ^= ~b1 & b3;
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}

class Keccak {
  state;
  pos = 0;
  posOut = 0;
  finished = false;
  state32;
  destroyed = false;
  blockLen;
  suffix;
  outputLen;
  canXOF;
  enableXOF = false;
  rounds;
  constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
    anumber(blockLen, "blockLen");
    anumber(suffix, "suffix");
    anumber(rounds, "rounds");
    abool(enableXOF, "enableXOF");
    this.blockLen = blockLen;
    this.suffix = suffix;
    this.outputLen = outputLen;
    this.enableXOF = enableXOF;
    this.canXOF = enableXOF;
    this.rounds = rounds;
    anumber(outputLen, "outputLen");
    if (!(0 < blockLen && blockLen < 200))
      throw new Error('"blockLen" must be 1..199');
    this.state = new Uint8Array(200);
    this.state32 = u32(this.state);
  }
  clone() {
    return this._cloneInto();
  }
  keccak() {
    swap32IfBE(this.state32);
    keccakP(this.state32, this.rounds);
    swap32IfBE(this.state32);
    this.posOut = 0;
    this.pos = 0;
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { blockLen, state, state32 } = this;
    const len = data.length;
    const canUseU32 = blockLen % 4 === 0 && data.byteOffset % 4 === 0;
    const blockLen32 = blockLen / 4;
    const data32 = canUseU32 && len >= blockLen ? u32(data) : undefined;
    for (let pos = 0;pos < len; ) {
      if (data32 !== undefined && this.pos === 0 && pos % 4 === 0 && len - pos >= blockLen) {
        for (let i = 0, o = pos / 4;i < blockLen32; i++)
          state32[i] ^= data32[o + i];
        pos += blockLen;
        this.pos = blockLen;
        this.keccak();
        continue;
      }
      const take = Math.min(blockLen - this.pos, len - pos);
      for (let i = 0;i < take; i++)
        state[this.pos++] ^= data[pos++];
      if (this.pos === blockLen)
        this.keccak();
    }
    return this;
  }
  finish() {
    if (this.finished)
      return;
    this.finished = true;
    const { state, suffix, pos, blockLen } = this;
    state[pos] ^= suffix;
    if ((suffix & 128) !== 0 && pos === blockLen - 1)
      this.keccak();
    state[blockLen - 1] ^= 128;
    this.keccak();
  }
  writeInto(out) {
    aexists(this, false);
    abytes(out);
    this.finish();
    const bufferOut = this.state;
    const { blockLen } = this;
    for (let pos = 0, len = out.length;pos < len; ) {
      if (this.posOut >= blockLen)
        this.keccak();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF)
      throw new Error("XOF is not enabled");
    return this.writeInto(out);
  }
  xof(bytes) {
    anumber(bytes);
    return this.xofInto(new Uint8Array(bytes));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished)
      throw new Error("digest() was already called");
    this.writeInto(out.length === this.outputLen ? out : out.subarray(0, this.outputLen));
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.outputLen);
    this.digestInto(out);
    return out;
  }
  destroy() {
    this.destroyed = true;
    clean(this.state);
  }
  _cloneInto(to) {
    const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
    to ||= new Keccak(blockLen, suffix, outputLen, enableXOF, rounds);
    to.blockLen = blockLen;
    to.state32.set(this.state32);
    to.pos = this.pos;
    to.posOut = this.posOut;
    to.finished = this.finished;
    to.rounds = rounds;
    to.suffix = suffix;
    to.outputLen = outputLen;
    to.enableXOF = enableXOF;
    to.canXOF = this.canXOF;
    to.destroyed = this.destroyed;
    return to;
  }
}
var genKeccak = (suffix, blockLen, outputLen, info = {}) => createHasher(() => new Keccak(blockLen, suffix, outputLen), info);
var sha3_256 = /* @__PURE__ */ genKeccak(6, 136, 32, /* @__PURE__ */ oidNist(8));
var sha3_512 = /* @__PURE__ */ genKeccak(6, 72, 64, /* @__PURE__ */ oidNist(10));
var genShake = (suffix, blockLen, outputLen, info = {}) => createHasher((opts = {}) => {
  opts = checkOpts({}, opts);
  return new Keccak(blockLen, suffix, opts.dkLen === undefined ? outputLen : opts.dkLen, true);
}, info);
var shake128 = /* @__PURE__ */ genShake(31, 168, 16, /* @__PURE__ */ oidNist(11));
var shake256 = /* @__PURE__ */ genShake(31, 136, 32, /* @__PURE__ */ oidNist(12));

// ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
class HashMD {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var K512 = /* @__PURE__ */ (() => split2([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);

class SHA2_64B extends HashMD {
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16;i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0;i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}

class _SHA512 extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
}
var sha512 = /* @__PURE__ */ createHasher(() => new _SHA512, /* @__PURE__ */ oidNist(3));

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function aarray(item, title, inner = () => {}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0;i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var concatBytes3 = (...arrays) => concatBytes2(...arrays);
var hexToBytes2 = (hex) => hexToBytes(hex);
var isBytes2 = isBytes;
var randomBytes3 = (bytesLength) => randomBytes2(bytesLength);
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool2(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  return hex === "" ? _0n2 : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex = n.toString(16);
  if (hex.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function asciiToBytes(ascii) {
  if (typeof ascii !== "string")
    throw new TypeError("ascii string expected, got " + typeof ascii);
  return Uint8Array.from(ascii, (c, i) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new RangeError(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    }
    return charCode;
  });
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n2 <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n2)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n2 ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n2 << BigInt(n)) - _1n2;
};
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== undefined : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n2 = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n3)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n3 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n3)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n3)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n3)
    return _1n3;
  if (power === _1n3)
    return num;
  let d = num % modulo;
  if (d < _0n3)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p = _1n3;
    while (power > _0n3) {
      if (power & _1n3)
        p = p * d % modulo;
      d = d * d % modulo;
      power >>= _1n3;
    }
    return p;
  }
  const digits = [];
  while (power > _0n3) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n3;
  table[1] = d;
  for (let i = 2;i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2;w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n3)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n3)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n3) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n3)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n3)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n3, u = _1n3;
  while (a !== _0n3) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n3)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n3) === _0n3)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n3) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n2);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n2), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n2) / _16n;
  return (Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n3;
  let S = 0;
  while (Q % _2n2 === _0n3) {
    Q /= _2n2;
    S++;
  }
  let Z = _2n2;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n3) / _2n2;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n3 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n3) === _1n3;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n3)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool2(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n3) / _2n2;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber2(nBitLength);
  if (n <= _0n3)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== undefined && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== undefined && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== undefined ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = new WeakMap;

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n3;
  ONE = _1n3;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n3)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = undefined;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n3 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n3;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n3) === _1n3;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  cmov(a, b, condition) {
    abool2(condition, "condition");
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/abstract/fft.js
function checkU32(n, title = "n") {
  if (typeof n !== "number")
    throw new TypeError(`wrong u32 integer "${title}": expected number, got type=${typeof n}`);
  if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295)
    throw new RangeError(`wrong u32 integer "${title}": expected 0..4294967295, got ${n}`);
  return n;
}
function isPowerOfTwo(x) {
  checkU32(x, "x");
  return (x & x - 1) === 0 && x !== 0;
}
function reverseBits(n, bits) {
  checkU32(n);
  if (typeof bits !== "number")
    throw new TypeError('"bits" expected number, got type=' + typeof bits);
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 32)
    throw new Error(`expected integer 0 <= bits <= 32, got ${bits}`);
  let reversed = 0;
  for (let i = 0;i < bits; i++, n >>>= 1)
    reversed = reversed << 1 | n & 1;
  return reversed >>> 0;
}
function log2(n) {
  checkU32(n);
  return 31 - Math.clz32(n);
}
function bitReversalInplace(values) {
  if (!values || typeof values !== "object" || typeof values.length !== "number")
    throw new TypeError('"values" expected array-like, got type=' + typeof values);
  const n = values.length;
  if (!isPowerOfTwo(n))
    throw new Error("expected positive power-of-two length, got " + n);
  const bits = log2(n);
  for (let i = 0;i < n; i++) {
    const j = reverseBits(i, bits);
    if (i < j) {
      const tmp = values[i];
      values[i] = values[j];
      values[j] = tmp;
    }
  }
  return values;
}
var FFTCore = (F, coreOpts) => {
  validateObject(coreOpts, { N: "number", roots: "object", dit: "boolean" }, { invertButterflies: "boolean", skipStages: "number", brp: "boolean" }, "coreOpts");
  const { N, roots, dit, invertButterflies = false, skipStages = 0, brp = true } = coreOpts;
  checkU32(N, "coreOpts.N");
  const bits = log2(N);
  if (!isPowerOfTwo(N))
    throw new Error("FFT: Polynomial size should be power of two");
  checkU32(skipStages, "coreOpts.skipStages");
  const maxSkipStages = bits === 0 ? 0 : bits - 1;
  if (skipStages > maxSkipStages)
    throw new Error(`FFT: wrong skipStages: expected 0 <= skipStages <= ${maxSkipStages}`);
  if (roots.length !== N)
    throw new Error(`FFT: wrong roots length: expected ${N}, got ${roots.length}`);
  const isDit = dit !== invertButterflies;
  return (values) => {
    if (values.length !== N)
      throw new Error("FFT: wrong Polynomial length");
    if (dit && brp)
      bitReversalInplace(values);
    for (let i = 0, g = 1;i < bits - skipStages; i++) {
      const s = dit ? i + 1 + skipStages : bits - i;
      const m = 1 << s;
      const m2 = m >> 1;
      const stride = N >> s;
      for (let k = 0;k < N; k += m) {
        for (let j = 0, grp = g++;j < m2; j++) {
          const rootPos = invertButterflies ? dit ? N - grp : grp : j * stride;
          const i0 = k + j;
          const i1 = k + j + m2;
          const omega = roots[rootPos];
          const b = values[i1];
          const a = values[i0];
          if (isDit) {
            const t = F.mul(b, omega);
            values[i0] = F.add(a, t);
            values[i1] = F.sub(a, t);
          } else if (invertButterflies) {
            values[i0] = F.add(b, a);
            values[i1] = F.mul(F.sub(b, a), omega);
          } else {
            values[i0] = F.add(a, b);
            values[i1] = F.mul(F.sub(a, b), omega);
          }
        }
      }
    }
    if (!dit && brp)
      bitReversalInplace(values);
    return values;
  };
};

// ../../node_modules/.bun/@noble+post-quantum@0.7.1/node_modules/@noble/post-quantum/utils.js
/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
var abytesDoc = abytes;
var randomBytes4 = randomBytes2;
function aarray2(item, title, inner = () => {}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0;i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
function aobject3(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function equalBytes2(a, b) {
  a = abytes(a);
  b = abytes(b);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes2(bytes) {
  return new Uint8Array(abytes(bytes));
}
function splitCoder(label, ...lengths) {
  const getLength = (c) => typeof c === "number" ? c : c.bytesLen;
  const bytesLen = lengths.reduce((sum, a) => sum + getLength(a), 0);
  return {
    bytesLen,
    encode: (bufs) => {
      const res = new Uint8Array(bytesLen);
      for (let i = 0, pos = 0;i < lengths.length; i++) {
        const c = lengths[i];
        const l = getLength(c);
        const b = typeof c === "number" ? bufs[i] : c.encode(bufs[i]);
        abytes(b, l, label);
        res.set(b, pos);
        if (typeof c !== "number")
          b.fill(0);
        pos += l;
      }
      return res;
    },
    decode: (buf) => {
      abytes(buf, bytesLen, label);
      const res = [];
      for (const c of lengths) {
        const l = getLength(c);
        const b = buf.subarray(0, l);
        res.push(typeof c === "number" ? b : c.decode(b));
        buf = buf.subarray(l);
      }
      return res;
    }
  };
}
function vecCoder(c, vecLen) {
  const coder = c;
  const bytesLen = vecLen * coder.bytesLen;
  return {
    bytesLen,
    encode: (u) => {
      const uArr = aarray2(u, "u");
      if (uArr.length !== vecLen)
        throw new RangeError(`vecCoder.encode: wrong length=${uArr.length}. Expected: ${vecLen}`);
      const res = new Uint8Array(bytesLen);
      for (let i = 0, pos = 0;i < uArr.length; i++) {
        const b = coder.encode(uArr[i]);
        res.set(b, pos);
        b.fill(0);
        pos += b.length;
      }
      return res;
    },
    decode: (a) => {
      abytes(a, bytesLen);
      const r = [];
      for (let i = 0;i < a.length; i += coder.bytesLen)
        r.push(coder.decode(a.subarray(i, i + coder.bytesLen)));
      return r;
    }
  };
}
function cleanBytes(...list) {
  for (const t of list) {
    if (Array.isArray(t))
      for (const b of t)
        b.fill(0);
    else
      t.fill(0);
  }
}
function getMask(bits) {
  anumber(bits, "bits");
  if (bits > 32)
    throw new RangeError('"bits" expected <= 32, got ' + bits);
  return bits === 32 ? 4294967295 : ~(-1 << bits) >>> 0;
}

// ../../node_modules/.bun/@noble+post-quantum@0.7.1/node_modules/@noble/post-quantum/_crystals.js
/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
var genCrystals = (opts) => {
  const { newPoly, N, Q, F, ROOT_OF_UNITY, brvBits, isKyber } = opts;
  const mod = (a, modulo = Q) => {
    const result = a % modulo | 0;
    return (result >= 0 ? result | 0 : modulo + result | 0) | 0;
  };
  const smod = (a, modulo = Q) => {
    const r = mod(a, modulo) | 0;
    return (r > modulo >> 1 ? r - modulo | 0 : r) | 0;
  };
  function getZettas() {
    const out = newPoly(N);
    for (let i = 0;i < N; i++) {
      const b = reverseBits(i, brvBits);
      const p = BigInt(ROOT_OF_UNITY) ** BigInt(b) % BigInt(Q);
      out[i] = Number(p) | 0;
    }
    return out;
  }
  const nttZetas = getZettas();
  const inv = (_a) => {
    throw new Error("not implemented");
  };
  const field = isKyber ? {
    add: (a, b) => {
      const r = a + b | 0;
      return r >= Q ? r - Q | 0 : r;
    },
    sub: (a, b) => {
      const r = a - b | 0;
      return r < 0 ? r + Q | 0 : r;
    },
    mul: (a, b) => mod((a | 0) * (b | 0)) | 0,
    inv
  } : {
    add: (a, b) => mod((a | 0) + (b | 0)) | 0,
    sub: (a, b) => mod((a | 0) - (b | 0)) | 0,
    mul: (a, b) => mod((a | 0) * (b | 0)) | 0,
    inv
  };
  const nttOpts = {
    N,
    roots: nttZetas,
    invertButterflies: true,
    skipStages: isKyber ? 1 : 0,
    brp: false
  };
  const dif = FFTCore(field, { dit: false, ...nttOpts });
  const dit = FFTCore(field, { dit: true, ...nttOpts });
  const NTT = {
    encode: (r) => {
      return dif(r);
    },
    decode: (r) => {
      dit(r);
      for (let i = 0;i < r.length; i++)
        r[i] = mod(F * r[i]);
      return r;
    }
  };
  const bitsCoder = (d, c) => {
    for (let i = 0, bufLen = 0;i < N; i++) {
      bufLen += d;
      if (bufLen > 32)
        getMask(bufLen);
      bufLen %= 8;
    }
    const mask = getMask(d);
    const bytesLen = d * (N / 8);
    return {
      bytesLen,
      encode: (poly_) => {
        const poly = poly_;
        const r = new Uint8Array(bytesLen);
        for (let i = 0, buf = 0, bufLen = 0, pos = 0;i < poly.length; i++) {
          buf |= (c.encode(poly[i]) & mask) << bufLen;
          bufLen += d;
          for (;bufLen >= 8; bufLen -= 8, buf >>= 8)
            r[pos++] = buf & 255;
        }
        return r;
      },
      decode: (bytes) => {
        const r = newPoly(N);
        for (let i = 0, buf = 0, bufLen = 0, pos = 0;i < bytes.length; i++) {
          buf |= bytes[i] << bufLen;
          bufLen += 8;
          for (;bufLen >= d; bufLen -= d, buf >>= d)
            r[pos++] = c.decode(buf & mask);
        }
        return r;
      }
    };
  };
  return {
    mod,
    smod,
    nttZetas,
    NTT: {
      encode: (r) => NTT.encode(r),
      decode: (r) => NTT.decode(r)
    },
    bitsCoder
  };
};
var createXofShake = (shake) => (seed, blockLen) => {
  if (!blockLen)
    blockLen = shake.blockLen;
  const _seed = new Uint8Array(seed.length + 2);
  _seed.set(seed);
  const seedLen = seed.length;
  const buf = new Uint8Array(blockLen);
  let h = shake.create({});
  let calls = 0;
  let xofs = 0;
  return {
    stats: () => ({ calls, xofs }),
    get: (x, y) => {
      _seed[seedLen + 0] = x;
      _seed[seedLen + 1] = y;
      h.destroy();
      h = shake.create({}).update(_seed);
      calls++;
      return () => {
        xofs++;
        return h.xofInto(buf);
      };
    },
    clean: () => {
      h.destroy();
      cleanBytes(buf, _seed);
    }
  };
};
var XOF128 = /* @__PURE__ */ createXofShake(shake128);

// ../../node_modules/.bun/@noble+post-quantum@0.7.1/node_modules/@noble/post-quantum/ml-kem.js
/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
var N = 256;
var Q = 3329;
var F = 3303;
var ROOT_OF_UNITY = 17;
var crystals = /* @__PURE__ */ genCrystals({
  N,
  Q,
  F,
  ROOT_OF_UNITY,
  newPoly: (n) => new Uint16Array(n),
  brvBits: 7,
  isKyber: true
});
var PARAMS = /* @__PURE__ */ (() => Object.freeze({
  512: Object.freeze({ N, Q, K: 2, ETA1: 3, ETA2: 2, du: 10, dv: 4, RBGstrength: 128 }),
  768: Object.freeze({ N, Q, K: 3, ETA1: 2, ETA2: 2, du: 10, dv: 4, RBGstrength: 192 }),
  1024: Object.freeze({ N, Q, K: 4, ETA1: 2, ETA2: 2, du: 11, dv: 5, RBGstrength: 256 })
}))();
var compress = (d) => {
  if (d >= 12)
    return { encode: (i) => i, decode: (i) => i >= Q ? i - Q : i };
  const a = 2 ** (d - 1);
  return {
    encode: (i) => ((i << d) + Q / 2) / Q,
    decode: (i) => i * Q + a >>> d
  };
};
var byteCoder = (d) => crystals.bitsCoder(d, d === 12 ? { encode: (i) => i, decode: (i) => i >= Q ? i - Q : i } : { encode: (i) => i, decode: (i) => i });
var polyCoder = (d) => d === 12 ? byteCoder(12) : crystals.bitsCoder(d, compress(d));
function polyAdd(a_, b_) {
  const a = a_;
  const b = b_;
  for (let i = 0;i < N; i++) {
    const r = a[i] + b[i];
    a[i] = r >= Q ? r - Q : r;
  }
}
function polySub(a_, b_) {
  const a = a_;
  const b = b_;
  for (let i = 0;i < N; i++) {
    const r = a[i] - b[i];
    a[i] = r < 0 ? r + Q : r;
  }
}
function BaseCaseMultiply(a0, a1, b0, b1, zeta) {
  const c0 = crystals.mod(crystals.mod(a1 * b1) * zeta + a0 * b0);
  const c1 = crystals.mod(a0 * b1 + a1 * b0);
  return { c0, c1 };
}
function MultiplyNTTs(f_, g_) {
  const f = f_;
  const g = g_;
  for (let i = 0;i < N / 2; i++) {
    let z = crystals.nttZetas[64 + (i >> 1)];
    if (i & 1)
      z = -z;
    const { c0, c1 } = BaseCaseMultiply(f[2 * i + 0], f[2 * i + 1], g[2 * i + 0], g[2 * i + 1], z);
    f[2 * i + 0] = c0;
    f[2 * i + 1] = c1;
  }
  return f;
}
function SampleNTT(xof_) {
  const xof = xof_;
  const r = new Uint16Array(N);
  for (let j = 0;j < N; ) {
    const b = xof();
    if (b.length % 3)
      throw new Error("SampleNTT: unaligned block");
    for (let i = 0;j < N && i + 3 <= b.length; i += 3) {
      const d1 = (b[i + 0] >> 0 | b[i + 1] << 8) & 4095;
      const d2 = (b[i + 1] >> 4 | b[i + 2] << 4) & 4095;
      if (d1 < Q)
        r[j++] = d1;
      if (j < N && d2 < Q)
        r[j++] = d2;
    }
  }
  return r;
}
var sampleCBDBytes = (buf, eta) => {
  const r = new Uint16Array(N);
  const b32 = u32(buf);
  swap32IfBE(b32);
  let len = 0;
  for (let i = 0, p = 0, bb = 0, t0 = 0;i < b32.length; i++) {
    let b = b32[i];
    for (let j = 0;j < 32; j++) {
      bb += b & 1;
      b >>= 1;
      len += 1;
      if (len === eta) {
        t0 = bb;
        bb = 0;
      } else if (len === 2 * eta) {
        r[p++] = crystals.mod(t0 - bb);
        bb = 0;
        len = 0;
      }
    }
  }
  swap32IfBE(b32);
  if (len)
    throw new Error(`sampleCBD: leftover bits: ${len}`);
  return r;
};
function sampleCBD(PRF_, seed, nonce, eta) {
  const PRF = PRF_;
  return sampleCBDBytes(PRF(eta * N / 4, seed, nonce), eta);
}
var genKPKE = (opts_) => {
  const opts = opts_;
  const { K, PRF, XOF, HASH512, ETA1, ETA2, du, dv } = opts;
  const poly1 = polyCoder(1);
  const polyV = polyCoder(dv);
  const polyU = polyCoder(du);
  const publicCoder = splitCoder("publicKey", vecCoder(polyCoder(12), K), 32);
  const secretCoder = vecCoder(polyCoder(12), K);
  const cipherCoder = splitCoder("ciphertext", vecCoder(polyU, K), polyV);
  const seedCoder = splitCoder("seed", 32, 32);
  const encryptCore = (tHat, getA, msg, seed) => {
    const rHat = [];
    for (let i = 0;i < K; i++)
      rHat.push(crystals.NTT.encode(sampleCBD(PRF, seed, i, ETA1)));
    const tmp2 = new Uint16Array(N);
    const u = [];
    for (let i = 0;i < K; i++) {
      const e1 = sampleCBD(PRF, seed, K + i, ETA2);
      const tmp = new Uint16Array(N);
      for (let j = 0;j < K; j++) {
        const aij = getA(i, j);
        polyAdd(tmp, MultiplyNTTs(aij, rHat[j]));
      }
      polyAdd(e1, crystals.NTT.decode(tmp));
      u.push(e1);
      polyAdd(tmp2, MultiplyNTTs(tHat[i], rHat[i]));
      cleanBytes(tmp);
    }
    const e2 = sampleCBD(PRF, seed, 2 * K, ETA2);
    polyAdd(e2, crystals.NTT.decode(tmp2));
    const v = poly1.decode(msg);
    polyAdd(v, e2);
    cleanBytes(tHat, rHat, tmp2, e2);
    return cipherCoder.encode([u, v]);
  };
  return {
    secretCoder,
    lengths: {
      secretKey: secretCoder.bytesLen,
      publicKey: publicCoder.bytesLen,
      cipherText: cipherCoder.bytesLen
    },
    keygen: (seed) => {
      abytesDoc(seed, 32, "seed");
      const seedDst = new Uint8Array(33);
      seedDst.set(seed);
      seedDst[32] = K;
      const seedHash = HASH512(seedDst);
      const [rho, sigma] = seedCoder.decode(seedHash);
      const sHat = [];
      const tHat = [];
      for (let i = 0;i < K; i++)
        sHat.push(crystals.NTT.encode(sampleCBD(PRF, sigma, i, ETA1)));
      const x = XOF(rho);
      for (let i = 0;i < K; i++) {
        const e = crystals.NTT.encode(sampleCBD(PRF, sigma, K + i, ETA1));
        for (let j = 0;j < K; j++) {
          const aji = SampleNTT(x.get(j, i));
          polyAdd(e, MultiplyNTTs(aji, sHat[j]));
        }
        tHat.push(e);
      }
      x.clean();
      const res = {
        publicKey: publicCoder.encode([tHat, rho]),
        secretKey: secretCoder.encode(sHat)
      };
      cleanBytes(rho, sigma, sHat, tHat, seedDst, seedHash);
      return res;
    },
    encrypt: (publicKey, msg, seed) => {
      const [tHat, rho] = publicCoder.decode(publicKey);
      const x = XOF(rho);
      const res = encryptCore(tHat, (i, j) => SampleNTT(x.get(i, j)), msg, seed);
      x.clean();
      return res;
    },
    prepare: (publicKey) => {
      const [tHat, rho] = publicCoder.decode(publicKey);
      const x = XOF(rho);
      const A = [];
      for (let i = 0;i < K; i++)
        for (let j = 0;j < K; j++)
          A.push(SampleNTT(x.get(i, j)));
      x.clean();
      return {
        encrypt: (msg, seed) => encryptCore(tHat.map((p) => p.slice()), (i, j) => A[i * K + j].slice(), msg, seed),
        clean: () => cleanBytes(tHat, A)
      };
    },
    decrypt: (cipherText, privateKey) => {
      const [u, v] = cipherCoder.decode(cipherText);
      const sk = secretCoder.decode(privateKey);
      const tmp = new Uint16Array(N);
      for (let i = 0;i < K; i++)
        polyAdd(tmp, MultiplyNTTs(sk[i], crystals.NTT.encode(u[i])));
      polySub(v, crystals.NTT.decode(tmp));
      const res = poly1.encode(v);
      cleanBytes(tmp, sk, u, v);
      return res;
    }
  };
};
function createKyber(opts) {
  const rawOpts = opts;
  const KPKE = genKPKE(rawOpts);
  const { HASH256, HASH512, KDF } = rawOpts;
  const { secretCoder: KPKESecretCoder, lengths } = KPKE;
  const secretCoder = splitCoder("secretKey", lengths.secretKey, lengths.publicKey, 32, 32);
  const msgLen = 32;
  const seedLen = 64;
  const validateModulus = (publicKey, fn) => {
    const eke = publicKey.subarray(0, 384 * rawOpts.K);
    const ek = KPKESecretCoder.encode(KPKESecretCoder.decode(copyBytes2(eke)));
    const ok = equalBytes2(ek, eke);
    cleanBytes(ek);
    if (!ok)
      throw new Error(`ML-KEM.${fn}: wrong publicKey modulus`);
  };
  const kemLengths = Object.freeze({
    ...lengths,
    seed: 64,
    msg: msgLen,
    msgRand: msgLen,
    secretKey: secretCoder.bytesLen
  });
  return Object.freeze({
    info: Object.freeze({ type: "ml-kem" }),
    lengths: kemLengths,
    keygen: (seed) => {
      const ownSeed = seed === undefined;
      const s = ownSeed ? randomBytes4(seedLen) : seed;
      let sk;
      let publicKeyHash;
      try {
        abytesDoc(s, seedLen, "seed");
        const keys = KPKE.keygen(s.subarray(0, 32));
        const publicKey = keys.publicKey;
        sk = keys.secretKey;
        publicKeyHash = HASH256(publicKey);
        const secretKey = secretCoder.encode([sk, publicKey, publicKeyHash, s.subarray(32)]);
        return {
          publicKey,
          secretKey
        };
      } finally {
        if (sk !== undefined)
          cleanBytes(sk);
        if (publicKeyHash !== undefined)
          cleanBytes(publicKeyHash);
        if (ownSeed)
          cleanBytes(s);
      }
    },
    getPublicKey: (secretKey) => {
      const [_sk, publicKey, _publicKeyHash, _z] = secretCoder.decode(secretKey);
      return Uint8Array.from(publicKey);
    },
    encapsulate: (publicKey, msg) => {
      const ownMsg = msg === undefined;
      const m = ownMsg ? randomBytes4(msgLen) : msg;
      let kr;
      try {
        abytesDoc(publicKey, lengths.publicKey, "publicKey");
        abytesDoc(m, msgLen, "message");
        validateModulus(publicKey, "encapsulate");
        kr = HASH512.create().update(m).update(HASH256(publicKey)).digest();
        const cipherText = KPKE.encrypt(publicKey, m, kr.subarray(32, 64));
        return {
          cipherText,
          sharedSecret: kr.subarray(0, 32)
        };
      } finally {
        if (kr !== undefined)
          cleanBytes(kr.subarray(32));
        if (ownMsg)
          cleanBytes(m);
      }
    },
    decapsulate: (cipherText, secretKey) => {
      abytesDoc(secretKey, secretCoder.bytesLen, "secretKey");
      abytesDoc(cipherText, lengths.cipherText, "cipherText");
      const k768 = secretCoder.bytesLen - 96;
      const start = k768 + 32;
      const test = HASH256(secretKey.subarray(k768 / 2, start));
      if (!equalBytes2(test, secretKey.subarray(start, start + 32)))
        throw new Error("invalid secretKey: hash check failed");
      const [sk, publicKey, publicKeyHash, z] = secretCoder.decode(secretKey);
      const msg = KPKE.decrypt(cipherText, sk);
      const kr = HASH512.create().update(msg).update(publicKeyHash).digest();
      const Khat = kr.subarray(0, 32);
      const cipherText2 = KPKE.encrypt(publicKey, msg, kr.subarray(32, 64));
      const isValid = equalBytes2(cipherText, cipherText2);
      const Kbar = KDF.create({ dkLen: 32 }).update(z).update(cipherText).digest();
      cleanBytes(msg, cipherText2, kr.subarray(32), !isValid ? Khat : Kbar);
      return isValid ? Khat : Kbar;
    },
    prepare: (publicKey) => {
      abytesDoc(publicKey, lengths.publicKey, "publicKey");
      validateModulus(publicKey, "prepare");
      const ek = copyBytes2(publicKey);
      const publicKeyHash = HASH256(ek);
      const cached = KPKE.prepare(ek);
      return Object.freeze({
        publicKey: ek,
        encapsulate: (msg) => {
          const ownMsg = msg === undefined;
          const m = ownMsg ? randomBytes4(msgLen) : msg;
          let kr;
          try {
            abytesDoc(m, msgLen, "message");
            kr = HASH512.create().update(m).update(publicKeyHash).digest();
            const cipherText = cached.encrypt(m, kr.subarray(32, 64));
            return {
              cipherText,
              sharedSecret: kr.subarray(0, 32)
            };
          } finally {
            if (kr !== undefined)
              cleanBytes(kr.subarray(32));
            if (ownMsg)
              cleanBytes(m);
          }
        },
        decapsulate: (cipherText, secretKey) => {
          abytesDoc(secretKey, secretCoder.bytesLen, "secretKey");
          abytesDoc(cipherText, lengths.cipherText, "cipherText");
          const [sk, ekEmbedded, storedHash, z] = secretCoder.decode(secretKey);
          if (!equalBytes2(ekEmbedded, ek) || !equalBytes2(storedHash, publicKeyHash))
            throw new Error("ML-KEM.decapsulate: secretKey does not match prepared publicKey");
          const msg = KPKE.decrypt(cipherText, sk);
          const kr = HASH512.create().update(msg).update(publicKeyHash).digest();
          const Khat = kr.subarray(0, 32);
          const cipherText2 = cached.encrypt(msg, kr.subarray(32, 64));
          const isValid = equalBytes2(cipherText, cipherText2);
          const Kbar = KDF.create({ dkLen: 32 }).update(z).update(cipherText).digest();
          cleanBytes(msg, cipherText2, kr.subarray(32), !isValid ? Khat : Kbar);
          return isValid ? Khat : Kbar;
        },
        clean: cached.clean
      });
    }
  });
}
function shakePRF(dkLen, key, nonce) {
  return shake256.create({ dkLen }).update(key).update(new Uint8Array([nonce])).digest();
}
var opts = /* @__PURE__ */ (() => ({
  HASH256: sha3_256,
  HASH512: sha3_512,
  KDF: shake256,
  XOF: XOF128,
  PRF: shakePRF
}))();
var mk = (params) => createKyber({
  ...opts,
  ...params
});
var ml_kem768 = /* @__PURE__ */ (() => mk(PARAMS[768]))();

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n4 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes, length) {
  if (randomBytes === undefined)
    return;
  afunction(randomBytes, "randomBytes");
  try {
    const probe = randomBytes(length);
    if (!isBytes2(probe) || probe.length !== length)
      return;
  } catch {
    return;
  }
  return randomBytes;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === undefined ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = new WeakMap;
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1;j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n4) {
    let w = 0;
    if (n & _1n4) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n4;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0;w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n4;
    }
    d.push(v);
  }
  if (n !== _0n4)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1;bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0;i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}

class ScalarMultiplier {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = new WeakMap;
  baseCanBeBlinded;
  bits;
  constructor(Point, randomBytes) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0;w < windows; w++) {
      let acc = base;
      for (let i = 0;i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0;w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1;i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n4, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === undefined)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1;i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window2 = windows - 1;window2 >= 0; window2--) {
      if (window2 !== windows - 1)
        for (let d = 0;d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window2 * W) & mask);
      let sel = table[0];
      for (let i = 1;i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === undefined)
      return false;
    if (cofactor === _1n4)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === undefined)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
}
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool2(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : undefined);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n4))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/abstract/edwards.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n5 = /* @__PURE__ */ BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
var _4n3 = /* @__PURE__ */ BigInt(4);
var _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp, CURVE, x, y) {
  const x2 = Fp.sqr(x);
  const y2 = Fp.sqr(y);
  const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
  const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  if (FpLegendre(Fp, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  const randomBytes = opts.randomBytes === undefined ? randomBytes3 : opts.randomBytes;
  const MASK = _2n3 << BigInt(Fp.BYTES * 8) - _1n5;
  function isOdd(n) {
    if (!Fp.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp.isOdd(n);
  }
  const uvRatio = opts.uvRatio === undefined ? (u, v) => {
    try {
      return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n5 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const mulA = Fp.eql(CURVE.a, Fp.neg(Fp.ONE)) ? (x) => Fp.neg(x) : Fp.eql(CURVE.a, Fp.ONE) ? (x) => x : (x) => Fp.mul(CURVE.a, x);
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n5 : _0n5;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE, Fp.mul(CURVE.Gx, CURVE.Gy));
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    T;
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, Fp.ONE, Fp.mul(x, y));
    }
    static fromBytes(bytes, zip215 = false) {
      const len = Fp.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point"));
      abool2(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n5, max);
      const y2 = Fp.sqr(y);
      const u = Fp.sub(y2, Fp.ONE);
      const v = Fp.sub(Fp.mulN(d, y2), a);
      let { isValid, value: x } = uvRatio(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = isOdd(x);
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = Fp.neg(x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(hex, zip215 = false) {
      return Point.fromBytes(hexToBytes2(hex), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n3);
      return this;
    }
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = Fp.sqr(X);
      const Y2 = Fp.sqr(Y);
      const Z2 = Fp.sqr(Z);
      const Z4 = Fp.sqr(Z2);
      const aX2 = Fp.mul(X2, a);
      const left = Fp.mul(Fp.add(aX2, Y2), Z2);
      const right = Fp.add(Z4, Fp.mul(d, Fp.mul(X2, Y2)));
      if (!Fp.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      const XY = Fp.mul(X, Y);
      const ZT = Fp.mul(Z, T);
      if (!Fp.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = Fp.mul(X1, Z2);
      const X2Z1 = Fp.mul(X2, Z1);
      const Y1Z2 = Fp.mul(Y1, Z2);
      const Y2Z1 = Fp.mul(Y2, Z1);
      return Fp.eql(X1Z2, X2Z1) && Fp.eql(Y1Z2, Y2Z1);
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(Fp.neg(this.X), this.Y, this.Z, Fp.neg(this.T));
    }
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = Fp.sqr(X1);
      const B = Fp.sqr(Y1);
      const C = Fp.mul(Fp.sqr(Z1), _2n3);
      const D = mulA(A);
      const x1y1 = Fp.addN(X1, Y1);
      const E = Fp.sub(Fp.subN(Fp.sqr(x1y1), A), B);
      const G = Fp.addN(D, B);
      const F = Fp.subN(G, C);
      const H = Fp.subN(D, B);
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    add(other) {
      aedpoint(other);
      const { d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = Fp.mul(X1, X2);
      const B = Fp.mul(Y1, Y2);
      const C = Fp.mul(Fp.mulN(T1, d), T2);
      const D = Fp.mul(Z1, Z2);
      const E = Fp.sub(Fp.subN(Fp.mulN(Fp.addN(X1, Y1), Fp.addN(X2, Y2)), A), B);
      const F = Fp.subN(D, C);
      const G = Fp.addN(D, C);
      const H = Fp.sub(B, mulA(A));
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    multiplyUnsafe(scalar) {
      if (!Fn.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n5)
        return Point.ZERO;
      if (this.is0() || scalar === _1n5)
        return this;
      return wnaf.mulUnsafe(this, scalar, normalize);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      return wnaf.mulUnsafe(this, CURVE.n).is0();
    }
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && typeof iz !== "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.create(_8n2) : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ONE };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n5)
        return this;
      if (cofactor === _2n3)
        return this.double();
      if (cofactor === _4n3)
        return this.double().double();
      if (cofactor === _8n2)
        return this.double().double().double();
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp.toBytes(y);
      bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}
function eddsa(Point, cHash, eddsaOpts = {}) {
  validatePointCons(Point);
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  const hash = cHash;
  const opts = eddsaOpts;
  validateObject(opts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    zip215: "boolean",
    mapToCurve: "function",
    toMontgomery: "function",
    toMontgomerySecret: "function"
  });
  const { prehash } = opts;
  const { BASE, Fp, Fn } = Point;
  const outputLen = hash.outputLen;
  const expectedLen = 2 * Fp.BYTES;
  if (outputLen !== undefined) {
    asafenumber(outputLen, "hash.outputLen");
    if (outputLen !== expectedLen)
      throw new Error(`hash.outputLen must be ${expectedLen}, got ${outputLen}`);
  }
  const randomBytes = opts.randomBytes === undefined ? randomBytes3 : opts.randomBytes;
  const toMontgomery = opts.toMontgomery;
  const toMontgomerySecret = opts.toMontgomerySecret;
  const adjustScalarBytes = opts.adjustScalarBytes === undefined ? (bytes) => bytes : opts.adjustScalarBytes;
  const domain = opts.domain === undefined ? (data, ctx, phflag) => {
    abool2(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  } : opts.domain;
  function modN_LE(hash) {
    return Fn.create(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    abytes2(key, lengths.secretKey, "secretKey");
    const hashed = abytes2(hash(key), 2 * len, "hashedSecretKey");
    const head = adjustScalarBytes(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(secretKey) {
    return getExtendedPublicKey(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes3(...msgs);
    return modN_LE(hash(domain(msg, abytes2(context, undefined, "context"), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    validateObject(options, {}, {}, "options");
    msg = copyBytes(abytes2(msg, undefined, "message"));
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn.create(r + k * scalar);
    if (!Fn.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes3(R, Fn.toBytes(s));
    return abytes2(rs, lengths.signature, "result");
  }
  const verifyOpts = {
    zip215: opts.zip215
  };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    validateObject(options);
    const { context } = options;
    const zip215 = options.zip215 === undefined ? !!verifyOpts.zip215 : options.zip215;
    const len = lengths.signature;
    sig = abytes2(sig, len, "signature");
    msg = abytes2(msg, undefined, "message");
    publicKey = abytes2(publicKey, lengths.publicKey, "publicKey");
    if (zip215 !== undefined)
      abool2(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point.fromBytes(publicKey, zip215);
      R = Point.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, r, publicKey, msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed) {
    seed = seed === undefined ? randomBytes(lengths.seed) : seed;
    return abytes2(seed, lengths.seed, "seed");
  }
  function isValidSecretKey(key) {
    return isBytes2(key) && key.length === lengths.secretKey;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point.fromBytes(key, zip215 === undefined ? verifyOpts.zip215 : zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    toMontgomery(publicKey) {
      if (toMontgomery === undefined)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomery(Point.fromBytes(publicKey));
    },
    toMontgomerySecret(secretKey) {
      if (toMontgomerySecret === undefined)
        throw new Error("Montgomery conversion is not supported for this curve");
      return toMontgomerySecret(secretKey);
    }
  };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey),
    getPublicKey,
    sign,
    verify,
    utils,
    Point,
    lengths
  });
}

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/abstract/montgomery.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n6 = /* @__PURE__ */ BigInt(0);
var _1n6 = /* @__PURE__ */ BigInt(1);
var _2n4 = /* @__PURE__ */ BigInt(2);
function cmask(P, swap) {
  return P + swap - (swap >> _1n6 << _1n6);
}
function cswap(P) {
  const offset = BigInt(6) * P;
  return (mask, x_2, x_3) => {
    const sum = x_2 + x_3;
    const d = offset + x_3 - x_2;
    const a = (d * mask + x_2) % P;
    return { x_2: a, x_3: sum - a };
  };
}
function validateOpts(curve) {
  validateObject(curve, {
    P: "bigint",
    type: "string",
    adjustScalarBytes: "function",
    powPminus2: "function"
  }, {
    randomBytes: "function",
    scalarMultBase: "function"
  });
  return Object.freeze({ ...curve });
}
function montgomery(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { P, type, adjustScalarBytes, powPminus2, randomBytes: rand } = CURVE;
  const mulBaseHook = CURVE.scalarMultBase;
  const is25519 = type === "x25519";
  if (!is25519 && type !== "x448")
    throw new Error("invalid type");
  const randomBytes_ = rand === undefined ? randomBytes3 : rand;
  const montgomeryBits = is25519 ? 255 : 448;
  const swap = cswap(P);
  const fieldLen = is25519 ? 32 : 56;
  const Gu = is25519 ? BigInt(9) : BigInt(5);
  const a24 = is25519 ? BigInt(121665) : BigInt(39081);
  const minScalar = is25519 ? _2n4 ** BigInt(254) : _2n4 ** BigInt(447);
  const maxAdded = is25519 ? BigInt(8) * (_2n4 ** BigInt(251) - _1n6) : BigInt(4) * (_2n4 ** BigInt(445) - _1n6);
  const maxScalar = minScalar + maxAdded + _1n6;
  const modP = (n) => mod(n, P);
  const GuBytes = encodeU(Gu);
  function encodeU(u) {
    return numberToBytesLE(modP(u), fieldLen);
  }
  function decodeU(u) {
    const _u = copyBytes(abytes2(u, fieldLen, "uCoordinate"));
    if (is25519)
      _u[31] &= 127;
    return modP(bytesToNumberLE(_u));
  }
  function decodeScalar(scalar) {
    return bytesToNumberLE(adjustScalarBytes(copyBytes(abytes2(scalar, fieldLen, "scalar"))));
  }
  const lowOrderU = new Set(is25519 ? [
    _0n6,
    _1n6,
    P - _1n6,
    BigInt("325606250916557431795983626356110631294008115727848805560023387167927233504"),
    BigInt("39382357235489614581723060781553021112529911719440698176882885853963445705823")
  ] : [_0n6, _1n6, P - _1n6]);
  function scalarMult(scalar, u) {
    const pointU = decodeU(u);
    if (lowOrderU.has(pointU))
      throw new Error("invalid private or public key received");
    const pu = montgomeryLadder(pointU, decodeScalar(scalar));
    if (pu === _0n6)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  function scalarMultBase(scalar) {
    if (mulBaseHook === undefined)
      return scalarMult(scalar, GuBytes);
    const k = decodeScalar(scalar);
    aInRange("scalar", k, minScalar, maxScalar);
    const pu = modP(mulBaseHook(k));
    if (pu === _0n6)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  const getPublicKey = scalarMultBase;
  const getSharedSecret = scalarMult;
  function montgomeryLadder(u, scalar) {
    aInRange("u", u, _0n6, P);
    aInRange("scalar", scalar, minScalar, maxScalar);
    const k = scalar;
    const x_1 = u;
    let x_2 = _1n6;
    let z_2 = _0n6;
    let x_3 = u;
    let z_3 = _1n6;
    const kx = k ^ k >> _1n6;
    for (let t = BigInt(montgomeryBits - 1);t >= _0n6; t--) {
      const mask = cmask(P, kx >> t);
      ({ x_2, x_3 } = swap(mask, x_2, x_3));
      ({ x_2: z_2, x_3: z_3 } = swap(mask, z_2, z_3));
      const A = x_2 + z_2;
      const AA = modP(A * A);
      const B = x_2 - z_2;
      const BB = modP(B * B);
      const E = AA - BB;
      const C = x_3 + z_3;
      const D = x_3 - z_3;
      const DA = modP(D * A);
      const CB = modP(C * B);
      const dacb = DA + CB;
      const da_cb = DA - CB;
      x_3 = modP(dacb * dacb);
      z_3 = modP(x_1 * modP(da_cb * da_cb));
      x_2 = modP(AA * BB);
      z_2 = modP(E * (AA + modP(a24 * E)));
    }
    const mask = cmask(P, k);
    ({ x_2, x_3 } = swap(mask, x_2, x_3));
    ({ x_2: z_2, x_3: z_3 } = swap(mask, z_2, z_3));
    const z2 = powPminus2(z_2);
    return modP(x_2 * z2);
  }
  const lengths = {
    secretKey: fieldLen,
    publicKey: fieldLen,
    seed: fieldLen
  };
  const randomSecretKey = (seed) => {
    seed = seed === undefined ? randomBytes_(fieldLen) : seed;
    abytes2(seed, lengths.seed, "seed");
    return seed;
  };
  const utils = { randomSecretKey };
  Object.freeze(lengths);
  Object.freeze(utils);
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, getPublicKey),
    getSharedSecret,
    getPublicKey,
    scalarMult,
    scalarMultBase,
    utils,
    GuBytes: GuBytes.slice(),
    lengths
  });
}

// ../../node_modules/.bun/@noble+curves@2.4.0/node_modules/@noble/curves/ed25519.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n7 = /* @__PURE__ */ BigInt(0);
var _1n7 = /* @__PURE__ */ BigInt(1);
var _2n5 = /* @__PURE__ */ BigInt(2);
var _3n2 = /* @__PURE__ */ BigInt(3);
var _5n2 = /* @__PURE__ */ BigInt(5);
var _8n3 = /* @__PURE__ */ BigInt(8);
var ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n5, P) * b2 % P;
  const b5 = pow2(b4, _1n7, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n5, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
var Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
function toMontgomery(point) {
  const { y } = point;
  return Fp.toBytes(Fp.div(_1n7 + y, _1n7 - y));
}
function toMontgomerySecret(secretKey) {
  const size = ed25519_Point.Fp.BYTES;
  abytes(secretKey, size);
  return adjustScalarBytes(sha512(secretKey.subarray(0, size))).subarray(0, size);
}
function ed(opts) {
  return eddsa(ed25519_Point, sha512, Object.assign({ adjustScalarBytes, toMontgomery, toMontgomerySecret, zip215: true }, opts));
}
var ed25519 = /* @__PURE__ */ ed({});
var x25519 = /* @__PURE__ */ (() => {
  const P = ed25519_CURVE_p;
  const powPminus2 = (x) => {
    const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
    return mod(pow2(pow_p_5_8, _3n2, P) * b2, P);
  };
  return montgomery({
    P,
    type: "x25519",
    powPminus2,
    adjustScalarBytes,
    scalarMultBase: (k) => {
      const kn = mod(k, ed25519_Point.Fn.ORDER);
      if (kn === _0n7)
        return _0n7;
      const p = ed25519_Point.BASE.multiply(kn);
      return mod((p.Z + p.Y) * powPminus2(mod(p.Z - p.Y, P)), P);
    }
  });
})();

// ../../node_modules/.bun/@noble+post-quantum@0.7.1/node_modules/@noble/post-quantum/hybrid.js
/*! noble-post-quantum - MIT License (c) 2024 Paul Miller (paulmillr.com) */
var validateKEM = (kem, title) => {
  const k = aobject3(kem, title);
  aobject3(k.lengths, `${title}.lengths`);
  afunction(k.keygen, `${title}.keygen`);
  afunction(k.getPublicKey, `${title}.getPublicKey`);
  afunction(k.encapsulate, `${title}.encapsulate`);
  afunction(k.decapsulate, `${title}.decapsulate`);
  return k;
};
function ecKeygen(curve, allowZeroKey = false) {
  const c = aobject3(curve, "curve");
  aobject3(c.lengths, "curve.lengths");
  afunction(c.keygen, "curve.keygen");
  afunction(c.getPublicKey, "curve.getPublicKey");
  abool2(allowZeroKey, "allowZeroKey");
  const lengths = curve.lengths;
  let keygen = curve.keygen;
  if (allowZeroKey) {
    if (!(("getSharedSecret" in curve) && ("sign" in curve) && ("verify" in curve)))
      throw new Error("allowZeroKey requires a Weierstrass curve");
    const wCurve = curve;
    const Fn = wCurve.Point.Fn;
    keygen = (seed = randomBytes4(lengths.seed)) => {
      abytes(seed, lengths.seed, "seed");
      const seedScalar = Fn.isLE ? bytesToNumberLE(seed) : bytesToNumberBE(seed);
      const secretKey = Fn.toBytes(Fn.create(seedScalar));
      return {
        secretKey,
        publicKey: curve.getPublicKey(secretKey)
      };
    };
  }
  return {
    lengths: { secretKey: lengths.secretKey, publicKey: lengths.publicKey, seed: lengths.seed },
    keygen: (seed) => keygen(seed),
    getPublicKey: (secretKey) => curve.getPublicKey(secretKey)
  };
}
function _ecdhKem(curve, allowZeroKey = false) {
  const kg = ecKeygen(curve, allowZeroKey);
  if (!curve.getSharedSecret)
    throw new Error("wrong curve");
  const decapsulate = (cipherText, secretKey) => {
    const res = curve.getSharedSecret(secretKey, cipherText);
    return curve.lengths.publicKeyHasPrefix ? res.subarray(1) : res;
  };
  return {
    lengths: { ...kg.lengths, msg: kg.lengths.seed, cipherText: kg.lengths.publicKey },
    keygen: kg.keygen,
    getPublicKey: kg.getPublicKey,
    encapsulate(publicKey, rand = randomBytes4(curve.lengths.seed)) {
      const seed = copyBytes2(rand);
      let ek = undefined;
      try {
        ek = kg.keygen(seed).secretKey;
        const sharedSecret = decapsulate(publicKey, ek);
        const cipherText = curve.getPublicKey(ek);
        return { sharedSecret, cipherText };
      } finally {
        cleanBytes(seed);
        if (ek)
          cleanBytes(ek);
      }
    },
    decapsulate
  };
}
function positiveLength(value, title) {
  const length = anumber(value, title);
  if (length === 0)
    throw new RangeError(`"${title}" expected integer greater than 0, got 0`);
  return length;
}
function splitLengths(lst, name) {
  const coder = splitCoder(name, ...lst.map((i) => {
    if (typeof i.lengths[name] !== "number")
      throw new Error("wrong length: " + name);
    return positiveLength(i.lengths[name], name);
  }));
  positiveLength(coder.bytesLen, name);
  return coder;
}
function expandSeedXof(xof) {
  return (seed, seedLen) => xof(seed, { dkLen: seedLen });
}
function combineKeys(realSeedLen, expandSeed_, ...ck_) {
  const expandSeed = expandSeed_;
  const ck = ck_;
  const seedCoder = splitLengths(ck, "seed");
  const pkCoder = splitLengths(ck, "publicKey");
  const rootSeedLen = positiveLength(realSeedLen === undefined ? seedCoder.bytesLen : realSeedLen, "realSeedLen");
  function expandDecapsulationKey(seed) {
    abytes(seed, rootSeedLen);
    const expandedRaw = expandSeed(seed, seedCoder.bytesLen);
    const expandedSeed = expandedRaw.buffer === seed.buffer ? copyBytes2(expandedRaw) : expandedRaw;
    const expanded = [];
    const keySecret = [];
    const secretKey = [];
    const publicKey = [];
    let ok = false;
    try {
      for (const part of seedCoder.decode(expandedSeed))
        expanded.push(copyBytes2(part));
      for (let i = 0;i < ck.length; i++) {
        const keys = ck[i].keygen(expanded[i]);
        keySecret.push(keys.secretKey);
        secretKey.push(copyBytes2(keys.secretKey));
        publicKey.push(keys.publicKey);
      }
      ok = true;
      return { secretKey, publicKey };
    } finally {
      cleanBytes(expandedSeed, expanded, keySecret);
      if (!ok)
        cleanBytes(secretKey);
    }
  }
  const keygen = (seed) => {
    const root = seed === undefined ? randomBytes4(rootSeedLen) : copyBytes2(seed);
    let res;
    try {
      const { publicKey: pk, secretKey } = expandDecapsulationKey(root);
      try {
        res = {
          secretKey: root,
          publicKey: pkCoder.encode(pk)
        };
      } finally {
        cleanBytes(pk, secretKey);
      }
      return res;
    } finally {
      if (!res)
        cleanBytes(root);
    }
  };
  return {
    info: { lengths: { seed: rootSeedLen, publicKey: pkCoder.bytesLen, secretKey: rootSeedLen } },
    getPublicKey: (secretKey) => {
      const keys = keygen(secretKey);
      cleanBytes(keys.secretKey);
      return keys.publicKey;
    },
    keygen,
    expandDecapsulationKey,
    realSeedLen: rootSeedLen
  };
}
function combineKEMS(realSeedLen, realMsgLen, expandSeed, combiner, ...kems) {
  if (realSeedLen !== undefined)
    positiveLength(realSeedLen, "realSeedLen");
  if (realMsgLen !== undefined)
    positiveLength(realMsgLen, "realMsgLen");
  if (typeof expandSeed !== "function")
    throw new TypeError('"expandSeed" expected function, got type=' + typeof expandSeed);
  if (typeof combiner !== "function")
    throw new TypeError('"combiner" expected function, got type=' + typeof combiner);
  const rawCombiner = combiner;
  const rawKems = kems;
  if (rawKems.length === 0)
    throw new RangeError("combineKEMS requires at least one KEM");
  for (let i = 0;i < rawKems.length; i++)
    validateKEM(rawKems[i], `kems[${i}]`);
  const keys = combineKeys(realSeedLen, expandSeed, ...rawKems);
  const ctCoder = splitLengths(rawKems, "cipherText");
  const pkCoder = splitLengths(rawKems, "publicKey");
  const msgCoder = splitLengths(rawKems, "msg");
  const sharedSecretLen = positiveLength(realMsgLen === undefined ? msgCoder.bytesLen : realMsgLen, "realMsgLen");
  const lengths = Object.freeze({
    ...keys.info.lengths,
    msg: sharedSecretLen,
    msgRand: msgCoder.bytesLen,
    cipherText: ctCoder.bytesLen
  });
  const combine = (publicKeys, cipherTexts, sharedSecrets) => {
    const combined = rawCombiner(publicKeys, cipherTexts, sharedSecrets);
    try {
      return copyBytes2(abytes(combined, sharedSecretLen, "sharedSecret"));
    } catch (error) {
      if (isBytes(combined)) {
        const overlaps = (value) => combined.buffer === value.buffer && combined.byteOffset < value.byteOffset + value.byteLength && value.byteOffset < combined.byteOffset + combined.byteLength;
        const aliasesPublicInput = publicKeys.some(overlaps) || cipherTexts.some(overlaps);
        if (!aliasesPublicInput)
          cleanBytes(combined);
      }
      throw error;
    }
  };
  return Object.freeze({
    lengths,
    getPublicKey: keys.getPublicKey,
    keygen: keys.keygen,
    encapsulate(pk, randomness = randomBytes4(msgCoder.bytesLen)) {
      const pks = pkCoder.decode(pk);
      const rand = msgCoder.decode(randomness);
      const sharedSecret = [];
      const cipherText = [];
      try {
        for (let i = 0;i < rawKems.length; i++) {
          const enc = rawKems[i].encapsulate(pks[i], rand[i]);
          sharedSecret.push(enc.sharedSecret);
          cipherText.push(enc.cipherText);
        }
        const encodedCipherText = ctCoder.encode(cipherText);
        return {
          sharedSecret: combine(pks, cipherText, sharedSecret),
          cipherText: encodedCipherText
        };
      } finally {
        cleanBytes(sharedSecret, cipherText);
      }
    },
    decapsulate(ct, seed) {
      const cts = ctCoder.decode(ct);
      const { publicKey, secretKey } = keys.expandDecapsulationKey(seed);
      const sharedSecret = [];
      try {
        for (let i = 0;i < rawKems.length; i++)
          sharedSecret.push(rawKems[i].decapsulate(cts[i], secretKey[i]));
        return combine(publicKey, cts, sharedSecret);
      } finally {
        cleanBytes(secretKey, sharedSecret);
      }
    }
  });
}
var x25519kem = /* @__PURE__ */ _ecdhKem(x25519);
var ml_kem768_x25519 = /* @__PURE__ */ (() => combineKEMS(32, 32, expandSeedXof(shake256), (pk, ct, ss) => sha3_256(concatBytes3(ss[0], ss[1], ct[1], pk[1], asciiToBytes("\\.//^\\"))), ml_kem768, x25519kem))();

// ../../node_modules/.bun/@panva+hpke-noble@1.1.8+50832bcf6e3124be/node_modules/@panva/hpke-noble/index.js
var AES_GCM_P_MAX2 = 2 ** 36 - 31;
var CHACHA20_POLY1305_P_MAX2 = 2 ** 38 - 64;
var KEM_MLKEM768_X255192 = () => createPqKem({
  id: 25722,
  name: "MLKEM768-X25519",
  Nsecret: 32,
  Nenc: 1120,
  Npk: 1216,
  Nsk: 32,
  kem: ml_kem768_x25519
});
function createPqKem(config) {
  const { id, name, Nsecret, Nenc, Npk, Nsk, kem: nobleKem } = config;
  const suite_id = concat(encode("KEM"), I2OSP(id, 2));
  Object.freeze(NobleKey.prototype);
  const algorithm = { name };
  return {
    id,
    type: "KEM",
    name,
    Nsecret,
    Nenc,
    Npk,
    Nsk,
    async DeriveKeyPair(ikm, extractable) {
      const seed = await LabeledDerive({
        async Derive(ikm, L) {
          return shake256(ikm, { dkLen: L });
        }
      }, suite_id, ikm, encode("DeriveKeyPair"), new Uint8Array, Nsk);
      const { secretKey, publicKey } = nobleKem.keygen(seed);
      return {
        privateKey: new NobleKey(priv2, "private", secretKey, extractable, algorithm, seed),
        publicKey: new NobleKey(priv2, "public", publicKey, true, algorithm)
      };
    },
    async GenerateKeyPair(extractable) {
      const ikm = crypto.getRandomValues(new Uint8Array(Nsk));
      return await this.DeriveKeyPair(ikm, extractable);
    },
    async SerializePublicKey(key) {
      NobleKey.validate(key, algorithm, true);
      return key.value(priv2);
    },
    async DeserializePublicKey(key) {
      return new NobleKey(priv2, "public", slice2(key), true, algorithm);
    },
    async SerializePrivateKey(key) {
      NobleKey.validate(key, algorithm, true);
      return key.seed(priv2);
    },
    async DeserializePrivateKey(key, extractable) {
      const { secretKey } = nobleKem.keygen(key);
      return new NobleKey(priv2, "private", secretKey, extractable, algorithm, slice2(key));
    },
    async Encap(pkR) {
      NobleKey.validate(pkR, algorithm);
      const { cipherText, sharedSecret } = nobleKem.encapsulate(pkR.value(priv2));
      return { shared_secret: sharedSecret, enc: cipherText };
    },
    async Decap(enc, skR) {
      NobleKey.validate(skR, algorithm);
      return nobleKem.decapsulate(enc, skR.value(priv2));
    }
  };
}
var InvalidInvocation2 = (_) => {
  if (_ !== priv2) {
    throw new Error("invalid invocation");
  }
};
var priv2 = /* @__PURE__ */ Symbol();

class NobleKey {
  #type;
  #extractable;
  #algorithm;
  #value;
  #seed;
  static #isValid(key) {
    return key.#algorithm !== undefined;
  }
  static validate(key, algorithm, extractable) {
    if (key.algorithm?.name !== algorithm.name) {
      throw new TypeError(`key algorithm must be ${algorithm.name}`);
    }
    try {
      if (!NobleKey.#isValid(key)) {
        throw new TypeError("unexpected key constructor");
      }
    } catch {
      throw new TypeError("unexpected key constructor");
    }
    if (extractable && !key.extractable) {
      throw new TypeError("key must be extractable");
    }
  }
  constructor(_, type, value, extractable, algorithm, seed) {
    InvalidInvocation2(_);
    this.#type = type;
    this.#value = value;
    this.#extractable = extractable;
    this.#algorithm = algorithm;
    this.#seed = seed;
  }
  get algorithm() {
    return { name: this.#algorithm.name };
  }
  get extractable() {
    return this.#extractable;
  }
  get type() {
    return this.#type;
  }
  value(_) {
    InvalidInvocation2(_);
    return slice2(this.#value);
  }
  seed(_) {
    InvalidInvocation2(_);
    return slice2(this.#seed);
  }
}
function slice2(buffer, start, end) {
  return Uint8Array.prototype.slice.call(buffer, start, end);
}

// ../../packages/crypto/src/kem.ts
var SEED_BYTES = 32;
var ENCAPSULATED_BYTES = 1120;
var CAPSULE_KEY_BYTES = 32;
var SEALED_CAPSULE_KEY_BYTES = CAPSULE_KEY_BYTES + 16;
var CAPSULE_INFO = "radium/v1/capsule";
var SELF_TEST_IKM = "yFddE33quZrJj7CHMEjIPDofR-9bQJ9gnAymUvWMg-A";
var SELF_TEST_PUBLIC_KEY_SHA256 = "rUKz2GaWBes1EnO5ReL0v-YphlF7QR5gbCJdltTekJk";
function createXWingSuite(implementation) {
  const kem = implementation === "native" ? KEM_MLKEM768_X25519 : KEM_MLKEM768_X255192;
  return new CipherSuite(kem, KDF_HKDF_SHA256, AEAD_AES_256_GCM);
}
async function passesSelfTest(suite) {
  try {
    const keyPair = await suite.DeriveKeyPair(fromBase64Url(SELF_TEST_IKM), false);
    const publicKey = await suite.SerializePublicKey(keyPair.publicKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(publicKey)));
    if (!equalBytes(digest, fromBase64Url(SELF_TEST_PUBLIC_KEY_SHA256))) {
      return false;
    }
    const exporterContext = utf8("radium/v1/self-test");
    const { encapsulatedSecret, ctx } = await suite.SetupSender(keyPair.publicKey);
    const recipient = await suite.SetupRecipient(keyPair, encapsulatedSecret);
    return equalBytes(await ctx.Export(exporterContext, 32), await recipient.Export(exporterContext, 32));
  } catch {
    return false;
  }
}
var selectedSuite;
function getXWingSuite() {
  selectedSuite ??= (async () => {
    const native = await createNativeSuiteIfAvailable();
    if (native !== undefined && await passesSelfTest(native)) {
      return { implementation: "native", suite: native };
    }
    return { implementation: "noble", suite: createXWingSuite("noble") };
  })();
  return selectedSuite;
}
function createNativeSuiteIfAvailable() {
  try {
    return createXWingSuite("native");
  } catch {
    return;
  }
}
async function deriveKeyPair(seed) {
  assertLength(seed, SEED_BYTES, "seed");
  const { suite } = await getXWingSuite();
  return { suite, keyPair: await suite.DeriveKeyPair(seed, false) };
}
async function encryptionPublicKeyFromSeed(seed) {
  const { suite, keyPair } = await deriveKeyPair(seed);
  return suite.SerializePublicKey(keyPair.publicKey);
}
function capsuleInfo(capsuleId) {
  return concatBytes(utf8(CAPSULE_INFO), capsuleId);
}
async function openCapsule(input) {
  const { capsule } = input;
  assertSupportedSuite(capsule.suite);
  if (capsule.capsuleId.length !== KEY_ID_BYTES || capsule.encapsulated.length !== ENCAPSULATED_BYTES || capsule.sealedKey.length !== SEALED_CAPSULE_KEY_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed capsule");
  }
  const { suite, keyPair } = await deriveKeyPair(input.seed);
  try {
    return await suite.Open(keyPair, capsule.encapsulated, capsule.sealedKey, {
      info: capsuleInfo(capsule.capsuleId),
      aad: buildAad(input.aad)
    });
  } catch {
    throw new CryptoError("DECRYPT_FAILED", "Decryption failed");
  }
}
async function deriveObjectKey(input) {
  assertLength(input.capsuleKey, CAPSULE_KEY_BYTES, "capsuleKey");
  const info = lengthPrefixed([
    utf8(LABELS.object),
    utf8(input.table),
    utf8(input.recordId),
    utf8(input.field)
  ]);
  return hkdf(input.capsuleKey, info, 32);
}
// ../../packages/crypto/src/signatures.ts
var SEED_BYTES2 = 32;
var PKCS8_ED25519_PREFIX = Uint8Array.of(48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32);
async function importNativeSigningKey(seed, extractable) {
  const pkcs8 = concatBytes(PKCS8_ED25519_PREFIX, seed);
  try {
    return await crypto.subtle.importKey("pkcs8", bufferSource(pkcs8), { name: "Ed25519" }, extractable, ["sign"]);
  } finally {
    pkcs8.fill(0);
  }
}
var nativeEd25519 = {
  name: "native",
  async publicKeyFromSeed(seed) {
    const key = await importNativeSigningKey(seed, true);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (typeof jwk.x !== "string") {
      throw new CryptoError("BAD_INPUT", "Ed25519 key export failed");
    }
    return fromBase64Url(jwk.x);
  },
  async sign(seed, message) {
    const key = await importNativeSigningKey(seed, false);
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bufferSource(message)));
  },
  async verify(publicKey, message, signature) {
    try {
      const key = await crypto.subtle.importKey("raw", bufferSource(publicKey), { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, bufferSource(signature), bufferSource(message));
    } catch {
      return false;
    }
  }
};
var nobleEd25519 = {
  name: "noble",
  async publicKeyFromSeed(seed) {
    return ed25519.getPublicKey(seed);
  },
  async sign(seed, message) {
    return ed25519.sign(message, seed);
  },
  async verify(publicKey, message, signature) {
    try {
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  }
};
var SELF_TEST_SEED = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
var SELF_TEST_PUBLIC_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
var SELF_TEST_SIGNATURE = "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw";
async function passesSelfTest2(implementation) {
  try {
    const seed = fromBase64Url(SELF_TEST_SEED);
    const publicKey = await implementation.publicKeyFromSeed(seed);
    const signature = await implementation.sign(seed, new Uint8Array(0));
    return equalBytes(publicKey, fromBase64Url(SELF_TEST_PUBLIC_KEY)) && equalBytes(signature, fromBase64Url(SELF_TEST_SIGNATURE)) && await implementation.verify(publicKey, new Uint8Array(0), signature);
  } catch {
    return false;
  }
}
var selectedImplementation;
function getEd25519() {
  selectedImplementation ??= (async () => await passesSelfTest2(nativeEd25519) ? nativeEd25519 : nobleEd25519)();
  return selectedImplementation;
}
async function signingPublicKeyFromSeed(seed) {
  assertLength(seed, SEED_BYTES2, "seed");
  return (await getEd25519()).publicKeyFromSeed(seed);
}
async function sign(seed, message) {
  assertLength(seed, SEED_BYTES2, "seed");
  return (await getEd25519()).sign(seed, message);
}
async function verify(publicKey, message, signature) {
  if (publicKey.length !== SIGNING_PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) {
    return false;
  }
  try {
    if (ed25519.Point.fromBytes(publicKey, false).isSmallOrder())
      return false;
  } catch {
    return false;
  }
  return (await getEd25519()).verify(publicKey, message, signature);
}
function signingMessage(label, ...parts) {
  return lengthPrefixed([utf8(label), ...parts]);
}
// ../../packages/crypto/src/fingerprints.ts
var FINGERPRINT_LABEL = "radium/fingerprint-v1/";
var FINGERPRINT_BYTES = 16;
function encodeIdentity(identity) {
  assertLength(identity.encryptionPublicKey, ENCRYPTION_PUBLIC_KEY_BYTES, "encryptionPublicKey");
  assertLength(identity.signingPublicKey, SIGNING_PUBLIC_KEY_BYTES, "signingPublicKey");
  return lengthPrefixed([identity.encryptionPublicKey, identity.signingPublicKey]);
}
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
}
async function fingerprint(input) {
  const digest = await sha256(concatBytes(utf8(FINGERPRINT_LABEL), encodeIdentity(input)));
  const hex = toHex(digest.subarray(0, FINGERPRINT_BYTES));
  return hex.match(/.{4}/gu).join(" ");
}
// ../../packages/crypto/src/box.ts
var ENCAPSULATED_BYTES2 = 1120;
var SEALED_CAPSULE_KEY_BYTES2 = 48;
var CAPSULE_BYTES = 1 + KEY_ID_BYTES + ENCAPSULATED_BYTES2 + SEALED_CAPSULE_KEY_BYTES2;
function decodeCapsule(bytes) {
  if (bytes.length !== CAPSULE_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed capsule");
  }
  const suite = bytes[0];
  assertSupportedSuite(suite);
  let offset = 1;
  const capsuleId = bytes.slice(offset, offset + KEY_ID_BYTES);
  offset += KEY_ID_BYTES;
  const encapsulated = bytes.slice(offset, offset + ENCAPSULATED_BYTES2);
  offset += ENCAPSULATED_BYTES2;
  const sealedKey = bytes.slice(offset);
  return { suite, capsuleId, encapsulated, sealedKey };
}
function objectKeyFor(capsuleKey, aad) {
  return deriveObjectKey({ capsuleKey, table: aad.table, recordId: aad.record, field: aad.field });
}
async function openWithCapsule(input) {
  return openSym({
    key: await objectKeyFor(input.capsuleKey, input.aad),
    envelope: input.envelope,
    aad: input.aad,
    pad: input.pad
  });
}
async function openBox(input) {
  if (input.box.length <= CAPSULE_BYTES) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed box");
  }
  const capsule = decodeCapsule(input.box.subarray(0, CAPSULE_BYTES));
  const envelope = input.box.subarray(CAPSULE_BYTES);
  const keyRef = envelope.subarray(3, 3 + KEY_ID_BYTES);
  if (keyRef.length !== KEY_ID_BYTES || !keyRef.every((byte, i) => byte === capsule.capsuleId[i])) {
    throw new CryptoError("BAD_ENVELOPE", "Malformed box");
  }
  const capsuleKey = await openCapsule({ seed: input.seed, capsule, aad: input.aad });
  try {
    return await openWithCapsule({ capsuleKey, envelope, aad: input.aad, pad: input.pad });
  } finally {
    capsuleKey.fill(0);
  }
}
async function sha2562(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSource(bytes)));
}
function decimal(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CryptoError("BAD_INPUT", "Invalid integer");
  }
  return utf8(String(value));
}
// ../../packages/crypto/src/statements.ts
function grantStatement(input) {
  return signingMessage("radium/v1/grant", utf8(input.workspaceId), decimal(input.epoch), utf8(input.purpose), utf8(input.recipientUserId), utf8(input.recipientKeyId), input.sealed);
}
function rosterStatement(input) {
  return signingMessage("radium/v1/roster", utf8(input.workspaceId), input.body);
}
function chatKeyStatement(input) {
  return signingMessage("radium/v1/chat-key", utf8(input.workspaceId), utf8(input.chatE2eeId), decimal(input.epoch), utf8(input.keyId), decimal(input.suite), input.publicKey);
}
// ../../packages/crypto/src/roster.ts
async function signRoster(body, signingSeed) {
  const canonical = {
    v: 2,
    workspace: body.workspace,
    version: body.version,
    epoch: body.epoch,
    owner: {
      userId: body.owner.userId,
      keyId: body.owner.keyId,
      fingerprint: body.owner.fingerprint
    },
    epochs: body.epochs.map((entry) => ({
      epoch: entry.epoch,
      memberKeyId: entry.memberKeyId,
      memberKeyHash: entry.memberKeyHash,
      ownerKeyId: entry.ownerKeyId,
      ownerKeyHash: entry.ownerKeyHash
    })),
    members: body.members.map((member) => ({
      userId: member.userId,
      keyId: member.keyId,
      fingerprint: member.fingerprint
    })),
    workers: body.workers.map((worker) => ({
      workerId: worker.workerId,
      keyId: worker.keyId,
      fingerprint: worker.fingerprint
    }))
  };
  const encoded = utf8(JSON.stringify(canonical));
  return {
    version: canonical.version,
    body: encoded,
    signature: await sign(signingSeed, rosterStatement({ workspaceId: canonical.workspace, body: encoded })),
    signerKeyId: canonical.owner.keyId
  };
}
function isKeyId(value) {
  if (typeof value !== "string")
    return false;
  try {
    return fromBase64Url(value).length === 16;
  } catch {
    return false;
  }
}
function isDigest(value) {
  if (typeof value !== "string")
    return false;
  try {
    return fromBase64Url(value).length === 32;
  } catch {
    return false;
  }
}
function isPositive(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
async function verifyRoster(input) {
  if (input.version < input.highWater || input.signerKeyId !== input.owner.keyId || !await verify(input.owner.signingPublicKey, rosterStatement({ workspaceId: input.workspaceId, body: input.body }), input.signature))
    throw new CryptoError("DECRYPT_FAILED", "Roster signature or version failed");
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");
  }
  if (!body || typeof body !== "object" || body.v !== 1 && body.v !== 2 || body.workspace !== input.workspaceId || body.version !== input.version || !isPositive(body.version) || !isPositive(body.epoch) || !body.owner || body.owner.userId !== input.owner.userId || body.owner.keyId !== input.owner.keyId || body.owner.fingerprint !== input.owner.fingerprint || !Array.isArray(body.epochs) || !Array.isArray(body.members) || body.v === 2 && !Array.isArray(body.workers))
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");
  const epochIds = new Set;
  for (const epoch of body.epochs) {
    if (!epoch || !isPositive(epoch.epoch) || epoch.epoch > body.epoch || epochIds.has(epoch.epoch) || !isKeyId(epoch.memberKeyId) || !isKeyId(epoch.ownerKeyId) || !isDigest(epoch.memberKeyHash) || !isDigest(epoch.ownerKeyHash))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch");
    epochIds.add(epoch.epoch);
  }
  if (!epochIds.has(body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Roster current epoch missing");
  const members = new Set;
  for (const member of body.members) {
    if (!member || typeof member.userId !== "string" || typeof member.fingerprint !== "string" || member.userId === body.owner.userId || members.has(member.userId) || !isKeyId(member.keyId))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster member");
    members.add(member.userId);
  }
  const workers = body.v === 2 ? body.workers : [];
  const workerIds = new Set;
  for (const worker of workers) {
    if (!worker || typeof worker.workerId !== "string" || worker.workerId.length === 0 || typeof worker.fingerprint !== "string" || workerIds.has(worker.workerId) || !isKeyId(worker.keyId))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster worker");
    workerIds.add(worker.workerId);
  }
  return { ...body, workers };
}
// ../../packages/crypto/src/account.ts
var IDENTITY_STATEMENT = "radium/v1/identity";
function identityStatement(keyId, suite, encryptionPublicKey, signingPublicKey) {
  return signingMessage(IDENTITY_STATEMENT, keyId, Uint8Array.of(suite), encryptionPublicKey, signingPublicKey);
}
async function verifyIdentitySelfSignature(input) {
  if (input.suite !== SUITE_1 || input.keyId.length !== KEY_ID_BYTES) {
    return false;
  }
  const statement = identityStatement(input.keyId, input.suite, input.encryptionPublicKey, input.signingPublicKey);
  return verify(input.signingPublicKey, statement, input.signature);
}
// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/values/base64.js
var lookup = [];
var revLookup = [];
var Arr = Uint8Array;
var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (i = 0, len = code.length;i < len; ++i) {
  lookup[i] = code[i];
  revLookup[code.charCodeAt(i)] = i;
}
var i;
var len;
revLookup[45] = 62;
revLookup[95] = 63;
function getLens(b64) {
  var len = b64.length;
  if (len % 4 > 0) {
    throw new Error("Invalid string. Length must be a multiple of 4");
  }
  var validLen = b64.indexOf("=");
  if (validLen === -1)
    validLen = len;
  var placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
}
function _byteLength(_b64, validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}
function toByteArray(b64) {
  var tmp;
  var lens = getLens(b64);
  var validLen = lens[0];
  var placeHoldersLen = lens[1];
  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
  var curByte = 0;
  var len = placeHoldersLen > 0 ? validLen - 4 : validLen;
  var i;
  for (i = 0;i < len; i += 4) {
    tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
    arr[curByte++] = tmp >> 16 & 255;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 2) {
    tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 1) {
    tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  return arr;
}
function tripletToBase64(num) {
  return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
}
function encodeChunk(uint8, start, end) {
  var tmp;
  var output = [];
  for (var i = start;i < end; i += 3) {
    tmp = (uint8[i] << 16 & 16711680) + (uint8[i + 1] << 8 & 65280) + (uint8[i + 2] & 255);
    output.push(tripletToBase64(tmp));
  }
  return output.join("");
}
function fromByteArray(uint8) {
  var tmp;
  var len = uint8.length;
  var extraBytes = len % 3;
  var parts = [];
  var maxChunkLength = 16383;
  for (var i = 0, len2 = len - extraBytes;i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));
  }
  if (extraBytes === 1) {
    tmp = uint8[len - 1];
    parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1];
    parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
  }
  return parts.join("");
}

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/common/index.js
function isSimpleObject(value) {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple = prototype === null || prototype === Object.prototype || prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/values/value.js
var LITTLE_ENDIAN = true;
var MIN_INT64 = BigInt("-9223372036854775808");
var MAX_INT64 = BigInt("9223372036854775807");
var ZERO = BigInt("0");
var EIGHT = BigInt("8");
var TWOFIFTYSIX = BigInt("256");
var COMMIT_TS_UNRESOLVED = "This commit timestamp is unresolved: its value is assigned when the mutation commits. Read the document after the mutation completes to get its value.";

class CommitTsPlaceholder {
  [Symbol.toPrimitive](hint) {
    if (hint === "string") {
      return this.toString();
    }
    throw new Error(COMMIT_TS_UNRESOLVED);
  }
  valueOf() {
    throw new Error(COMMIT_TS_UNRESOLVED);
  }
  toJSON() {
    throw new Error(COMMIT_TS_UNRESOLVED);
  }
  toString() {
    return "[unresolved commit timestamp]";
  }
}
var commitTsPlaceholder = new CommitTsPlaceholder;
function isSpecial(n) {
  return Number.isNaN(n) || !Number.isFinite(n) || Object.is(n, -0);
}
function slowBigIntToBase64(value) {
  if (value < ZERO) {
    value -= MIN_INT64 + MIN_INT64;
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1)
    hex = "0" + hex;
  const bytes = new Uint8Array(new ArrayBuffer(8));
  let i = 0;
  for (const hexByte of hex.match(/.{2}/g).reverse()) {
    bytes.set([parseInt(hexByte, 16)], i++);
    value >>= EIGHT;
  }
  return fromByteArray(bytes);
}
function slowBase64ToBigInt(encoded) {
  const integerBytes = toByteArray(encoded);
  if (integerBytes.byteLength !== 8) {
    throw new Error(`Received ${integerBytes.byteLength} bytes, expected 8 for $integer`);
  }
  let value = ZERO;
  let power = ZERO;
  for (const byte of integerBytes) {
    value += BigInt(byte) * TWOFIFTYSIX ** power;
    power++;
  }
  if (value > MAX_INT64) {
    value += MIN_INT64 + MIN_INT64;
  }
  return value;
}
function modernBigIntToBase64(value) {
  if (value < MIN_INT64 || MAX_INT64 < value) {
    throw new Error(`BigInt ${value} does not fit into a 64-bit signed integer.`);
  }
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigInt64(0, value, true);
  return fromByteArray(new Uint8Array(buffer));
}
function modernBase64ToBigInt(encoded) {
  const integerBytes = toByteArray(encoded);
  if (integerBytes.byteLength !== 8) {
    throw new Error(`Received ${integerBytes.byteLength} bytes, expected 8 for $integer`);
  }
  const intBytesView = new DataView(integerBytes.buffer);
  return intBytesView.getBigInt64(0, true);
}
var bigIntToBase64 = DataView.prototype.setBigInt64 ? modernBigIntToBase64 : slowBigIntToBase64;
var base64ToBigInt = DataView.prototype.getBigInt64 ? modernBase64ToBigInt : slowBase64ToBigInt;
var MAX_IDENTIFIER_LEN = 1024;
function validateObjectField(k) {
  if (k.length > MAX_IDENTIFIER_LEN) {
    throw new Error(`Field name ${k} exceeds maximum field name length ${MAX_IDENTIFIER_LEN}.`);
  }
  if (k.startsWith("$")) {
    throw new Error(`Field name ${k} starts with a '$', which is reserved.`);
  }
  for (let i = 0;i < k.length; i += 1) {
    const charCode = k.charCodeAt(i);
    if (charCode < 32 || charCode >= 127) {
      throw new Error(`Field name ${k} has invalid character '${k[i]}': Field names can only contain non-control ASCII characters`);
    }
  }
}
var MAX_VALUE_FOR_ERROR_LEN = 16384;
function stringifyValueForError(value) {
  const str = JSON.stringify(value, (_key, value2) => {
    if (value2 === undefined) {
      return "undefined";
    }
    if (typeof value2 === "function") {
      return "[Function]";
    }
    if (typeof value2 === "symbol") {
      return String(value2);
    }
    if (typeof value2 === "bigint") {
      return `${value2.toString()}n`;
    }
    return value2;
  });
  if (str.length > MAX_VALUE_FOR_ERROR_LEN) {
    const rest = "[...truncated]";
    let truncateAt = MAX_VALUE_FOR_ERROR_LEN - rest.length;
    const codePoint = str.codePointAt(truncateAt - 1);
    if (codePoint !== undefined && codePoint > 65535) {
      truncateAt -= 1;
    }
    return str.substring(0, truncateAt) + rest;
  }
  return str;
}
function convexToJsonInternal(value, originalValue, context, includeTopLevelUndefined) {
  if (value === undefined) {
    const contextText = context && ` (present at path ${context} in original object ${stringifyValueForError(originalValue)})`;
    throw new Error(`undefined is not a valid Convex value${contextText}. To learn about Convex's supported types, see https://docs.convex.dev/using/types.`);
  }
  if (value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || MAX_INT64 < value) {
      throw new Error(`BigInt ${value} does not fit into a 64-bit signed integer.`);
    }
    return { $integer: bigIntToBase64(value) };
  }
  if (typeof value === "number") {
    if (isSpecial(value)) {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, value, LITTLE_ENDIAN);
      return { $float: fromByteArray(new Uint8Array(buffer)) };
    } else {
      return value;
    }
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return { $bytes: fromByteArray(new Uint8Array(value)) };
  }
  if (value instanceof CommitTsPlaceholder) {
    return { $commitTs: null };
  }
  if (Array.isArray(value)) {
    return value.map((value2, i) => convexToJsonInternal(value2, originalValue, context + `[${i}]`, false));
  }
  if (value instanceof Set) {
    throw new Error(errorMessageForUnsupportedType(context, "Set", [...value], originalValue));
  }
  if (value instanceof Map) {
    throw new Error(errorMessageForUnsupportedType(context, "Map", [...value], originalValue));
  }
  if (!isSimpleObject(value)) {
    const theType = value?.constructor?.name;
    const typeName = theType ? `${theType} ` : "";
    throw new Error(errorMessageForUnsupportedType(context, typeName, value, originalValue));
  }
  const out = {};
  const entries = Object.entries(value);
  entries.sort(([k1, _v1], [k2, _v2]) => k1 === k2 ? 0 : k1 < k2 ? -1 : 1);
  for (const [k, v] of entries) {
    if (v !== undefined) {
      validateObjectField(k);
      out[k] = convexToJsonInternal(v, originalValue, context + `.${k}`, false);
    } else if (includeTopLevelUndefined) {
      validateObjectField(k);
      out[k] = convexOrUndefinedToJsonInternal(v, originalValue, context + `.${k}`);
    }
  }
  return out;
}
function errorMessageForUnsupportedType(context, typeName, value, originalValue) {
  if (context) {
    return `${typeName}${stringifyValueForError(value)} is not a supported Convex type (present at path ${context} in original object ${stringifyValueForError(originalValue)}). To learn about Convex's supported types, see https://docs.convex.dev/using/types.`;
  } else {
    return `${typeName}${stringifyValueForError(value)} is not a supported Convex type.`;
  }
}
function convexOrUndefinedToJsonInternal(value, originalValue, context) {
  if (value === undefined) {
    return { $undefined: null };
  } else {
    if (originalValue === undefined) {
      throw new Error(`Programming error. Current value is ${stringifyValueForError(value)} but original value is undefined`);
    }
    return convexToJsonInternal(value, originalValue, context, false);
  }
}
function convexToJson(value) {
  return convexToJsonInternal(value, value, "", false);
}

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/values/validators.js
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => (key in obj) ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var UNDEFINED_VALIDATOR_ERROR_URL = "https://docs.convex.dev/error#undefined-validator";
function throwUndefinedValidatorError(context, fieldName) {
  const fieldInfo = fieldName !== undefined ? ` for field "${fieldName}"` : "";
  throw new Error(`A validator is undefined${fieldInfo} in ${context}. This is often caused by circular imports. See ${UNDEFINED_VALIDATOR_ERROR_URL} for details.`);
}

class BaseValidator {
  constructor({ isOptional }) {
    __publicField(this, "type");
    __publicField(this, "fieldPaths");
    __publicField(this, "isOptional");
    __publicField(this, "isConvexValidator");
    this.isOptional = isOptional;
    this.isConvexValidator = true;
  }
}

class VId extends BaseValidator {
  constructor({
    isOptional,
    tableName
  }) {
    super({ isOptional });
    __publicField(this, "tableName");
    __publicField(this, "kind", "id");
    if (typeof tableName !== "string") {
      throw new Error("v.id(tableName) requires a string");
    }
    this.tableName = tableName;
  }
  get json() {
    return { type: "id", tableName: this.tableName };
  }
  optional() {
    return new VId({
      isOptional: "optional",
      tableName: this.tableName
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VFloat64 extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "float64");
  }
  get json() {
    return { type: "number" };
  }
  optional() {
    return new VFloat64({
      isOptional: "optional"
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VInt64 extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "int64");
  }
  get json() {
    return { type: "bigint" };
  }
  optional() {
    return new VInt64({ isOptional: "optional" });
  }
  asOptional() {
    return this.optional();
  }
}

class VCommitTs extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "commitTs");
  }
  get json() {
    return { type: this.kind };
  }
  optional() {
    return new VCommitTs({
      isOptional: "optional"
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VFunction extends BaseValidator {
  constructor({
    isOptional,
    fnType,
    args,
    returns
  }) {
    super({ isOptional });
    __publicField(this, "kind", "function");
    __publicField(this, "fnType");
    __publicField(this, "args");
    __publicField(this, "returns");
    this.fnType = fnType;
    this.args = args;
    this.returns = returns;
  }
  get json() {
    return {
      type: this.kind,
      ...this.fnType === undefined ? {} : { fnType: this.fnType },
      ...this.args === undefined ? {} : { args: this.args.json },
      ...this.returns === undefined ? {} : { returns: this.returns.json }
    };
  }
  optional() {
    return new VFunction({
      isOptional: "optional",
      fnType: this.fnType,
      args: this.args,
      returns: this.returns
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VBoolean extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "boolean");
  }
  get json() {
    return { type: this.kind };
  }
  optional() {
    return new VBoolean({
      isOptional: "optional"
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VBytes extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "bytes");
  }
  get json() {
    return { type: this.kind };
  }
  optional() {
    return new VBytes({ isOptional: "optional" });
  }
  asOptional() {
    return this.optional();
  }
}

class VString extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "string");
  }
  get json() {
    return { type: this.kind };
  }
  optional() {
    return new VString({
      isOptional: "optional"
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VNull extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "null");
  }
  get json() {
    return { type: this.kind };
  }
  optional() {
    return new VNull({ isOptional: "optional" });
  }
  asOptional() {
    return this.optional();
  }
}

class VAny extends BaseValidator {
  constructor() {
    super(...arguments);
    __publicField(this, "kind", "any");
  }
  get json() {
    return {
      type: this.kind
    };
  }
  optional() {
    return new VAny({
      isOptional: "optional"
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VObject extends BaseValidator {
  constructor({
    isOptional,
    fields
  }) {
    super({ isOptional });
    __publicField(this, "fields");
    __publicField(this, "kind", "object");
    globalThis.Object.entries(fields).forEach(([fieldName, validator]) => {
      if (validator === undefined) {
        throwUndefinedValidatorError("v.object()", fieldName);
      }
      if (!validator.isConvexValidator) {
        throw new Error("v.object() entries must be validators");
      }
    });
    this.fields = fields;
  }
  get json() {
    return {
      type: this.kind,
      value: globalThis.Object.fromEntries(globalThis.Object.entries(this.fields).map(([k, v]) => [
        k,
        {
          fieldType: v.json,
          optional: v.isOptional === "optional" ? true : false
        }
      ]))
    };
  }
  optional() {
    return new VObject({
      isOptional: "optional",
      fields: this.fields
    });
  }
  asOptional() {
    return this.optional();
  }
  omit(...fields) {
    const newFields = { ...this.fields };
    for (const field of fields) {
      delete newFields[field];
    }
    return new VObject({
      isOptional: this.isOptional,
      fields: newFields
    });
  }
  pick(...fields) {
    const newFields = {};
    for (const field of fields) {
      newFields[field] = this.fields[field];
    }
    return new VObject({
      isOptional: this.isOptional,
      fields: newFields
    });
  }
  partial() {
    const newFields = {};
    for (const [key, validator] of globalThis.Object.entries(this.fields)) {
      newFields[key] = validator.asOptional();
    }
    return new VObject({
      isOptional: this.isOptional,
      fields: newFields
    });
  }
  extend(fields) {
    return new VObject({
      isOptional: this.isOptional,
      fields: { ...this.fields, ...fields }
    });
  }
}

class VLiteral extends BaseValidator {
  constructor({ isOptional, value }) {
    super({ isOptional });
    __publicField(this, "value");
    __publicField(this, "kind", "literal");
    if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "bigint") {
      throw new Error("v.literal(value) must be a string, number, or boolean");
    }
    this.value = value;
  }
  get json() {
    return {
      type: this.kind,
      value: convexToJson(this.value)
    };
  }
  optional() {
    return new VLiteral({
      isOptional: "optional",
      value: this.value
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VArray extends BaseValidator {
  constructor({
    isOptional,
    element
  }) {
    super({ isOptional });
    __publicField(this, "element");
    __publicField(this, "kind", "array");
    if (element === undefined) {
      throwUndefinedValidatorError("v.array()");
    }
    this.element = element;
  }
  get json() {
    return {
      type: this.kind,
      value: this.element.json
    };
  }
  optional() {
    return new VArray({
      isOptional: "optional",
      element: this.element
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VRecord extends BaseValidator {
  constructor({
    isOptional,
    key,
    value
  }) {
    super({ isOptional });
    __publicField(this, "key");
    __publicField(this, "value");
    __publicField(this, "kind", "record");
    if (key === undefined) {
      throwUndefinedValidatorError("v.record()", "key");
    }
    if (value === undefined) {
      throwUndefinedValidatorError("v.record()", "value");
    }
    if (key.isOptional === "optional") {
      throw new Error("Record validator cannot have optional keys");
    }
    if (value.isOptional === "optional") {
      throw new Error("Record validator cannot have optional values");
    }
    if (!key.isConvexValidator || !value.isConvexValidator) {
      throw new Error("Key and value of v.record() must be validators");
    }
    this.key = key;
    this.value = value;
  }
  get json() {
    return {
      type: this.kind,
      keys: this.key.json,
      values: {
        fieldType: this.value.json,
        optional: false
      }
    };
  }
  optional() {
    return new VRecord({
      isOptional: "optional",
      key: this.key,
      value: this.value
    });
  }
  asOptional() {
    return this.optional();
  }
}

class VUnion extends BaseValidator {
  constructor({ isOptional, members }) {
    super({ isOptional });
    __publicField(this, "members");
    __publicField(this, "kind", "union");
    members.forEach((member, index) => {
      if (member === undefined) {
        throwUndefinedValidatorError("v.union()", `member at index ${index}`);
      }
      if (!member.isConvexValidator) {
        throw new Error("All members of v.union() must be validators");
      }
    });
    this.members = members;
  }
  get json() {
    return {
      type: this.kind,
      value: this.members.map((v) => v.json)
    };
  }
  optional() {
    return new VUnion({
      isOptional: "optional",
      members: this.members
    });
  }
  asOptional() {
    return this.optional();
  }
}

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/values/validator.js
function isValidator(v2) {
  return v2?.isConvexValidator === true;
}
function asObjectValidator(obj) {
  if (isValidator(obj)) {
    return obj;
  } else {
    return v.object(obj);
  }
}
var v = {
  id: (tableName) => {
    return new VId({
      isOptional: "required",
      tableName
    });
  },
  null: () => {
    return new VNull({ isOptional: "required" });
  },
  number: () => {
    return new VFloat64({ isOptional: "required" });
  },
  float64: () => {
    return new VFloat64({ isOptional: "required" });
  },
  bigint: () => {
    return new VInt64({ isOptional: "required" });
  },
  int64: () => {
    return new VInt64({ isOptional: "required" });
  },
  commitTs: () => {
    return new VCommitTs({ isOptional: "required" });
  },
  function: (signature) => {
    return new VFunction({
      isOptional: "required",
      fnType: signature?.fnType,
      args: signature?.args && asObjectValidator(signature.args),
      returns: signature?.returns && asObjectValidator(signature.returns)
    });
  },
  boolean: () => {
    return new VBoolean({ isOptional: "required" });
  },
  string: () => {
    return new VString({ isOptional: "required" });
  },
  bytes: () => {
    return new VBytes({ isOptional: "required" });
  },
  literal: (literal) => {
    return new VLiteral({ isOptional: "required", value: literal });
  },
  array: (element) => {
    return new VArray({ isOptional: "required", element });
  },
  object: (fields) => {
    return new VObject({ isOptional: "required", fields });
  },
  record: (keys, values) => {
    return new VRecord({
      isOptional: "required",
      key: keys,
      value: values
    });
  },
  union: (...members) => {
    return new VUnion({
      isOptional: "required",
      members
    });
  },
  any: () => {
    return new VAny({ isOptional: "required" });
  },
  optional: (value) => {
    return value.asOptional();
  },
  nullable: (value) => {
    return v.union(value, v.null());
  }
};
// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/functionName.js
var functionName = Symbol.for("functionName");

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/components/paths.js
var toReferencePath = Symbol.for("toReferencePath");

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/api.js
function makeFunctionReference(name) {
  return { [functionName]: name };
}
function createApi(pathParts = []) {
  const handler = {
    get(_, prop) {
      if (typeof prop === "string") {
        const newParts = [...pathParts, prop];
        return createApi(newParts);
      } else if (prop === functionName) {
        if (pathParts.length < 2) {
          const found = ["api", ...pathParts].join(".");
          throw new Error(`API path is expected to be of the form \`api.moduleName.functionName\`. Found: \`${found}\``);
        }
        const path = pathParts.slice(0, -1).join("/");
        const exportName = pathParts[pathParts.length - 1];
        if (exportName === "default") {
          return path;
        } else {
          return path + ":" + exportName;
        }
      } else if (prop === Symbol.toStringTag) {
        return "FunctionReference";
      } else {
        return;
      }
    }
  };
  return new Proxy({}, handler);
}
var anyApi = createApi();
// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/components/index.js
function createChildComponents(root, pathParts) {
  const handler = {
    get(_, prop) {
      if (typeof prop === "string") {
        const newParts = [...pathParts, prop];
        return createChildComponents(root, newParts);
      } else if (prop === toReferencePath) {
        if (pathParts.length < 1) {
          const found = [root, ...pathParts].join(".");
          throw new Error(`API path is expected to be of the form \`${root}.childComponent.functionName\`. Found: \`${found}\``);
        }
        return `_reference/childComponent/` + pathParts.join("/");
      } else {
        return;
      }
    }
  };
  return new Proxy({}, handler);
}
var componentsGeneric = () => createChildComponents("components", []);
// ../../packages/backend/src/notifications/contract.ts
var sessionNotificationKindValidator = v.union(v.literal("session_finished"), v.literal("session_approval"), v.literal("session_question"), v.literal("session_failed"));
var notificationCategoryValidator = v.union(v.literal("finished"), v.literal("attention"), v.literal("failed"), v.literal("limits"));
var categoryPreferenceValidator = v.object({
  enabled: v.boolean(),
  sound: v.boolean()
});
var notificationPreferencesValidator = v.object({
  finished: v.optional(categoryPreferenceValidator),
  attention: v.optional(categoryPreferenceValidator),
  failed: v.optional(categoryPreferenceValidator),
  limits: v.optional(categoryPreferenceValidator)
});
var resolvedNotificationPreferencesValidator = v.object({
  finished: categoryPreferenceValidator,
  attention: categoryPreferenceValidator,
  failed: categoryPreferenceValidator,
  limits: categoryPreferenceValidator
});
function notificationAad(userId, workspace, id) {
  return {
    table: "notifications",
    workspace: workspace ?? "",
    parent: userId,
    record: id,
    field: "content"
  };
}
var resumeNotificationSealingReference = makeFunctionReference("notifications:resumeSealing");

// ../../packages/backend/convex/_generated/api.js
var api = anyApi;
var components = componentsGeneric();

// ../../packages/backend/src/e2ee/legacy-contract.ts
var legacyBoxValidator = v.object({
  kind: v.union(v.literal("identity"), v.literal("workspace_member"), v.literal("workspace_owner"), v.literal("chat"), v.literal("custody")),
  keyId: v.string(),
  epoch: v.number(),
  box: v.bytes(),
  storageId: v.optional(v.id("_storage"))
});
function legacyAad(table, record, workspace) {
  return { workspace: workspace ?? "", parent: "legacy-v1", table, record, field: "legacy" };
}

// src/lib/crypto/account-keys.ts
function wipeAccount(account) {
  account.amk.fill(0);
  account.identity.encryption.seed.fill(0);
  account.identity.signing.seed.fill(0);
}
function copyAccount(account) {
  const { identity } = account;
  return {
    amk: account.amk.slice(),
    identity: {
      ...identity,
      keyId: identity.keyId.slice(),
      encryption: { ...identity.encryption, seed: identity.encryption.seed.slice() },
      signing: { ...identity.signing, seed: identity.signing.seed.slice() }
    }
  };
}

// src/lib/crypto/key-manager.ts
class KeysLockedError extends Error {
  constructor() {
    super("Encryption keys are locked on this device");
    this.name = "KeysLockedError";
  }
}
var DEFAULT_POLICY = { requirePassword: false, autoLockMinutes: null };
var ACTIVITY_THROTTLE_MS = 20000;
var SECRET_PART_BYTES = 32;
function deviceAad(userId, keyId) {
  const aad = buildAad({
    table: LABELS.deviceWrap,
    workspace: "",
    parent: userId,
    record: keyId,
    field: "keys"
  });
  return new Uint8Array(aad);
}
function parseBlob(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null)
      return null;
    const blob = value;
    if (blob.v !== 1 || typeof blob.userId !== "string" || typeof blob.keyId !== "string" || typeof blob.suite !== "number" || typeof blob.nonce !== "string" || typeof blob.ciphertext !== "string" || typeof blob.lastActivity !== "number") {
      return null;
    }
    return blob;
  } catch {
    return null;
  }
}
function withActivity(text, lastActivity) {
  const blob = parseBlob(text);
  if (!blob)
    return text;
  return JSON.stringify({ ...blob, lastActivity });
}
async function sealBlob(input) {
  const { identity } = input.keys;
  const keyId = toBase64Url(identity.keyId);
  const plaintext = new Uint8Array(SECRET_PART_BYTES * 3);
  plaintext.set(input.keys.amk, 0);
  plaintext.set(identity.encryption.seed, SECRET_PART_BYTES);
  plaintext.set(identity.signing.seed, SECRET_PART_BYTES * 2);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: deviceAad(input.userId, keyId) }, input.wrappingKey, plaintext);
  plaintext.fill(0);
  const blob = {
    v: 1,
    userId: input.userId,
    keyId,
    suite: identity.suite,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    lastActivity: input.lastActivity
  };
  return JSON.stringify(blob);
}
async function openBlob(wrappingKey, blob) {
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: new Uint8Array(fromBase64Url(blob.nonce)),
    additionalData: deviceAad(blob.userId, blob.keyId)
  }, wrappingKey, new Uint8Array(fromBase64Url(blob.ciphertext))));
  if (plaintext.length !== SECRET_PART_BYTES * 3)
    throw new Error("Malformed device blob");
  const amk = plaintext.slice(0, SECRET_PART_BYTES);
  const encryptionSeed = plaintext.slice(SECRET_PART_BYTES, SECRET_PART_BYTES * 2);
  const signingSeed = plaintext.slice(SECRET_PART_BYTES * 2);
  plaintext.fill(0);
  const identity = {
    keyId: fromBase64Url(blob.keyId),
    suite: blob.suite,
    encryption: {
      suite: blob.suite,
      seed: encryptionSeed,
      publicKey: await encryptionPublicKeyFromSeed(encryptionSeed)
    },
    signing: {
      suite: blob.suite,
      seed: signingSeed,
      publicKey: await signingPublicKeyFromSeed(signingSeed)
    }
  };
  return { amk, identity };
}
function createKeyManager(deps) {
  let status = { state: "signed-out" };
  const listeners = new Set;
  let attachedUserId = null;
  let unlocked = null;
  let lastActivity = deps.now();
  let lastActivityShared = 0;
  let generation = 0;
  let pendingHandOff = null;
  function setStatus(next) {
    status = next;
    for (const listener of listeners)
      listener();
  }
  function lockedStatus() {
    return attachedUserId ? { state: "locked", userId: attachedUserId } : { state: "signed-out" };
  }
  function getDevicePolicy(userId) {
    return deps.policies.get(userId) ?? DEFAULT_POLICY;
  }
  async function persist(record, blob, policy) {
    if (policy.requirePassword) {
      await deps.devices.put({ userId: record.userId, wrappingKey: record.wrappingKey });
      deps.tabBlobs.set(record.userId, blob);
    } else {
      await deps.devices.put({ userId: record.userId, wrappingKey: record.wrappingKey, blob, autoLockMinutes: policy.autoLockMinutes });
      deps.tabBlobs.delete(record.userId);
    }
  }
  async function commitUnlocked(userId, keys, blob, current) {
    const print = await fingerprint({
      encryptionPublicKey: keys.identity.encryption.publicKey,
      signingPublicKey: keys.identity.signing.publicKey
    });
    if (current !== generation || attachedUserId !== userId) {
      wipeAccount(keys);
      return;
    }
    const keyId = toBase64Url(keys.identity.keyId);
    if (unlocked?.userId === userId && unlocked.keyId === keyId && equalBytes(unlocked.amk, keys.amk)) {
      wipeAccount(keys);
      unlocked.blob = blob;
    } else {
      if (unlocked)
        wipeAccount(unlocked);
      unlocked = { ...keys, userId, keyId, fingerprint: print, blob };
    }
    lastActivity = deps.now();
    setStatus({ state: "unlocked", userId, keyId, fingerprint: print });
  }
  function dropLocal(userId) {
    if (unlocked?.userId === userId) {
      wipeAccount(unlocked);
      unlocked = null;
    }
    deps.tabBlobs.delete(userId);
  }
  async function tryOpen(userId, blobText) {
    const blob = parseBlob(blobText);
    if (!blob || blob.userId !== userId)
      return null;
    const { autoLockMinutes } = getDevicePolicy(userId);
    if (autoLockMinutes !== null && deps.now() - blob.lastActivity > autoLockMinutes * 60000) {
      return null;
    }
    const record = await deps.devices.get(userId);
    if (!record)
      return null;
    try {
      return await openBlob(record.wrappingKey, blob);
    } catch {
      return null;
    }
  }
  function requestHandOff(userId) {
    const channel = deps.channel;
    if (!channel)
      return Promise.resolve(null);
    pendingHandOff?.resolve(null);
    const { promise, resolve } = Promise.withResolvers();
    const finish = (blob) => {
      clearTimeout(timer);
      if (pendingHandOff?.resolve === finish)
        pendingHandOff = null;
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), deps.handOffTimeoutMs);
    pendingHandOff = { userId, resolve: finish };
    channel.post({ type: "request", userId });
    return promise;
  }
  async function restore(userId, current) {
    const policy = getDevicePolicy(userId);
    let blobText = policy.requirePassword ? deps.tabBlobs.get(userId) : (await deps.devices.get(userId))?.blob ?? null;
    let opened = blobText ? await tryOpen(userId, blobText) : null;
    if (!opened && policy.requirePassword && current === generation) {
      deps.tabBlobs.delete(userId);
      blobText = await requestHandOff(userId);
      opened = blobText ? await tryOpen(userId, blobText) : null;
    }
    if (current !== generation) {
      if (opened)
        wipeAccount(opened);
      return;
    }
    if (!opened || !blobText) {
      if (!policy.requirePassword) {
        const record = await deps.devices.get(userId);
        if (record?.blob)
          await deps.devices.put({ userId, wrappingKey: record.wrappingKey });
      }
      if (current === generation)
        setStatus({ state: "locked", userId });
      return;
    }
    if (policy.requirePassword)
      deps.tabBlobs.set(userId, blobText);
    await commitUnlocked(userId, opened, blobText, current);
  }
  async function handleMessage(message) {
    if (message.type === "blob" && pendingHandOff?.userId === message.userId) {
      pendingHandOff.resolve(message.blob);
      return;
    }
    if (message.userId !== attachedUserId)
      return;
    switch (message.type) {
      case "request": {
        if (unlocked?.userId === message.userId) {
          deps.channel?.post({ type: "blob", userId: message.userId, blob: unlocked.blob });
        }
        return;
      }
      case "heartbeat": {
        lastActivity = Math.max(lastActivity, message.at);
        return;
      }
      case "lock": {
        generation += 1;
        dropLocal(message.userId);
        setStatus(lockedStatus());
        return;
      }
      case "blob": {
        const current = ++generation;
        const opened = await tryOpen(message.userId, message.blob);
        if (!opened)
          return;
        if (getDevicePolicy(message.userId).requirePassword && current === generation) {
          deps.tabBlobs.set(message.userId, message.blob);
        }
        await commitUnlocked(message.userId, opened, message.blob, current);
        return;
      }
    }
  }
  const unsubscribeChannel = deps.channel?.subscribe((message) => {
    handleMessage(message);
  });
  async function lockUser(userId) {
    generation += 1;
    dropLocal(userId);
    await deps.devices.delete(userId);
    deps.channel?.post({ type: "lock", userId });
  }
  async function forget(userId) {
    await lockUser(userId);
    deps.policies.delete(userId);
    if (attachedUserId === userId)
      attachedUserId = null;
    setStatus(lockedStatus());
  }
  async function lock() {
    const userId = attachedUserId ?? unlocked?.userId;
    if (!userId)
      return;
    await lockUser(userId);
    setStatus(lockedStatus());
  }
  return {
    getSnapshot: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async attachSession(user, hasKeys) {
      const userId = user?.id ?? null;
      const previous = attachedUserId;
      if (previous !== null && previous !== userId)
        await forget(previous);
      attachedUserId = userId;
      if (userId === null) {
        generation += 1;
        setStatus({ state: "signed-out" });
        return;
      }
      await deps.devices.deleteOthers(userId);
      if (!hasKeys) {
        generation += 1;
        dropLocal(userId);
        await deps.devices.delete(userId);
        setStatus({ state: "no-keys" });
        return;
      }
      if (unlocked?.userId === userId) {
        if (status.state !== "unlocked") {
          const { keyId, fingerprint: print } = unlocked;
          setStatus({ state: "unlocked", userId, keyId, fingerprint: print });
        }
        return;
      }
      const current = ++generation;
      await restore(userId, current);
    },
    async unlock(input) {
      if (attachedUserId !== null && attachedUserId !== input.userId) {
        await forget(attachedUserId);
      }
      attachedUserId = input.userId;
      const current = ++generation;
      const keys = copyAccount({ amk: input.amk, identity: input.identity });
      const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt"
      ]);
      const blob = await sealBlob({
        wrappingKey,
        userId: input.userId,
        keys,
        lastActivity: deps.now()
      });
      await persist({ userId: input.userId, wrappingKey }, blob, getDevicePolicy(input.userId));
      await commitUnlocked(input.userId, keys, blob, current);
      deps.channel?.post({ type: "blob", userId: input.userId, blob });
    },
    lock,
    forget,
    async useAmk(fn) {
      if (!unlocked)
        throw new KeysLockedError;
      return fn(unlocked.amk, unlocked.identity);
    },
    getDevicePolicy,
    async setDevicePolicy(userId, policy) {
      deps.policies.set(userId, policy);
      const record = await deps.devices.get(userId);
      if (!record)
        return;
      if (unlocked?.userId !== userId) {
        if (policy.requirePassword) {
          await deps.devices.put({ userId, wrappingKey: record.wrappingKey });
        } else if (record.blob) {
          await deps.devices.put({ ...record, autoLockMinutes: policy.autoLockMinutes });
        }
        return;
      }
      unlocked.blob = withActivity(unlocked.blob, lastActivity);
      await persist(record, unlocked.blob, policy);
      deps.channel?.post({ type: "blob", userId, blob: unlocked.blob });
    },
    async noteActivity() {
      const now = deps.now();
      lastActivity = now;
      if (!unlocked || now - lastActivityShared < ACTIVITY_THROTTLE_MS)
        return;
      lastActivityShared = now;
      const current = unlocked;
      const currentGeneration = generation;
      const { userId } = current;
      deps.channel?.post({ type: "heartbeat", userId, at: now });
      current.blob = withActivity(current.blob, now);
      if (getDevicePolicy(userId).requirePassword) {
        deps.tabBlobs.set(userId, current.blob);
        return;
      }
      const record = await deps.devices.get(userId);
      const policy = getDevicePolicy(userId);
      if (record && unlocked === current && generation === currentGeneration && !policy.requirePassword) {
        await deps.devices.put({ ...record, blob: current.blob, autoLockMinutes: policy.autoLockMinutes });
      }
    },
    async checkIdle() {
      if (!unlocked)
        return;
      const { autoLockMinutes } = getDevicePolicy(unlocked.userId);
      if (autoLockMinutes === null)
        return;
      if (deps.now() - lastActivity > autoLockMinutes * 60000)
        await lock();
    },
    dispose() {
      unsubscribeChannel?.();
      if (unlocked)
        wipeAccount(unlocked);
      unlocked = null;
    }
  };
}
var DB_NAME = "radium-keys";
var DB_STORE = "devices";
var TAB_BLOB_PREFIX = "radium.keys.blob.v1:";
var POLICY_PREFIX = "radium.keys.policy.v1:";
function requestResult(request) {
  const { promise, resolve, reject } = Promise.withResolvers();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}
function indexedDbDeviceStore() {
  let database = null;
  async function objectStore(mode) {
    if (!database) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DB_STORE, { keyPath: "userId" });
      };
      database = requestResult(request);
    }
    return (await database).transaction(DB_STORE, mode).objectStore(DB_STORE);
  }
  return {
    async get(userId) {
      const store = await objectStore("readonly");
      return await requestResult(store.get(userId));
    },
    async put(record) {
      await requestResult((await objectStore("readwrite")).put(record));
    },
    async delete(userId) {
      await requestResult((await objectStore("readwrite")).delete(userId));
    },
    async deleteOthers(userId) {
      const store = await objectStore("readwrite");
      const keys = await requestResult(store.getAllKeys());
      for (const key of keys) {
        if (key !== userId)
          await requestResult(store.delete(key));
      }
    }
  };
}
async function useRememberedIdentity(userId, keyId, fn) {
  const devices = indexedDbDeviceStore();
  const record = await devices.get(userId);
  if (!record?.blob || record.autoLockMinutes === undefined)
    throw new KeysLockedError;
  const blob = parseBlob(record.blob);
  if (!blob || blob.userId !== userId || blob.keyId !== keyId || record.autoLockMinutes !== null && Date.now() - blob.lastActivity > record.autoLockMinutes * 60000) {
    throw new KeysLockedError;
  }
  const keys = await openBlob(record.wrappingKey, blob);
  try {
    const result = await fn(keys.identity);
    const current = await devices.get(userId);
    if (!current || current.blob !== record.blob || current.autoLockMinutes !== record.autoLockMinutes) {
      throw new KeysLockedError;
    }
    return result;
  } finally {
    wipeAccount(keys);
  }
}
function webStorage(storage, prefix) {
  return {
    get(userId) {
      try {
        const value = storage().getItem(prefix + userId);
        return value === null ? null : JSON.parse(value);
      } catch {
        return null;
      }
    },
    set(userId, value) {
      try {
        storage().setItem(prefix + userId, JSON.stringify(value));
      } catch {}
    },
    delete(userId) {
      try {
        storage().removeItem(prefix + userId);
      } catch {}
    }
  };
}
function parsePolicy(value) {
  if (typeof value !== "object" || value === null)
    return null;
  const policy = value;
  const minutes = policy.autoLockMinutes;
  if (typeof policy.requirePassword !== "boolean")
    return null;
  if (minutes !== null && (typeof minutes !== "number" || !(minutes > 0)))
    return null;
  return { requirePassword: policy.requirePassword, autoLockMinutes: minutes };
}
function isChannelMessage(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const message = value;
  if (typeof message.userId !== "string")
    return false;
  switch (message.type) {
    case "request":
    case "lock":
      return true;
    case "blob":
      return typeof message.blob === "string";
    case "heartbeat":
      return typeof message.at === "number";
    default:
      return false;
  }
}
function browserChannel() {
  if (typeof BroadcastChannel === "undefined")
    return null;
  const channel = new BroadcastChannel("radium-keys");
  return {
    post(message) {
      channel.postMessage(message);
    },
    subscribe(handler) {
      const listener = (event) => {
        if (isChannelMessage(event.data))
          handler(event.data);
      };
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    }
  };
}
function createBrowserKeyManager() {
  const tabBlobs = webStorage(() => sessionStorage, TAB_BLOB_PREFIX);
  const policies = webStorage(() => localStorage, POLICY_PREFIX);
  const manager = createKeyManager({
    devices: indexedDbDeviceStore(),
    tabBlobs: {
      get: (userId) => {
        const blob = tabBlobs.get(userId);
        return typeof blob === "string" ? blob : null;
      },
      set: tabBlobs.set,
      delete: tabBlobs.delete
    },
    policies: {
      get: (userId) => parsePolicy(policies.get(userId)),
      set: policies.set,
      delete: policies.delete
    },
    channel: browserChannel(),
    now: () => Date.now(),
    handOffTimeoutMs: 400
  });
  manager.subscribe(() => {
    if (manager.getSnapshot().state === "unlocked" || !("serviceWorker" in navigator))
      return;
    navigator.serviceWorker.getRegistration("/").then(async (registration) => {
      const notifications = await registration?.getNotifications();
      for (const notification of notifications ?? [])
        notification.close();
    }).catch(() => {});
  });
  const onActivity = () => void manager.noteActivity();
  for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(event, onActivity, { passive: true });
  }
  setInterval(() => void manager.checkIdle(), 15000);
  return manager;
}
var browserManager = null;
var SIGNED_OUT = { state: "signed-out" };
function browser() {
  if (typeof window === "undefined" || typeof indexedDB === "undefined")
    return null;
  browserManager ??= createBrowserKeyManager();
  return browserManager;
}
var keyManager = {
  getSnapshot: () => browser()?.getSnapshot() ?? SIGNED_OUT,
  subscribe: (listener) => browser()?.subscribe(listener) ?? (() => {}),
  attachSession: async (user, hasKeys) => browser()?.attachSession(user, hasKeys),
  unlock: async (input) => {
    const manager = browser();
    if (!manager)
      throw new KeysLockedError;
    return manager.unlock(input);
  },
  lock: async () => browser()?.lock(),
  forget: async (userId) => browser()?.forget(userId),
  useAmk: async (fn) => {
    const manager = browser();
    if (!manager)
      throw new KeysLockedError;
    return manager.useAmk(fn);
  },
  getDevicePolicy: (userId) => browser()?.getDevicePolicy(userId) ?? DEFAULT_POLICY,
  setDevicePolicy: async (userId, policy) => browser()?.setDevicePolicy(userId, policy),
  noteActivity: async () => browser()?.noteActivity(),
  checkIdle: async () => browser()?.checkIdle(),
  dispose: () => browser()?.dispose()
};

// src/lib/crypto/runtime.ts
var client = null;
var clearers = new Set;
var generation = 0;
function cryptoClient() {
  if (!client)
    throw new CryptoError("BAD_INPUT", "Encryption client is not mounted");
  return client;
}
function currentUserId() {
  const status = keyManager.getSnapshot();
  if (!("userId" in status))
    throw new KeysLockedError;
  return status.userId;
}
function onSecretsCleared(clear) {
  clearers.add(clear);
}
function secretGeneration() {
  return generation;
}
function bytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
function buffer(value) {
  return value.slice().buffer;
}
function highWater(name) {
  try {
    const n = Number(localStorage.getItem(name));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
function advanceHighWater(name, value) {
  try {
    localStorage.setItem(name, String(Math.max(highWater(name), value)));
  } catch {}
}

// src/lib/crypto/public-keys.ts
function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(`radium.e2ee.pub.v1:${currentUserId()}`) ?? "null");
    return value && typeof value.workspaces === "object" ? value : { workspaces: {} };
  } catch {
    return { workspaces: {} };
  }
}
function writeCache(cache) {
  if (keyManager.getSnapshot().state !== "unlocked")
    throw new KeysLockedError;
  try {
    localStorage.setItem(`radium.e2ee.pub.v1:${currentUserId()}`, JSON.stringify(cache));
  } catch {}
}
async function fetchIdentities(userIds) {
  const result = new Map;
  const unique = [...new Set(userIds)];
  for (let start = 0;start < unique.length; start += 200) {
    const rows = await cryptoClient().query(api.e2ee.identityKeys, {
      userIds: unique.slice(start, start + 200)
    });
    for (const row of rows) {
      if (!row)
        continue;
      const identity = await verifyPublicIdentity(row);
      result.set(row.userId, identity);
    }
  }
  return result;
}
async function verifyPublicIdentity(row) {
  const identity = {
    userId: row.userId,
    keyId: row.keyId,
    suite: row.suite,
    encryptionPublicKey: bytes(row.encryptionPublicKey),
    signingPublicKey: bytes(row.signingPublicKey),
    selfSignature: bytes(row.selfSignature)
  };
  const valid = await verifyIdentitySelfSignature({
    keyId: fromBase64Url(row.keyId),
    suite: row.suite,
    encryptionPublicKey: identity.encryptionPublicKey,
    signingPublicKey: identity.signingPublicKey,
    signature: identity.selfSignature
  });
  if (fromBase64Url(row.keyId).length !== 16 || !valid) {
    throw new CryptoError("DECRYPT_FAILED", "Identity signature failed");
  }
  return { ...identity, fingerprint: await fingerprint(identity), status: row.status };
}
async function fetchHistoricalIdentities(keyIds, chatId) {
  const result = new Map;
  const unique = [...new Set(keyIds)];
  for (let start = 0;start < unique.length; start += 200) {
    const rows = await cryptoClient().query(api.e2ee.identityKeysByKeyId, {
      keyIds: unique.slice(start, start + 200),
      chatId
    });
    for (const row of rows) {
      if (!row)
        continue;
      result.set(row.keyId, await verifyPublicIdentity(row));
    }
  }
  return result;
}
function cacheWorkspacePublicKey(workspaceId, key) {
  const cache = readCache();
  cache.workspaces[workspaceId] = {
    epoch: key.epoch,
    memberKeyId: key.keyId,
    memberPublicKey: toBase64Url(key.publicKey)
  };
  writeCache(cache);
}

// src/lib/crypto/trust-store.ts
var listeners = new Set;
var store = null;
var owner = null;
var status = "locked";
var loading = null;
function emit() {
  for (const listener of listeners)
    listener();
}
onSecretsCleared(() => {
  store = null;
  owner = null;
  status = "locked";
  loading = null;
  emit();
});
var aad = (userId, version) => ({
  table: "e2ee_trust_stores",
  workspace: "",
  parent: userId,
  record: String(version),
  field: "pins"
});
async function sealTrustStore(input) {
  const key = await hkdf(input.amk, LABELS.trustStore);
  try {
    return await sealSym({
      key,
      keyRef: fromBase64Url(input.keyId),
      plaintext: utf8(JSON.stringify(input.store)),
      aad: aad(input.userId, input.store.version),
      pad: "content"
    });
  } finally {
    key.fill(0);
  }
}
async function openTrustStore(input) {
  if (input.version < input.highWater)
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback detected");
  if (!equalBytes(decodeEnvelope(input.envelope).keyRef, fromBase64Url(input.keyId)))
    throw new CryptoError("DECRYPT_FAILED", "Trust store identity mismatch");
  const key = await hkdf(input.amk, LABELS.trustStore);
  let plaintext;
  try {
    plaintext = await openSym({
      key,
      envelope: input.envelope,
      aad: aad(input.userId, input.version),
      pad: "content"
    });
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (parsed.v !== 1 || parsed.version !== input.version || !parsed.pins || Array.isArray(parsed.pins) || typeof parsed.pins !== "object")
      throw new CryptoError("BAD_ENVELOPE", "Invalid trust store");
    for (const pin of Object.values(parsed.pins)) {
      if (!pin || typeof pin.keyId !== "string" || fromBase64Url(pin.keyId).length !== 16 || typeof pin.fingerprint !== "string" || !["tofu", "verified"].includes(pin.state) || !Number.isFinite(pin.updatedAt))
        throw new CryptoError("BAD_ENVELOPE", "Invalid trust pin");
    }
    return parsed;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
async function load(force = false) {
  const userId = currentUserId();
  if (!force && store && owner === userId)
    return;
  if (loading)
    return loading;
  loading = keyManager.useAmk(async (amk, identity) => {
    const row = await cryptoClient().query(api.e2ee.getTrustStore, {});
    const marker = `radium.e2ee.trust.v1:${userId}`;
    if ((row?.version ?? 0) < highWater(marker)) {
      status = "rollback";
      store = null;
      emit();
      throw new CryptoError("DECRYPT_FAILED", "Trust store rollback detected");
    }
    const next = row ? await openTrustStore({
      amk,
      keyId: toBase64Url(identity.keyId),
      userId,
      version: row.version,
      envelope: bytes(row.envelope),
      highWater: highWater(marker)
    }) : { v: 1, version: 0, pins: {} };
    if (keyManager.getSnapshot().state !== "unlocked" || currentUserId() !== userId)
      throw new CryptoError("DECRYPT_FAILED", "Keys locked during trust sync");
    store = next;
    owner = userId;
    status = "ready";
    advanceHighWater(marker, next.version);
    emit();
  }).finally(() => {
    loading = null;
  });
  return loading;
}
var trust = {
  load,
  getSnapshot: () => status,
  pinnedFingerprint(userId) {
    return store?.pins[userId]?.fingerprint ?? null;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async check(userId, identity) {
    await load();
    const digest = await fingerprint(identity);
    if (digest !== identity.fingerprint)
      throw new CryptoError("DECRYPT_FAILED", "Identity fingerprint mismatch");
    if (userId === currentUserId()) {
      return keyManager.useAmk(async (_, own) => equalBytes(own.encryption.publicKey, identity.encryptionPublicKey) && equalBytes(own.signing.publicKey, identity.signingPublicKey) ? "self" : "changed");
    }
    const pin = store?.pins[userId];
    if (!pin)
      return "first-contact";
    if (pin.keyId !== identity.keyId || pin.fingerprint !== digest)
      return "changed";
    return pin.state;
  },
  async pin(userId, identity, state) {
    for (let attempt = 0;attempt < 5; attempt++) {
      await load(attempt > 0);
      if (status !== "ready" || !store)
        throw new CryptoError("DECRYPT_FAILED", "Trust store unavailable");
      const expectedVersion = store.version || null;
      const next = {
        v: 1,
        version: store.version + 1,
        pins: {
          ...store.pins,
          [userId]: {
            keyId: identity.keyId,
            fingerprint: await fingerprint(identity),
            state,
            updatedAt: Date.now()
          }
        }
      };
      try {
        await keyManager.useAmk(async (amk, own) => {
          const envelope = await sealTrustStore({
            amk,
            keyId: toBase64Url(own.keyId),
            userId: currentUserId(),
            store: next
          });
          await cryptoClient().mutation(api.e2ee.saveTrustStore, {
            expectedVersion,
            version: next.version,
            envelope: buffer(envelope)
          });
        });
        if (keyManager.getSnapshot().state !== "unlocked")
          throw new CryptoError("DECRYPT_FAILED", "Keys locked during trust update");
        store = next;
        advanceHighWater(`radium.e2ee.trust.v1:${currentUserId()}`, next.version);
        emit();
        return;
      } catch (error) {
        const data = error && typeof error === "object" && "data" in error ? error.data : null;
        if (!data || typeof data !== "object" || !("code" in data) || data.code !== "TRUST_STORE_CONFLICT")
          throw error;
      }
    }
    throw new CryptoError("BAD_INPUT", "Trust store changed concurrently; try again");
  }
};

// src/lib/crypto/trust-requests.ts
var queue = [];
var listeners2 = new Set;
function emit2() {
  for (const listener of listeners2)
    listener();
}
onSecretsCleared(() => {
  for (const pending of queue)
    pending.reject(new CryptoError("DECRYPT_FAILED", "Key exchange cancelled by lock"));
  queue.length = 0;
  emit2();
});
async function requestIdentityTrust(identity, trustState) {
  let pending = queue.find((entry) => entry.identity.userId === identity.userId && entry.identity.keyId === identity.keyId && entry.identity.fingerprint === identity.fingerprint);
  if (!pending) {
    const deferred = Promise.withResolvers();
    pending = { identity, trustState, ...deferred };
    queue.push(pending);
    emit2();
  }
  await pending.promise;
  const accepted = await trust.check(identity.userId, identity);
  if (accepted !== "self" && accepted !== "tofu" && accepted !== "verified") {
    throw new CryptoError("DECRYPT_FAILED", "Identity approval failed");
  }
}

// src/lib/crypto/workspace-proofs.ts
async function openWorkspaceGrant(input) {
  if (!await verify(input.granter.signingPublicKey, grantStatement({
    workspaceId: input.workspaceId,
    epoch: input.epoch,
    purpose: input.purpose,
    recipientUserId: input.userId,
    recipientKeyId: input.recipientKeyId,
    sealed: input.sealed
  }), input.signature))
    throw new CryptoError("DECRYPT_FAILED", "Grant signature failed");
  const seed = await openBox({
    seed: input.recipientSeed,
    box: input.sealed,
    aad: {
      table: "e2ee_workspace_grants",
      workspace: input.workspaceId,
      parent: input.userId,
      record: `${input.epoch}:${input.purpose}`,
      field: input.recipientKeyId
    },
    pad: "none"
  });
  if (seed.length !== 32 || !equalBytes(await encryptionPublicKeyFromSeed(seed), input.epochPublicKey) || toBase64Url(await sha2562(input.epochPublicKey)) !== input.rosterKeyHash) {
    seed.fill(0);
    throw new CryptoError("DECRYPT_FAILED", "Grant key differs from roster");
  }
  return seed;
}

// src/lib/crypto/workspace-keys.ts
var ring = new Map;
var verifiedStates = new Map;
var stateLoads = new Map;
var cacheKey = (workspaceId, epoch, purpose) => `${workspaceId}:${epoch}:${purpose}`;
onSecretsCleared(() => {
  for (const key of ring.values())
    key.seed.fill(0);
  ring.clear();
  verifiedStates.clear();
  stateLoads.clear();
});
trust.subscribe(() => {
  verifiedStates.clear();
  stateLoads.clear();
});

class TrustRequiredError extends Error {
  identity;
  trustState;
  constructor(identity, trustState) {
    super(trustState === "changed" ? "Identity key changed; approval required" : "Approve this identity before exchanging keys");
    this.identity = identity;
    this.trustState = trustState;
    this.name = "TrustRequiredError";
  }
}
async function requireTrust(identity) {
  const state = await trust.check(identity.userId, identity);
  if (state === "first-contact" || state === "changed") {
    await requestIdentityTrust(identity, state);
  }
}
var rosterMarker = (workspaceId) => `radium.e2ee.roster.v1:${workspaceId}`;
function verifyWorkspaceState(workspaceId) {
  const pending = stateLoads.get(workspaceId);
  if (pending)
    return pending;
  const load = (async () => {
    const state = await cryptoClient().query(api.e2ee.workspaceKeyState, {
      workspace: workspaceId
    });
    const key = JSON.stringify(state, (_, value) => value instanceof ArrayBuffer ? toBase64Url(bytes(value)) : value);
    const cached = verifiedStates.get(workspaceId);
    if (cached?.key === key)
      return cached.promise;
    const promise = verifyState(workspaceId, state);
    verifiedStates.set(workspaceId, { key, promise });
    try {
      return await promise;
    } catch (error) {
      verifiedStates.delete(workspaceId);
      throw error;
    }
  })().finally(() => stateLoads.delete(workspaceId));
  stateLoads.set(workspaceId, load);
  return load;
}
async function verifyState(workspaceId, state) {
  const generation = secretGeneration();
  const identities = await fetchIdentities([
    state.ownerId,
    currentUserId(),
    ...state.members.map((member) => member.userId),
    ...state.myGrants.map((grant) => grant.granterUserId)
  ]);
  const owner = identities.get(state.ownerId);
  if (!owner || !state.roster || !state.keyEpoch)
    throw new CryptoError("DECRYPT_FAILED", "Workspace roster missing");
  await requireTrust(owner);
  const marker = rosterMarker(workspaceId);
  let roster = state.roster;
  if (roster.signerKeyId !== owner.keyId && state.ownerId === currentUserId()) {
    const historical = (await fetchHistoricalIdentities([roster.signerKeyId])).get(roster.signerKeyId);
    if (!historical || historical.status !== "retired" || historical.userId !== state.ownerId) {
      throw new CryptoError("DECRYPT_FAILED", "Historical roster owner unavailable");
    }
    const previous = await verifyRoster({
      workspaceId,
      ...roster,
      body: bytes(roster.body),
      signature: bytes(roster.signature),
      owner: historical,
      highWater: highWater(marker)
    });
    const resigned = await wireRoster({
      ...previous,
      version: previous.version + 1,
      owner: memberBinding(owner)
    });
    await cryptoClient().mutation(api.e2ee.publishRoster, {
      workspace: workspaceId,
      roster: resigned
    });
    roster = { ...roster, ...resigned };
  }
  const verifiedRoster = await verifyRoster({
    workspaceId,
    version: roster.version,
    signerKeyId: roster.signerKeyId,
    body: bytes(roster.body),
    signature: bytes(roster.signature),
    owner,
    highWater: highWater(marker)
  });
  if (verifiedRoster.epoch !== state.keyEpoch || state.epochs.length !== verifiedRoster.epochs.length)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch rollback or substitution");
  for (const epoch of state.epochs) {
    const entry = verifiedRoster.epochs.find((row) => row.epoch === epoch.epoch);
    if (!entry || entry.memberKeyId !== epoch.memberKeyId || entry.ownerKeyId !== epoch.ownerKeyId || entry.memberKeyHash !== toBase64Url(await sha2562(bytes(epoch.memberPublicKey))) || entry.ownerKeyHash !== toBase64Url(await sha2562(bytes(epoch.ownerPublicKey))))
      throw new CryptoError("DECRYPT_FAILED", "Workspace epoch differs from signed roster");
  }
  if (secretGeneration() !== generation) {
    throw new KeysLockedError;
  }
  advanceHighWater(marker, verifiedRoster.version);
  const latest = state.epochs.find((epoch) => epoch.epoch === state.keyEpoch);
  cacheWorkspacePublicKey(workspaceId, {
    epoch: latest.epoch,
    keyId: latest.memberKeyId,
    publicKey: bytes(latest.memberPublicKey)
  });
  return { ...state, identities, verifiedRoster };
}
async function trustedIdentity(workspaceId, userId, allowPinnedCreator = false) {
  const state = await verifyWorkspaceState(workspaceId);
  const identity = state.identities.get(userId);
  if (!identity)
    throw new CryptoError("DECRYPT_FAILED", "Identity unavailable");
  if (userId === currentUserId() || userId === state.ownerId || allowPinnedCreator) {
    await requireTrust(identity);
    return identity;
  }
  const pinState = await trust.check(userId, identity);
  if (pinState === "changed") {
    await requestIdentityTrust(identity, "changed");
    return identity;
  }
  if (pinState === "tofu" || pinState === "verified") {
    return identity;
  }
  const member = state.verifiedRoster.members.find((entry) => entry.userId === userId && entry.keyId === identity.keyId && entry.fingerprint === identity.fingerprint);
  if (!member) {
    await requestIdentityTrust(identity, "first-contact");
  }
  return identity;
}
async function getWorkspaceKey(workspaceId, epoch, purpose) {
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks key access");
  }
  if (keyManager.getSnapshot().state !== "unlocked")
    throw new KeysLockedError;
  const cached = ring.get(cacheKey(workspaceId, epoch, purpose));
  if (cached)
    return cached;
  const generation = secretGeneration();
  const state = await verifyWorkspaceState(workspaceId);
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  const rosterEpoch = state.verifiedRoster.epochs.find((entry) => entry.epoch === epoch);
  if (!row || !rosterEpoch)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  return keyManager.useAmk(async (_, own) => {
    const recipientKeyId = toBase64Url(own.keyId);
    const grant = state.myGrants.find((entry) => entry.epoch === epoch && entry.purpose === purpose && entry.recipientKeyId === recipientKeyId);
    if (!grant)
      throw new CryptoError("DECRYPT_FAILED", "Workspace key not granted");
    let granter = state.identities.get(grant.granterUserId);
    const retired = granter?.keyId !== grant.granterKeyId;
    if (retired) {
      granter = (await fetchHistoricalIdentities([grant.granterKeyId])).get(grant.granterKeyId);
      const endorsedUser = grant.granterUserId === state.ownerId || state.verifiedRoster.members.some((member) => member.userId === grant.granterUserId);
      if (!granter || granter.status !== "retired" || granter.userId !== grant.granterUserId || !endorsedUser || purpose === "owner" && granter.userId !== state.ownerId) {
        throw new CryptoError("DECRYPT_FAILED", "Historical grant signer not authorized");
      }
    }
    if (!granter || granter.keyId !== grant.granterKeyId) {
      throw new CryptoError("DECRYPT_FAILED", "Grant signer unavailable");
    }
    if (!retired) {
      if (granter.userId === currentUserId() || granter.userId === state.ownerId) {
        await requireTrust(granter);
      } else {
        const entry = state.verifiedRoster.members.find((member) => member.userId === granter.userId && member.keyId === granter.keyId && member.fingerprint === granter.fingerprint);
        if (!entry || purpose === "owner") {
          throw new CryptoError("DECRYPT_FAILED", "Grant signer not authorized by roster");
        }
        if (await trust.check(granter.userId, granter) === "changed") {
          await requestIdentityTrust(granter, "changed");
        }
      }
    }
    const publicKey = bytes(purpose === "member" ? row.memberPublicKey : row.ownerPublicKey);
    const seed = await openWorkspaceGrant({
      workspaceId,
      ...grant,
      sealed: bytes(grant.sealed),
      signature: bytes(grant.signature),
      granter,
      recipientSeed: own.encryption.seed,
      epochPublicKey: publicKey,
      rosterKeyHash: purpose === "member" ? rosterEpoch.memberKeyHash : rosterEpoch.ownerKeyHash
    });
    if (keyManager.getSnapshot().state !== "unlocked" || secretGeneration() !== generation) {
      seed.fill(0);
      throw new KeysLockedError;
    }
    const result = {
      epoch,
      keyId: purpose === "member" ? row.memberKeyId : row.ownerKeyId,
      publicKey,
      seed
    };
    ring.set(cacheKey(workspaceId, epoch, purpose), result);
    return result;
  });
}
function getMemberKey(workspaceId, epoch) {
  return getWorkspaceKey(workspaceId, epoch, "member");
}
async function getOwnerKey(workspaceId, epoch) {
  const state = await verifyWorkspaceState(workspaceId);
  if (state.role !== "owner" || !state.keyEpoch) {
    throw new CryptoError("DECRYPT_FAILED", "Workspace owner key not granted");
  }
  return getWorkspaceKey(workspaceId, epoch ?? state.keyEpoch, "owner");
}
function memberBinding(identity) {
  return { userId: identity.userId, keyId: identity.keyId, fingerprint: identity.fingerprint };
}
async function wireRoster(roster) {
  let workers = roster.workers;
  if (workers.length) {
    const rows = await cryptoClient().query(api.e2ee.workerKeys, {
      workspace: roster.workspace
    });
    workers = workers.filter((worker) => rows.some((row) => row.workerId === worker.workerId && row.keyId === worker.keyId));
  }
  return keyManager.useAmk(async (_, identity) => {
    const signed = await signRoster({ ...roster, workers }, identity.signing.seed);
    return { ...signed, body: buffer(signed.body), signature: buffer(signed.signature) };
  });
}

// src/lib/crypto/chat-keys.ts
async function approvedIdentity(workspaceId, userId) {
  try {
    return await trustedIdentity(workspaceId, userId);
  } catch (error) {
    if (!(error instanceof TrustRequiredError))
      throw error;
    await requestIdentityTrust(error.identity, error.trustState);
    return await trustedIdentity(workspaceId, userId);
  }
}
var seeds = new Map;
var devicePolicies = new Map;
var unsigned = new Map;
var verifiedBindings = new Map;
var opening = new Map;
var settingUp = new Map;
onSecretsCleared(() => {
  for (const seed of seeds.values())
    seed.fill(0);
  seeds.clear();
  devicePolicies.clear();
  unsigned.clear();
  verifiedBindings.clear();
  opening.clear();
  settingUp.clear();
});
var cacheKey2 = (id, epoch) => `${id}:${epoch}`;
async function verifyChatEpoch(input) {
  if (!await verify(input.signingPublicKey, chatKeyStatement({
    workspaceId: input.workspaceId,
    chatE2eeId: input.e2eeId,
    epoch: input.epoch,
    keyId: input.keyId,
    suite: input.suite,
    publicKey: input.publicKey
  }), input.signature))
    throw new CryptoError("DECRYPT_FAILED", "Chat key signature failed");
}
async function openChatSeed(chatId, epoch) {
  const key = cacheKey2(chatId, epoch);
  const pending = opening.get(key);
  if (pending)
    return pending;
  const promise = openCheckedChatSeed(chatId, epoch).finally(() => opening.delete(key));
  opening.set(key, promise);
  return promise;
}
async function openCheckedChatSeed(chatId, epoch) {
  const cached = seeds.get(cacheKey2(chatId, epoch));
  if (trust.getSnapshot() === "rollback") {
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback blocks key access");
  }
  if (cached)
    return cached;
  if (keyManager.getSnapshot().state !== "unlocked")
    throw new KeysLockedError;
  const generation = secretGeneration();
  const state = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
  if (!state.e2eeId)
    throw new CryptoError("BAD_INPUT", "Chat has no keys");
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  if (!row || !row.signature || !row.signerKeyId)
    throw new CryptoError("DECRYPT_FAILED", "Chat key is unsigned");
  const historical = (await fetchHistoricalIdentities([row.signerKeyId], chatId)).get(row.signerKeyId);
  if (!historical)
    throw new CryptoError("DECRYPT_FAILED", "Chat key signer unavailable");
  let signer;
  if (historical.status === "retired") {
    if (historical.userId === state.creatorId) {
      signer = historical;
    } else {
      const workspace = await verifyWorkspaceState(state.workspace);
      if (historical.userId === workspace.ownerId || workspace.verifiedRoster.members.some((member) => member.userId === historical.userId)) {
        signer = historical;
      }
    }
  } else {
    signer = await activeSigner(state.workspace, state.creatorId, historical);
  }
  if (!signer)
    throw new CryptoError("DECRYPT_FAILED", "Unknown chat key signer");
  await verifyChatEpoch({
    workspaceId: state.workspace,
    e2eeId: state.e2eeId,
    ...row,
    publicKey: bytes(row.publicKey),
    signature: bytes(row.signature),
    signingPublicKey: signer.signingPublicKey
  });
  const wrap = usableWrap(state, epoch);
  if (!wrap)
    throw new CryptoError("DECRYPT_FAILED", "Missing chat key wrap");
  const seed = await openWrap(state.workspace, state.e2eeId, wrap);
  if (!equalBytes(await encryptionPublicKeyFromSeed(seed), bytes(row.publicKey))) {
    seed.fill(0);
    throw new CryptoError("DECRYPT_FAILED", "Chat key does not match epoch");
  }
  if (keyManager.getSnapshot().state !== "unlocked" || secretGeneration() !== generation) {
    seed.fill(0);
    throw new KeysLockedError;
  }
  seeds.set(cacheKey2(chatId, epoch), seed);
  return seed;
}
async function activeSigner(workspaceId, creatorId, identity) {
  if (identity.userId === currentUserId() || identity.userId === creatorId) {
    const signerTrust = await trust.check(identity.userId, identity);
    if (signerTrust === "first-contact" || signerTrust === "changed") {
      await requestIdentityTrust(identity, signerTrust);
    }
    return identity;
  }
  const candidate = await approvedIdentity(workspaceId, identity.userId);
  return candidate.keyId === identity.keyId ? candidate : undefined;
}
function usableWrap(state, epoch) {
  return state.wraps.find((entry) => entry.chatEpoch === epoch && entry.recipient === "identity" && entry.userId === currentUserId()) ?? (state.scope === "workspace" ? state.wraps.find((entry) => entry.chatEpoch === epoch && entry.recipient === "workspace") : undefined);
}
async function openWrap(workspaceId, e2eeId, wrap) {
  const aad = {
    table: "e2ee_chat_key_wraps",
    workspace: workspaceId,
    parent: e2eeId,
    record: String(wrap.chatEpoch),
    field: wrap.recipientKeyId
  };
  if (wrap.recipient === "workspace") {
    if (!Number.isSafeInteger(wrap.workspaceEpoch) || !wrap.workspaceEpoch) {
      throw new CryptoError("BAD_ENVELOPE", "Workspace wrap epoch missing");
    }
    const key = await getMemberKey(workspaceId, wrap.workspaceEpoch);
    if (key.keyId !== wrap.recipientKeyId)
      throw new CryptoError("DECRYPT_FAILED", "Workspace wrap key mismatch");
    return openBox({ seed: key.seed, box: bytes(wrap.sealed), aad, pad: "none" });
  }
  return keyManager.useAmk(async (_, identity) => {
    if (wrap.userId !== currentUserId() || toBase64Url(identity.keyId) !== wrap.recipientKeyId)
      throw new CryptoError("DECRYPT_FAILED", "Identity wrap mismatch");
    return openBox({ seed: identity.encryption.seed, box: bytes(wrap.sealed), aad, pad: "none" });
  });
}

// src/lib/crypto/legacy-content.ts
class CustodialContentError extends Error {
  constructor() {
    super("Not yet end-to-end encrypted. Set up encryption and release historical content.");
    this.name = "CustodialContentError";
  }
}
async function openLegacyContent(sealed, context) {
  if (sealed.kind === "custody")
    throw new CustodialContentError;
  if (keyManager.getSnapshot().state !== "unlocked")
    throw new KeysLockedError;
  const generation = secretGeneration();
  let box = new Uint8Array(sealed.box);
  if (sealed.storageId) {
    if (box.byteLength !== 0)
      throw new Error("Ambiguous historical envelope storage");
    const url = await cryptoClient().query(api.e2ee_legacy.storageUrl, { table: context.table, record: context.record });
    if (!url)
      throw new Error("Historical envelope storage is unavailable");
    const response = await fetch(url);
    if (!response.ok)
      throw new Error("Historical envelope download failed");
    box = new Uint8Array(await response.arrayBuffer());
  }
  const aad = legacyAad(context.table, context.record, context.workspace);
  const open = (seed) => openBox({ seed, box, aad, pad: "content" });
  let plaintext;
  if (sealed.kind === "identity") {
    plaintext = await keyManager.useAmk(async (_amk, identity) => {
      if (toBase64Url(identity.keyId) !== sealed.keyId)
        throw new Error("Historical identity key is unavailable");
      return open(identity.encryption.seed);
    });
  } else if (sealed.kind === "chat") {
    if (!context.chatId)
      throw new Error("Historical chat context is missing");
    plaintext = await open(await openChatSeed(context.chatId, sealed.epoch));
  } else {
    if (!context.workspace)
      throw new Error("Historical workspace context is missing");
    const key = sealed.kind === "workspace_owner" ? await getOwnerKey(context.workspace, sealed.epoch) : await getMemberKey(context.workspace, sealed.epoch);
    if (key.keyId !== sealed.keyId)
      throw new Error("Historical workspace key changed");
    plaintext = await open(key.seed);
  }
  try {
    if (generation !== secretGeneration() || keyManager.getSnapshot().state !== "unlocked")
      throw new KeysLockedError;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid historical content");
    return value;
  } finally {
    plaintext.fill(0);
  }
}

// src/lib/crypto/notification-content.ts
async function openNotificationBox(notification, seed) {
  if (!notification.sealed)
    return null;
  try {
    const plaintext = await openBox({
      seed,
      box: new Uint8Array(notification.sealed.box),
      aad: notificationAad(notification.userId, notification.workspace, notification._id),
      pad: "short"
    });
    try {
      const value = JSON.parse(new TextDecoder().decode(plaintext));
      if (!value || typeof value !== "object")
        return null;
      const content = value;
      return typeof content.title === "string" && typeof content.body === "string" ? { title: content.title, body: content.body } : null;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return null;
  }
}
async function openNotification(notification, remembered = false) {
  if (!notification.sealed && notification.legacyContent) {
    const legacy = notification.legacyContent;
    if (remembered || legacy.kind !== "identity")
      return null;
    const before = keyManager.getSnapshot();
    if (before.state !== "unlocked" || before.userId !== notification.userId || before.keyId !== legacy.keyId)
      return null;
    try {
      const value = await openLegacyContent(legacy, {
        table: "notifications",
        record: notification._id,
        workspace: notification.workspace
      });
      const after = keyManager.getSnapshot();
      if (after.state !== "unlocked" || after.userId !== before.userId || after.keyId !== before.keyId || !value || typeof value !== "object")
        return null;
      const content = value;
      return typeof content.title === "string" && typeof content.body === "string" ? { title: content.title, body: content.body } : null;
    } catch {
      return null;
    }
  }
  const sealed = notification.sealed;
  if (!sealed)
    return null;
  try {
    const open = (identity) => openNotificationBox(notification, identity.encryption.seed);
    if (remembered)
      return await useRememberedIdentity(notification.userId, sealed.keyId, open);
    const before = keyManager.getSnapshot();
    if (before.state !== "unlocked" || before.userId !== notification.userId || before.keyId !== sealed.keyId)
      return null;
    const content = await keyManager.useAmk(async (_, identity) => open(identity));
    const after = keyManager.getSnapshot();
    return after.state === "unlocked" && after.userId === before.userId && after.keyId === before.keyId ? content : null;
  } catch {
    return null;
  }
}

// src/notifications-sw.ts
var sw = self;
function genericTitle(kind) {
  switch (kind) {
    case "session_finished":
      return "Session finished";
    case "session_approval":
      return "Approval needed";
    case "session_question":
      return "Question waiting";
    case "session_failed":
      return "Session failed";
    default:
      return "Radium notification";
  }
}
sw.addEventListener("install", () => {
  sw.skipWaiting();
});
sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});
sw.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data?.json();
    } catch {
      return;
    }
    if (!payload || typeof payload.id !== "string")
      return;
    let title = genericTitle(payload.kind);
    let body = "";
    const sealed = payload.sealed;
    if (typeof payload.userId === "string" && sealed && typeof sealed.keyId === "string" && typeof sealed.box === "string" && sealed.box.length <= 3500 && (payload.workspace === undefined || typeof payload.workspace === "string")) {
      try {
        const bytes = fromBase64Url(sealed.box);
        const content = await openNotification({
          _id: payload.id,
          userId: payload.userId,
          workspace: payload.workspace,
          sealed: { keyId: sealed.keyId, box: bytes.slice().buffer }
        }, true);
        if (content)
          ({ title, body } = content);
      } catch {}
    }
    await sw.registration.showNotification(title, {
      body,
      tag: payload.id,
      data: { path: payload.path, workspace: payload.workspace }
    });
  })());
});
function sameOriginPath(value) {
  if (typeof value !== "string")
    return "/";
  try {
    const url = new URL(value, sw.location.origin);
    if (url.origin === sw.location.origin)
      return url.pathname + url.search + url.hash;
  } catch {}
  return "/";
}
sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = sameOriginPath(data.path);
  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameOrigin = windows.filter((client) => new URL(client.url).origin === sw.location.origin);
    const target = sameOrigin.find((client) => client.focused) || sameOrigin[0];
    if (target) {
      await target.focus();
      target.postMessage({ type: "radium:notification-open", path, workspace: data.workspace });
    } else {
      await sw.clients.openWindow(path);
    }
  })());
});
