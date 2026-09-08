/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    events: {
      ingest: FunctionReference<
        "mutation",
        "internal",
        {
          actorId: string;
          correlation?: {
            requestId?: string;
            sessionId?: string;
            traceId?: string;
          };
          event: string;
          level: "debug" | "info" | "warn" | "error";
          message?: string;
          metadata?: Record<string, string | number | boolean | null>;
          product: string;
          source: string;
          timestamp: number;
          version: 1;
        },
        boolean,
        Name
      >;
    };
  };
