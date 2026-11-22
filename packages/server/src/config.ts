import * as z from "zod";

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
