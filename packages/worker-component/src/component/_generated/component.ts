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
    enrollment: {
      completeEnrollment: FunctionReference<
        "mutation",
        "internal",
        {
          publicKey: {
            algorithm: string;
            material: string;
            thumbprint: string;
          };
          requestId: string;
          tokenHash: string;
          workspaceId: string;
        },
        {
          identityEpoch: number;
          keyId: string;
          workerId: string;
          workspaceId: string;
        },
        Name
      >;
      createEnrollment: FunctionReference<
        "mutation",
        "internal",
        {
          capabilities: Array<string>;
          expiresAt: number;
          name: string;
          tokenHash: string;
          workspaceId: string;
        },
        string,
        Name
      >;
      pruneEnrollments: FunctionReference<
        "mutation",
        "internal",
        { limit: number },
        number,
        Name
      >;
      recoverEnrollment: FunctionReference<
        "query",
        "internal",
        { enrollmentId: string; thumbprint: string; workspaceId: string },
        {
          identityEpoch: number;
          keyId: string;
          workerId: string;
          workspaceId: string;
        },
        Name
      >;
      revokeEnrollment: FunctionReference<
        "mutation",
        "internal",
        { enrollmentId: string; workspaceId: string },
        null,
        Name
      >;
    };
    identities: {
      getVerificationKey: FunctionReference<
        "query",
        "internal",
        { keyId: string; workspaceId: string },
        null | {
          identityEpoch: number;
          publicKey: {
            algorithm: string;
            material: string;
            thumbprint: string;
          };
          workerId: string;
          workspaceId: string;
        },
        Name
      >;
      getWorkerMetadata: FunctionReference<
        "query",
        "internal",
        { workerId: string; workspaceId: string },
        {
          capabilities: Array<string>;
          identityEpoch: number;
          name: string;
          status: "active" | "revoked";
          workerId: string;
          workspaceId: string;
        },
        Name
      >;
      listWorkers: FunctionReference<
        "query",
        "internal",
        { limit: number; workspaceId: string },
        Array<{
          capabilities: Array<string>;
          identityEpoch: number;
          name: string;
          status: "active" | "revoked";
          workerId: string;
          workspaceId: string;
        }>,
        Name
      >;
      revokeWorker: FunctionReference<
        "mutation",
        "internal",
        { workerId: string; workspaceId: string },
        number,
        Name
      >;
    };
  };
