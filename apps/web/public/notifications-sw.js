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
var ROSTER_EPOCH_WINDOW = 32;
var EMPTY_ROSTER_ARCHIVE = Object.freeze({
  through: 0,
  hash: toBase64Url(new Uint8Array(32))
});
function rosterEpochBytes(entry) {
  return lengthPrefixed([
    decimal(entry.epoch),
    utf8(entry.memberKeyId),
    utf8(entry.memberKeyHash),
    utf8(entry.ownerKeyId),
    utf8(entry.ownerKeyHash)
  ]);
}
async function extendRosterArchive(archive, dropped) {
  let hash = fromBase64Url(archive.hash);
  let through = archive.through;
  for (const entry of dropped) {
    if (entry.epoch !== through + 1) {
      throw new CryptoError("BAD_INPUT", "Archived roster epochs must be contiguous");
    }
    hash = await sha2562(lengthPrefixed([utf8("radium/v1/roster-archive"), hash, rosterEpochBytes(entry)]));
    through = entry.epoch;
  }
  return { through, hash: toBase64Url(hash) };
}
async function verifyArchivedEpochs(input) {
  const failed = new CryptoError("DECRYPT_FAILED", "Archived roster epochs differ from roster");
  const first = input.entries[0];
  if (!first || !isPositive(first.epoch) || input.claimedPrefixHash.length !== 32)
    throw failed;
  if (first.epoch === 1 && !equalBytes(input.claimedPrefixHash, new Uint8Array(32)))
    throw failed;
  let computed;
  try {
    computed = await extendRosterArchive({ through: first.epoch - 1, hash: toBase64Url(input.claimedPrefixHash) }, input.entries);
  } catch {
    throw failed;
  }
  if (computed.through !== input.archive.through || computed.hash !== input.archive.hash) {
    throw failed;
  }
}
async function windowRosterEpochs(input) {
  const sorted = [...input.epochs].sort((a, b) => a.epoch - b.epoch);
  const keep = Math.min(sorted.length, ROSTER_EPOCH_WINDOW);
  const dropped = sorted.slice(0, sorted.length - keep);
  return {
    epochs: sorted.slice(sorted.length - keep),
    archive: await extendRosterArchive(input.archive, dropped)
  };
}
async function signRoster(body, signingSeed) {
  const windowed = await windowRosterEpochs(body);
  if (!isWindow(windowed.epochs, windowed.archive, body.epoch)) {
    throw new CryptoError("BAD_INPUT", "Roster epochs are not a window ending at the current epoch");
  }
  const canonical = {
    v: 3,
    workspace: body.workspace,
    version: body.version,
    epoch: body.epoch,
    owner: {
      userId: body.owner.userId,
      keyId: body.owner.keyId,
      fingerprint: body.owner.fingerprint
    },
    epochs: windowed.epochs.map((entry) => ({
      epoch: entry.epoch,
      memberKeyId: entry.memberKeyId,
      memberKeyHash: entry.memberKeyHash,
      ownerKeyId: entry.ownerKeyId,
      ownerKeyHash: entry.ownerKeyHash
    })),
    archive: { through: windowed.archive.through, hash: windowed.archive.hash },
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
function isWindow(epochs, archive, epoch) {
  if (!archive || typeof archive !== "object" || !Number.isSafeInteger(archive.through) || archive.through < 0 || !isDigest(archive.hash) || archive.through === 0 && archive.hash !== EMPTY_ROSTER_ARCHIVE.hash || epochs.length !== Math.min(epoch, ROSTER_EPOCH_WINDOW) || archive.through !== epoch - epochs.length) {
    return false;
  }
  return epochs.every((entry, index) => entry?.epoch === archive.through + 1 + index);
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
  if (!body || typeof body !== "object" || body.v !== 1 && body.v !== 2 && body.v !== 3 || body.workspace !== input.workspaceId || body.version !== input.version || !isPositive(body.version) || !isPositive(body.epoch) || !body.owner || body.owner.userId !== input.owner.userId || body.owner.keyId !== input.owner.keyId || body.owner.fingerprint !== input.owner.fingerprint || !Array.isArray(body.epochs) || !Array.isArray(body.members) || body.v !== 1 && !Array.isArray(body.workers))
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");
  const epochIds = new Set;
  for (const epoch of body.epochs) {
    if (!epoch || !isPositive(epoch.epoch) || epoch.epoch > body.epoch || epochIds.has(epoch.epoch) || !isKeyId(epoch.memberKeyId) || !isKeyId(epoch.ownerKeyId) || !isDigest(epoch.memberKeyHash) || !isDigest(epoch.ownerKeyHash))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch");
    epochIds.add(epoch.epoch);
  }
  if (!epochIds.has(body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Roster current epoch missing");
  if (body.v === 3 && !isWindow(body.epochs, body.archive, body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch window");
  const members = new Set;
  for (const member of body.members) {
    if (!member || typeof member.userId !== "string" || typeof member.fingerprint !== "string" || member.userId === body.owner.userId || members.has(member.userId) || !isKeyId(member.keyId))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster member");
    members.add(member.userId);
  }
  const workers = body.v === 1 ? [] : body.workers;
  const workerIds = new Set;
  for (const worker of workers) {
    if (!worker || typeof worker.workerId !== "string" || worker.workerId.length === 0 || typeof worker.fingerprint !== "string" || workerIds.has(worker.workerId) || !isKeyId(worker.keyId))
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster worker");
    workerIds.add(worker.workerId);
  }
  const archive = body.v === 3 ? { through: body.archive.through, hash: body.archive.hash } : { ...EMPTY_ROSTER_ARCHIVE };
  return { ...body, archive, workers };
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
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}

class Cached {
  constructor(getter) {
    this._getter = getter;
    this._value = undefined;
  }
  get value() {
    const getter = this._getter;
    if (getter !== undefined) {
      this._value = getter();
      this._getter = undefined;
    }
    return this._value;
  }
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== undefined && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({ type: "nonoptional", innerType: value }));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a;
  for (let i = start;i < issues.length; i++) {
    (_a = issues[i]).schema ?? (_a.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config) {
  var _a;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a = iss).schema ?? (_a.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : undefined;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str))
    return units;
  let count = units;
  for (let i = 0;i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? undefined : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = undefined;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: undefined };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
var CONSTANT_CATCH = "~constantCatch";
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: undefined, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition;
      }
      try {
        return new Definition;
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition;
}
function $constructor(name, initializer, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set;
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && new WeakSet;
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    if (initialized) {
      const own = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto = _.prototype;
    for (const k in proto) {
      if (!Object.prototype.hasOwnProperty.call(proto, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = undefined;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: undefined, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = undefined;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, undefined, {
  Parent: Error
});
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node = curr[el];
            if (terminal) {
              node._errors.push(mapper(issue));
            }
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError;
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = undefined;
        ctx = undefined;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = undefined;
      ctx = undefined;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate2 = (schema, value, _ctx) => {
  const validator = schema._zod.bag.validator;
  if (validator !== undefined) {
    if (validator(value) !== COMPILE_INVALID)
      return true;
    if (validator.definite === true && _ctx === undefined)
      return false;
  }
  return validateFallback(schema, value, _ctx);
};
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length === 0;
}
var validateAsync = async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length === 0;
};
var _encode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return parse(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    return parse(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _encodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== undefined;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = [], closed = {}) {
    this.content = [];
    this.indent = 0;
    this.args = args;
    this.closed = closed;
  }
  indented(fn) {
    this.indent += 1;
    try {
      fn(this);
    } finally {
      this.indent -= 1;
    }
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const content = this?.content ?? [``];
    const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join(`
`)}
};`);
    return factory(...Object.values(this.closed));
  }
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7
};

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var URL_BAD_FORMAT = 1;
var URL_UNPARSEABLE = 2;
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def) {
  if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def);
}
function parseURLObject(trimmed, def) {
  if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
var asciiTabOrNewline = /[\t\n\r]/g;
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = validateURL(trimmed, def);
      if (url === URL_BAD_FORMAT) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid URL format",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === URL_UNPARSEABLE) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === true) {
        payload.value = stripTabAndNewline(trimmed);
        return;
      }
      if (def.hostname && !urlHostnameOk(url, def.hostname)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid hostname",
          pattern: def.hostname.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      if (def.protocol && !urlProtocolOk(url, def.protocol)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid protocol",
          pattern: def.protocol.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  if (def.length !== undefined && (!Number.isInteger(def.length) || def.length < 1))
    throw new Error(`Invalid nanoid length: ${def.length}`);
  def.pattern ?? (def.pattern = def.length === undefined ? nanoid : nanoidOfLength(def.length));
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
});
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidIPv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidCIDRv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64Charset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64urlCharset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse(payload, ctx);
  };
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== undefined && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === undefined) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : def.shape ?? {};
  if (sh) {
    const get = () => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    };
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, new Set);
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== undefined)
          propValues[key].add(undefined);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen))
          break;
        seen = payload.issues.length;
      }
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const memo = globalConfig.memoizer;
  const generateFastpass = (shape) => {
    const normalized = _normalized.value;
    const syms = normalized.symbolKeys;
    const doc = new Doc(["payload", "ctx"], { shape, inst, memo, syms });
    const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.allKeys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (const key of normalized.allKeys) {
      if (key === "__proto__")
        continue;
      const id = ids[key];
      const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
      const isPresent = `${k} in input`;
      const schema = shape[key];
      const optin = schema?._zod?.optin;
      const isOptionalIn = optin !== undefined;
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(k)};`);
      if (isOptionalIn && isOptionalOut) {
        const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
        doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
        if (optin === "defaulted") {
          doc.write(`newResult[${k}] = ${id}.value;`);
        } else {
          doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
        }
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    return doc.compile();
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== undefined) ? "optional" : undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  const keyIssues = new Map;
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  defineLazyInternal(inst, "pattern", (zod) => {
    const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
    return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  globalConfig.memoizer?.guard(inst);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? undefined : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? new Set([...values, undefined]) : undefined;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === undefined) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleOptionalResult(payload, result));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => {
    const v = zod.def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleCatchResult(payload, result, def, ctx));
    }
    return handleCatchResult(payload, result, def, ctx);
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/memoizer.js
class $ZodCyclicError extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`);
    this.name = "ZodCyclicError";
  }
}
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
var recursive = /* @__PURE__ */ new WeakMap;
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
function isRecursive(inst, stack, resolve) {
  const cached = recursive.get(inst);
  if (cached !== undefined)
    return cached ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def = inst._zod.def;
  const kind = def.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def);
      merge(raw ? shape(raw, true) : ASSUMED);
      check(def.catchall);
      break;
    }
    case "array":
      check(def.element);
      break;
    case "tuple":
      for (const el of def.items)
        check(el);
      check(def.rest);
      break;
    case "record":
    case "map":
      check(def.keyType);
      check(def.valueType);
      break;
    case "set":
      check(def.valueType);
      break;
    case "union":
      for (const el of def.options)
        check(el);
      break;
    case "intersection":
      check(def.left);
      check(def.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def.innerType);
      break;
    case "pipe":
      check(def.in);
      check(def.out);
      break;
    case "function":
      check(def.input);
      check(def.output);
      break;
    case "lazy": {
      const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : undefined);
      merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    case "template_literal":
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      for (const key in def) {
        const desc = Object.getOwnPropertyDescriptor(def, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = new WeakMap;
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
var handoff;
var open = [];
var memo = {
  alloc(_inst, payload, empty) {
    const bucket = handoff;
    if (!bucket)
      return empty;
    handoff = undefined;
    const entry = { value: empty, issues: null };
    bucket.set(payload.value, entry);
    open.push(entry);
    return empty;
  },
  guard(inst) {
    var _a;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
          throw new $ZodCyclicError;
        return base(payload, ctx);
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  },
  attach(inst) {
    var _a;
    let isRecursiveInst;
    let rechecked = false;
    let lastCtx;
    let lastBucket;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (isRecursiveInst === undefined) {
          const walked = isRecursive(inst, new Set, false);
          if (walked === NONE) {
            inst._zod.parse = base;
            if (inst._zod.run === wrapped)
              inst._zod.run = base;
            return base(payload, ctx);
          }
          if (walked === PROVEN || rechecked)
            isRecursiveInst = true;
          else
            rechecked = true;
        }
        const input = payload.value;
        if (!isRef(input))
          return base(payload, ctx);
        let state = ctx[STATE];
        if (!state) {
          state = { buckets: new WeakMap, backEdges: undefined };
          ctx[STATE] = state;
        }
        let bucket;
        if (lastCtx === ctx) {
          bucket = lastBucket;
        } else {
          bucket = bucketFor(state, inst);
          lastCtx = ctx;
          lastBucket = bucket;
        }
        const hit = bucket.get(input);
        if (hit) {
          payload.value = hit.value;
          if (hit.issues) {
            if (hit.issues.length)
              payload.issues.push(...cloneIssues(hit.issues));
          } else {
            payload.memo = true;
            state.backEdges ?? (state.backEdges = new WeakSet);
            state.backEdges.add(hit.value);
          }
          return payload;
        }
        handoff = bucket;
        const depth = open.length;
        const result = base(payload, ctx);
        handoff = undefined;
        const entry = open.length > depth ? open.pop() : undefined;
        if (result instanceof Promise) {
          return result.then((r) => {
            if (entry)
              entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
            return r;
          });
        }
        if (entry)
          entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
        return result;
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  }
};
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== undefined && isRef(value) && backEdges.has(value);
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    currency_code: "currency code",
    credit_card: "credit card number",
    iban: "IBAN",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  function getTypeName(type, input) {
    if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
      return String(input);
    }
    return TypeDictionary[type] ?? type;
  }
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = getTypeName(issue.expected);
        const receivedType = parsedType(issue.input);
        const received = getTypeName(receivedType, issue.input);
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) {
          const opts = issue.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        if (issue.inclusive === false) {
          return "Invalid input: more than one option matched";
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/registries.js
var _a2;
class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _custom(Class, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === undefined || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    assignProps(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
var FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
var UNION_KEYS = ["oneOf", "anyOf"];
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members) {
  const objects = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required = new Set;
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? [])
      required.add(key);
  }
  const folded = { type: "object", properties };
  if (required.size)
    folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
    if (Object.keys(union).length !== 1)
      return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = new Map;
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
  if (agg[key] === undefined || value > agg[key])
    agg[key] = value;
};
var narrowMax = (agg, key, value) => {
  if (agg[key] === undefined || value < agg[key])
    agg[key] = value;
};
var narrowBoth = (agg, value) => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
  agg.multipleOf ?? (agg.multipleOf = []);
  if (!agg.multipleOf.includes(value))
    agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
  agg.patterns ?? (agg.patterns = new Set);
  agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
  agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
  agg.format = format;
  if (format.includes("int"))
    agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
  setFormat(agg, def.format);
  const [minimum, maximum] = ranges[def.format];
  narrowMin(agg, "minimum", minimum);
  narrowMax(agg, "maximum", maximum);
};
var contributors = {
  greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
  less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
  multiple_of: (agg, def) => addDivisor(agg, def.value),
  number_format: formatContributor(NUMBER_FORMAT_RANGES),
  bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
  min_length: minContributor,
  max_length: maxContributor,
  length_equals: (agg, def) => narrowBoth(agg, def.length),
  min_size: minContributor,
  max_size: maxContributor,
  size_equals: (agg, def) => narrowBoth(agg, def.size),
  string_format: (agg, def) => {
    setFormat(agg, def.format);
    if (def.pattern)
      addPattern(agg, def.pattern);
    if (def.format === "base64" || def.format === "base64url")
      agg.contentEncoding = def.format;
    if (def.local || def.precision === -1)
      agg.laxFormat = true;
  },
  mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
  const agg = {};
  const def = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== undefined)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== undefined)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== undefined)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== undefined)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== undefined)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== undefined) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var exactPatterns = new Map([
  [base64Charset, base64],
  [base64urlCharset, base64url]
]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time" || laxFormat) {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1)
      json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = [
        ...patternList.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
  json.type = isInt ? "integer" : "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (multipleOf) {
    const divisors = new Set;
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0)
        divisors.add(Math.abs(divisor));
      else
        handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined)
      json.multipleOf = first;
    if (rest.length)
      json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
  }
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.length === 0) {
    json.not = {};
    return;
  }
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  if (def.values.length === 0) {
    json.not = {};
    return;
  }
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
function inputOptin(schema) {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def.out);
  }
  if (def.type === "catch") {
    return inputOptin(def.innerType);
  }
  return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
    return;
  }
  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key, processSchema(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    }));
  }
  const requiredKeys = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined) {
      requiredKeys.push(key);
    }
  }
  if (requiredKeys.length > 0) {
    json.required = requiredKeys;
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = processSchema(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = processSchema(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};
var pendingRecords = new WeakMap;
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io !== "input")
    return;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto))
    return;
  _installedErrorProtos.add(proto);
  _lazyMethod(proto, "format", (self2) => (mapper) => formatError(self2, mapper));
  _lazyMethod(proto, "flatten", (self2) => (mapper) => flattenError(self2, mapper));
  _lazyMethod(proto, "addIssue", (self2) => (issue) => {
    self2.issues.push(issue);
    self2.message = JSON.stringify(self2.issues, jsonStringifyReplacer, 2);
  });
  _lazyMethod(proto, "addIssues", (self2) => (issues) => {
    self2.issues.push(...issues);
    self2.message = JSON.stringify(self2.issues, jsonStringifyReplacer, 2);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true,
    enumerable: false,
    get() {
      return this.issues.length === 0;
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, undefined, {
  Parent: Error
});

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  _ensureDefaultLocale();
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  return inst;
}, {
  check(...chks) {
    const def = this.def;
    return this.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), { parent: true });
  },
  with(...chks) {
    return this.check(...chks);
  },
  clone(def, params) {
    return clone(this, def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta) {
    reg.add(this, meta);
    return this;
  },
  refine(check, params) {
    return this.check(refine(check, params));
  },
  superRefine(refinement, params) {
    return this.check(superRefine(refinement, params));
  },
  overwrite(fn) {
    return this.check(_overwrite(fn));
  },
  optional() {
    return optional(this);
  },
  exactOptional() {
    return exactOptional(this);
  },
  nullable() {
    return nullable(this);
  },
  nullish() {
    return optional(nullable(this));
  },
  nonoptional(params) {
    return nonoptional(this, params);
  },
  array() {
    return array(this);
  },
  or(arg) {
    return union([this, arg]);
  },
  and(arg) {
    return intersection(this, arg);
  },
  transform(tx) {
    return pipe(this, transform(tx));
  },
  default(d) {
    return _default(this, d);
  },
  prefault(d) {
    return prefault(this, d);
  },
  catch(params) {
    return _catch(this, params);
  },
  pipe(target) {
    return pipe(this, target);
  },
  readonly() {
    return readonly(this);
  },
  describe(description) {
    const cl = this.clone();
    globalRegistry.add(cl, { description });
    return cl;
  },
  meta(...args) {
    if (args.length === 0)
      return globalRegistry.get(this);
    const cl = this.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  },
  isOptional() {
    return this.safeParse(undefined).success;
  },
  isNullable() {
    return this.safeParse(null).success;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  },
  get "~standard"() {
    return hide(this, "~standard", {
      ...standardProps(this),
      jsonSchema: {
        input: createStandardJSONSchemaMethod(this, "input"),
        output: createStandardJSONSchemaMethod(this, "output")
      }
    });
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  },
  parse: function _parse(data, params) {
    return parse2(this, data, params, { callee: _parse });
  },
  parseAsync: async function _parseAsync(data, params) {
    return await parseAsync(this, data, params, { callee: _parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  async safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  get spa() {
    return this?.safeParseAsync;
  },
  set spa(value) {
    own(this, "spa", value);
  },
  validate(data, params) {
    return validate2(this, data, params);
  },
  validateAsync(data, params) {
    return validateAsync(this, data, params);
  },
  encode: function _encode(data, params) {
    return encode2(this, data, params, { callee: _encode });
  },
  decode: function _decode(data, params) {
    return decode(this, data, params, { callee: _decode });
  },
  encodeAsync: async function _encodeAsync(data, params) {
    return await encodeAsync(this, data, params, { callee: _encodeAsync });
  },
  decodeAsync: async function _decodeAsync(data, params) {
    return await decodeAsync(this, data, params, { callee: _decodeAsync });
  },
  safeEncode(data, params) {
    return safeEncode(this, data, params);
  },
  safeDecode(data, params) {
    return safeDecode(this, data, params);
  },
  async safeEncodeAsync(data, params) {
    return safeEncodeAsync(this, data, params);
  },
  async safeDecodeAsync(data, params) {
    return safeDecodeAsync(this, data, params);
  },
  toJSONSchema(params) {
    return createToJSONSchemaMethod(this, {})(params);
  },
  get description() {
    return globalRegistry.get(this)?.description;
  },
  get _def() {
    return this._zod.def;
  }
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  format: (inst) => aggregateChecks(inst).format ?? null,
  minLength: (inst) => aggregateChecks(inst).minimum ?? null,
  maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
  regex(...args) {
    return this.check(_regex(...args));
  },
  includes(...args) {
    return this.check(_includes(...args));
  },
  startsWith(...args) {
    return this.check(_startsWith(...args));
  },
  endsWith(...args) {
    return this.check(_endsWith(...args));
  },
  min(...args) {
    return this.check(_minLength(...args));
  },
  max(...args) {
    return this.check(_maxLength(...args));
  },
  length(...args) {
    return this.check(_length(...args));
  },
  nonempty(...args) {
    return this.check(_minLength(1, ...args));
  },
  lowercase(params) {
    return this.check(_lowercase(params));
  },
  uppercase(params) {
    return this.check(_uppercase(params));
  },
  trim() {
    return this.check(_trim());
  },
  normalize(...args) {
    return this.check(_normalize(...args));
  },
  toLowerCase() {
    return this.check(_toLowerCase());
  },
  toUpperCase() {
    return this.check(_toUpperCase());
  },
  slugify() {
    return this.check(_slugify());
  }
}));
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
}, {
  email(params) {
    return this.check(_email(ZodEmail, params));
  },
  url(params) {
    return this.check(_url(ZodURL, params));
  },
  jwt(params) {
    return this.check(_jwt(ZodJWT, params));
  },
  emoji(params) {
    return this.check(_emoji2(ZodEmoji, params));
  },
  guid(params) {
    return this.check(_guid(ZodGUID, params));
  },
  uuid(params) {
    return this.check(_uuid(ZodUUID, params));
  },
  uuidv4(params) {
    return this.check(_uuidv4(ZodUUID, params));
  },
  uuidv6(params) {
    return this.check(_uuidv6(ZodUUID, params));
  },
  uuidv7(params) {
    return this.check(_uuidv7(ZodUUID, params));
  },
  nanoid(params) {
    return this.check(_nanoid(ZodNanoID, params));
  },
  cuid(params) {
    return this.check(_cuid(ZodCUID, params));
  },
  cuid2(params) {
    return this.check(_cuid2(ZodCUID2, params));
  },
  ulid(params) {
    return this.check(_ulid(ZodULID, params));
  },
  base64(params) {
    return this.check(_base64(ZodBase64, params));
  },
  base64url(params) {
    return this.check(_base64url(ZodBase64URL, params));
  },
  xid(params) {
    return this.check(_xid(ZodXID, params));
  },
  ksuid(params) {
    return this.check(_ksuid(ZodKSUID, params));
  },
  ipv4(params) {
    return this.check(_ipv4(ZodIPv4, params));
  },
  ipv6(params) {
    return this.check(_ipv6(ZodIPv6, params));
  },
  cidrv4(params) {
    return this.check(_cidrv4(ZodCIDRv4, params));
  },
  cidrv6(params) {
    return this.check(_cidrv6(ZodCIDRv6, params));
  },
  e164(params) {
    return this.check(_e164(ZodE164, params));
  },
  datetime(params) {
    return this.check(_isoDateTime(ZodISODateTime, params));
  },
  date(params) {
    return this.check(_isoDate(ZodISODate, params));
  },
  time(params) {
    return this.check(_isoTime(ZodISOTime, params));
  },
  duration(params) {
    return this.check(_isoDuration(ZodISODuration, params));
  }
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  inst.isFinite = true;
}, /* @__PURE__ */ derived({
  minValue: (inst) => {
    const { minimum, exclusiveMinimum } = aggregateChecks(inst);
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  },
  maxValue: (inst) => {
    const { maximum, exclusiveMaximum } = aggregateChecks(inst);
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  },
  isInt: (inst) => {
    const { isInt, multipleOf } = aggregateChecks(inst);
    return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
  },
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  int(params) {
    return this.check(int(params));
  },
  safe(params) {
    return this.check(int(params));
  },
  positive(params) {
    return this.check(_gt(0, params));
  },
  nonnegative(params) {
    return this.check(_gte(0, params));
  },
  negative(params) {
    return this.check(_lt(0, params));
  },
  nonpositive(params) {
    return this.check(_lte(0, params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  },
  step(value, params) {
    return this.check(_multipleOf(value, params));
  },
  finite() {
    return this;
  }
}));
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
}, {
  min(n, params) {
    return this.check(_minLength(n, params));
  },
  nonempty(params) {
    return this.check(_minLength(1, params));
  },
  max(n, params) {
    return this.check(_maxLength(n, params));
  },
  length(n, params) {
    return this.check(_length(n, params));
  },
  unwrap() {
    return this.element;
  }
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  installLazyProp(inst, "shape", (self2) => self2._zod.def.shape, false);
}, {
  keyof() {
    return _enum(Object.keys(this._zod.def.shape));
  },
  catchall(catchall) {
    return this.clone(mergeDefs(this._zod.def, { catchall }));
  },
  passthrough() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  loose() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  strict() {
    return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
  },
  strip() {
    return this.clone(mergeDefs(this._zod.def, { catchall: undefined }));
  },
  extend(incoming) {
    return extend(this, incoming);
  },
  safeExtend(incoming) {
    return safeExtend(this, incoming);
  },
  merge(other) {
    return merge(this, other);
  },
  pick(mask) {
    return pick(this, mask);
  },
  omit(mask) {
    return omit(this, mask);
  },
  partial(...args) {
    return partial(ZodOptional, this, args[0]);
  },
  exactPartial(...args) {
    return partial(ZodExactOptional, this, args[0], "exactPartial");
  },
  required(...args) {
    return required(ZodNonOptional, this, args[0]);
  }
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = [...inst._zod.values];
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
// ../../packages/contracts/src/notifications/contract.ts
var sessionNotificationKindValidator = union([
  literal("session_finished"),
  literal("session_approval"),
  literal("session_question"),
  literal("session_failed")
]);
var notificationCategoryValidator = union([
  literal("finished"),
  literal("attention"),
  literal("failed"),
  literal("limits")
]);
var categoryPreferenceValidator = object({
  enabled: boolean2(),
  sound: boolean2()
});
var notificationPreferencesValidator = object({
  finished: optional(categoryPreferenceValidator),
  attention: optional(categoryPreferenceValidator),
  failed: optional(categoryPreferenceValidator),
  limits: optional(categoryPreferenceValidator)
});
var resolvedNotificationPreferencesValidator = object({
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
// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/functionName.js
var functionName = Symbol.for("functionName");

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/components/paths.js
var toReferencePath = Symbol.for("toReferencePath");

// ../../node_modules/.bun/convex@1.49.0+0441d6f8f57aca1e/node_modules/convex/dist/esm/server/api.js
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
// ../../packages/backend/convex/_generated/api.js
var api2 = anyApi;
var components = componentsGeneric();

// ../../packages/contracts/src/wire.ts
var wireTypes = registry();
function idOf(table) {
  const schema = custom((value) => typeof value === "string");
  wireTypes.add(schema, { kind: "id", table });
  return schema;
}
function bytes() {
  const schema = custom((value) => value instanceof ArrayBuffer);
  wireTypes.add(schema, { kind: "bytes" });
  return schema;
}

// ../../packages/contracts/src/e2ee/legacy-contract.ts
var legacyBoxValidator = object({
  kind: union([
    literal("identity"),
    literal("workspace_member"),
    literal("workspace_owner"),
    literal("chat"),
    literal("custody")
  ]),
  keyId: string2(),
  epoch: number2(),
  box: bytes(),
  storageId: optional(idOf("_storage"))
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
function bytes2(value) {
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
    const rows = await cryptoClient().query(api2.e2ee.identityKeys, {
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
    encryptionPublicKey: bytes2(row.encryptionPublicKey),
    signingPublicKey: bytes2(row.signingPublicKey),
    selfSignature: bytes2(row.selfSignature)
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
async function fetchHistoricalIdentities(keyIds, chatEpoch) {
  const result = new Map;
  const unique = [...new Set(keyIds)];
  for (let start = 0;start < unique.length; start += 200) {
    const rows = await cryptoClient().query(api2.e2ee.identityKeysByKeyId, {
      keyIds: unique.slice(start, start + 200),
      chatEpoch
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
    const row = await cryptoClient().query(api2.e2ee.getTrustStore, {});
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
      envelope: bytes2(row.envelope),
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
          await cryptoClient().mutation(api2.e2ee.saveTrustStore, {
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
var archives = new Map;
var ARCHIVED_EPOCH_PAGE = 64;
var cacheKey = (workspaceId, epoch, purpose) => `${workspaceId}:${epoch}:${purpose}`;
onSecretsCleared(() => {
  for (const key of ring.values())
    key.seed.fill(0);
  ring.clear();
  verifiedStates.clear();
  stateLoads.clear();
  archives.clear();
});
trust.subscribe(() => {
  verifiedStates.clear();
  stateLoads.clear();
  archives.clear();
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
    const state = await cryptoClient().query(api2.e2ee.workspaceKeyState, {
      workspace: workspaceId
    });
    const key = JSON.stringify(state, (_, value) => value instanceof ArrayBuffer ? toBase64Url(bytes2(value)) : value);
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
      body: bytes2(roster.body),
      signature: bytes2(roster.signature),
      owner: historical,
      highWater: highWater(marker)
    });
    const resigned = await wireRoster({
      ...previous,
      version: previous.version + 1,
      owner: memberBinding(owner)
    });
    await cryptoClient().mutation(api2.e2ee.publishRoster, {
      workspace: workspaceId,
      roster: resigned
    });
    roster = { ...roster, ...resigned };
  }
  const verifiedRoster = await verifyRoster({
    workspaceId,
    version: roster.version,
    signerKeyId: roster.signerKeyId,
    body: bytes2(roster.body),
    signature: bytes2(roster.signature),
    owner,
    highWater: highWater(marker)
  });
  const window2 = verifiedRoster.epochs.filter((entry) => entry.epoch > verifiedRoster.epoch - ROSTER_EPOCH_WINDOW);
  if (verifiedRoster.epoch !== state.keyEpoch || state.epochs.length !== window2.length)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch rollback or substitution");
  for (const epoch of state.epochs) {
    const entry = window2.find((row) => row.epoch === epoch.epoch);
    if (!entry || !sameRosterEpoch(entry, await rosterEpochOf(epoch)))
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
    publicKey: bytes2(latest.memberPublicKey)
  });
  return { ...state, identities, verifiedRoster };
}
async function rosterEpochOf(row) {
  return {
    epoch: row.epoch,
    memberKeyId: row.memberKeyId,
    memberKeyHash: toBase64Url(await sha2562(bytes2(row.memberPublicKey))),
    ownerKeyId: row.ownerKeyId,
    ownerKeyHash: toBase64Url(await sha2562(bytes2(row.ownerPublicKey)))
  };
}
function sameRosterEpoch(a, b) {
  return a.epoch === b.epoch && a.memberKeyId === b.memberKeyId && a.memberKeyHash === b.memberKeyHash && a.ownerKeyId === b.ownerKeyId && a.ownerKeyHash === b.ownerKeyHash;
}
async function archivedEpochs(workspaceId, state, from) {
  const roster = state.verifiedRoster;
  const windowStart = state.epochs[0]?.epoch ?? 1;
  if (!Number.isSafeInteger(from) || from < 1 || from >= windowStart)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  const key = `${roster.version}:${roster.archive.hash}`;
  const cached = archives.get(workspaceId);
  const known = cached?.key === key ? cached : undefined;
  if (known && known.from <= from)
    return known;
  const end = known ? known.from - 1 : windowStart - 1;
  const fetchPage = (start) => cryptoClient().query(api2.e2ee.workspaceArchivedEpochs, {
    workspace: workspaceId,
    fromEpoch: start,
    toEpoch: Math.min(start + ARCHIVED_EPOCH_PAGE - 1, end)
  });
  let start = from;
  let page = await fetchPage(start);
  if (roster.v === 3 && start > 1 && page.prefixHash === null) {
    start = 1;
    page = await fetchPage(start);
  }
  const prefixHash = page.prefixHash;
  const rows = [...page.epochs];
  const grants = [...page.myGrants];
  for (let next = start + ARCHIVED_EPOCH_PAGE;next <= end; next += ARCHIVED_EPOCH_PAGE) {
    const more = await fetchPage(next);
    rows.push(...more.epochs);
    grants.push(...more.myGrants);
  }
  const fetched = await Promise.all(rows.map(rosterEpochOf));
  const entries = [...fetched, ...known?.entries ?? []];
  if (roster.v === 3) {
    let claimedPrefixHash = new Uint8Array(32);
    if (start > 1) {
      if (prefixHash === null)
        throw new CryptoError("DECRYPT_FAILED", "Archived roster epochs differ from roster");
      claimedPrefixHash = fromBase64Url(prefixHash);
    }
    await verifyArchivedEpochs({ archive: roster.archive, claimedPrefixHash, entries });
  } else {
    for (const entry of fetched) {
      const listed = roster.epochs.find((row) => row.epoch === entry.epoch);
      if (!listed || !sameRosterEpoch(listed, entry))
        throw new CryptoError("DECRYPT_FAILED", "Workspace epoch differs from signed roster");
    }
    if (fetched.length !== end - start + 1)
      throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  }
  const verified = {
    key,
    from: start,
    entries,
    rows: new Map(known?.rows),
    grants: [...grants, ...known?.grants ?? []]
  };
  rows.forEach((row, index) => verified.rows.set(row.epoch, { row, rosterEpoch: fetched[index] }));
  archives.set(workspaceId, verified);
  return verified;
}
async function epochRecord(workspaceId, state, epoch) {
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  if (row) {
    const rosterEpoch = state.verifiedRoster.epochs.find((entry) => entry.epoch === epoch);
    if (!rosterEpoch)
      throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
    return { row, rosterEpoch, grants: state.myGrants };
  }
  const archived = await archivedEpochs(workspaceId, state, epoch);
  const record = archived.rows.get(epoch);
  if (!record)
    throw new CryptoError("DECRYPT_FAILED", "Workspace epoch missing");
  return { ...record, grants: archived.grants };
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
  const { row, rosterEpoch, grants } = await epochRecord(workspaceId, state, epoch);
  return keyManager.useAmk(async (_, own) => {
    const recipientKeyId = toBase64Url(own.keyId);
    const grant = grants.find((entry) => entry.epoch === epoch && entry.purpose === purpose && entry.recipientKeyId === recipientKeyId);
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
    const publicKey = bytes2(purpose === "member" ? row.memberPublicKey : row.ownerPublicKey);
    const seed = await openWorkspaceGrant({
      workspaceId,
      ...grant,
      sealed: bytes2(grant.sealed),
      signature: bytes2(grant.signature),
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
    const rows = await cryptoClient().query(api2.e2ee.workerKeys, {
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
  const state = await cryptoClient().query(api2.e2ee.chatKeys, { chatId, epoch });
  if (!state.e2eeId)
    throw new CryptoError("BAD_INPUT", "Chat has no keys");
  const row = state.epochs.find((entry) => entry.epoch === epoch);
  if (!row || !row.signature || !row.signerKeyId)
    throw new CryptoError("DECRYPT_FAILED", "Chat key is unsigned");
  const historical = (await fetchHistoricalIdentities([row.signerKeyId], { chatId, epoch })).get(row.signerKeyId);
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
    publicKey: bytes2(row.publicKey),
    signature: bytes2(row.signature),
    signingPublicKey: signer.signingPublicKey
  });
  const wrap = usableWrap(state, epoch);
  if (!wrap)
    throw new CryptoError("DECRYPT_FAILED", "Missing chat key wrap");
  const seed = await openWrap(state.workspace, state.e2eeId, wrap);
  if (!equalBytes(await encryptionPublicKeyFromSeed(seed), bytes2(row.publicKey))) {
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
    return openBox({ seed: key.seed, box: bytes2(wrap.sealed), aad, pad: "none" });
  }
  return keyManager.useAmk(async (_, identity) => {
    if (wrap.userId !== currentUserId() || toBase64Url(identity.keyId) !== wrap.recipientKeyId)
      throw new CryptoError("DECRYPT_FAILED", "Identity wrap mismatch");
    return openBox({ seed: identity.encryption.seed, box: bytes2(wrap.sealed), aad, pad: "none" });
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
    const url = await cryptoClient().query(api2.e2ee_legacy.storageUrl, { table: context.table, record: context.record });
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
