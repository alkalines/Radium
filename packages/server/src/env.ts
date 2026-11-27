import { z } from "zod";

const envSchema = z.object({
  /** Postgres connection URL, the system of record. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Valkey (or Redis-compatible) URL for ephemeral state and fan-out. */
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ServerEnv = z.infer<typeof envSchema>;

/**
 * Validates the server's runtime configuration. Throws one error naming every missing or invalid
 * variable; values are never echoed because URLs carry credentials.
 */
export function readEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(
    `Invalid server environment (see packages/server/.env.example):\n  ${problems.join("\n  ")}`,
  );
}
