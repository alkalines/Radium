/** Failure categories callers branch on; messages are fixed text and never include key material or inputs. */
export type CryptoErrorCode =
  | "DECRYPT_FAILED"
  | "BAD_ENVELOPE"
  | "UNSUPPORTED_SUITE"
  | "BAD_INPUT"
  | "BAD_SIGNATURE"
  | "BAD_RECOVERY_PHRASE";

/**
 * The only error type this package throws for cryptographic or input failures.
 *
 * Authentication failures (wrong key, AAD, header or recipient) all surface as `DECRYPT_FAILED` without
 * saying which check failed, so callers cannot turn the error into an oracle. Underlying library errors
 * are deliberately not attached as `cause`: some include the rejected input (for example a recovery word).
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}
