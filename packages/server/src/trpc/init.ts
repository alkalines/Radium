import { initTRPC, type TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "./context";

const isDev = process.env.NODE_ENV !== "production";

/**
 * The one tRPC instance. No data transformer: inputs and outputs are plain JSON, so timestamps are
 * epoch milliseconds and binary values are base64 strings, declared in each procedure's zod
 * schemas. That keeps payloads readable by every client (web, Worker, CLIs) without a shared codec.
 */
const t = initTRPC.context<Context>().create({
  isDev,
  errorFormatter({ shape, error }) {
    // Unexpected throws surface as INTERNAL_SERVER_ERROR carrying the original message (SQL, driver
    // errors). Production clients get a generic message; procedures that mean to tell the user
    // something throw a specific code instead.
    const message =
      !isDev && error.code === "INTERNAL_SERVER_ERROR" ? "Internal server error" : shape.message;

    return {
      ...shape,
      message,
      data: {
        ...shape.data,
        /** Field errors of a rejected input, for forms. */
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof z.ZodError
            ? z.flattenError(error.cause)
            : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Server-side log for failed calls; client errors (bad input, auth) are expected and not logged. */
export function logTRPCError({ error, path }: { error: TRPCError; path?: string }) {
  if (error.code !== "INTERNAL_SERVER_ERROR") return;
  console.error(`[trpc] ${path ?? "<no path>"} failed`, error.cause ?? error);
}
