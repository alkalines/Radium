import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Ports } from "../ports/types";

export const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  postgres: z.boolean(),
  valkey: z.boolean(),
});

export type Health = z.infer<typeof healthSchema>;

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Probes Postgres and Valkey in parallel, each bounded by a timeout so a hung dependency reports
 * `degraded` instead of hanging the health check. Reports reachability only, never error details.
 */
export async function checkHealth({ db, kv }: Pick<Ports, "db" | "kv">): Promise<Health> {
  const [postgres, valkey] = await Promise.all([
    probe("postgres", () => db.execute(sql`select 1`)),
    probe("valkey", () => kv.command("PING", [])),
  ]);

  return { status: postgres && valkey ? "ok" : "degraded", postgres, valkey };
}

async function probe(name: string, check: () => Promise<unknown>): Promise<boolean> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`timed out after ${PROBE_TIMEOUT_MS} ms`)),
    PROBE_TIMEOUT_MS,
  );

  try {
    await Promise.race([check(), timeout.promise]);
    return true;
  } catch (error) {
    console.error(`[health] ${name} probe failed`, error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
