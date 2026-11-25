import * as z from "zod";
import { parseSecretStoreKeys } from "./gateway/secrets";

/**
 * An origin the backend can be reached at: HTTPS, or HTTP on loopback for local development.
 * Credentials, paths, queries and fragments are refused; the result has no trailing slash.
 */
export function parseOrigin(value: string) {
  const url = new URL(value);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback))
  ) {
    throw new Error("Invalid origin");
  }
  return url.origin;
}

const origin = z.string().transform((value, context) => {
  try {
    return parseOrigin(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be an https origin, or http on loopback" });
    return z.NEVER;
  }
});

const required = z.string().min(1);
const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const configSchema = z.object({
  /** Web origin: cookies, trusted origin for auth requests, reset links. */
  SITE_URL: origin,
  /** Public backend origin: Gateway base URL and the Worker JWT issuer. */
  API_URL: origin,
  DATABASE_URL: required,
  VALKEY_URL: required,
  BETTER_AUTH_SECRET: required,
  OPAQUE_SERVER_SETUP: required,
  /** Shared with the web server, which forwards `/api/*` and names the client address. */
  AUTH_PROXY_SECRET: optional,
  /** Public issuer keys for Worker access tokens; without them every Worker call is refused. */
  WORKER_AUTH_JWKS: optional,
  /**
   * Key-encryption keys of the `secrets` table, `version:base64,…` (the `convex-secret-store`
   * format and values); the highest version wraps new secrets.
   */
  SECRET_STORE_KEYS: required.transform((value, context) => {
    try {
      return parseSecretStoreKeys(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }),
  /**
   * Base64url 32-byte key for workspace-scoped fingerprints (routing session hashes, telemetry
   * content hashes). Without it, message-hash session affinity and telemetry capture are off.
   */
  TELEMETRY_HASH_SECRET: optional.refine(
    (value) => value === undefined || /^[A-Za-z0-9_-]{43}$/.test(value),
    "must be a base64url-encoded 32-byte key",
  ),
  /** Signs the Login with ChatGPT session cookie; without it the ChatGPT subscription is off. */
  LWC_SECRET: optional,
  /** Object store: an S3-compatible bucket (Bun's S3 variable names)… */
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_SESSION_TOKEN: optional,
  S3_REGION: optional,
  S3_ENDPOINT: optional,
  /** …or a local directory for single-node installs. Exactly one of the two. */
  FILES_DIR: optional,
  /**
   * Web Push VAPID key pair (`bunx web-push generate-vapid-keys`; base64url P-256 public point
   * and private scalar, the Convex values unchanged). Without both, push is off and Settings
   * shows it as unconfigured.
   */
  WEB_PUSH_VAPID_PUBLIC_KEY: optional.refine(
    (value) => value === undefined || /^[A-Za-z0-9_-]{87}$/.test(value),
    "must be a base64url-encoded uncompressed P-256 public key",
  ),
  WEB_PUSH_VAPID_PRIVATE_KEY: optional.refine(
    (value) => value === undefined || /^[A-Za-z0-9_-]{43}$/.test(value),
    "must be a base64url-encoded P-256 private key",
  ),
  /** VAPID contact, `mailto:` or `https:`; defaults to `SITE_URL`. */
  WEB_PUSH_SUBJECT: optional.refine(
    (value) => value === undefined || /^(mailto:|https:\/\/)\S+$/.test(value),
    "must be a mailto: or https: URL",
  ),
}).superRefine((value, context) => {
  if ((value.S3_BUCKET === undefined) === (value.FILES_DIR === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: "set exactly one of S3_BUCKET and FILES_DIR",
    });
  }
  if (
    (value.WEB_PUSH_VAPID_PUBLIC_KEY === undefined) !==
    (value.WEB_PUSH_VAPID_PRIVATE_KEY === undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["WEB_PUSH_VAPID_PRIVATE_KEY"],
      message: "set both WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY, or neither",
    });
  }
});

/** Validated runtime configuration. Read once at startup from the environment. */
export type Config = z.output<typeof configSchema>;

/**
 * Parses the backend's environment. Errors name the variables only, never their values, since
 * several are secrets.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid backend configuration:\n- ${problems.join("\n- ")}`);
  }
  return result.data;
}
