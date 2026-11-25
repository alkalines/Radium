import { z } from "zod";
import {
  telemetryDestinationKindSchema,
  telemetryRequestStatusSchema,
} from "contracts/telemetry/validators";
import { ownedWorkspaceProcedure, router, sessionProcedure } from "../trpc/init";
import {
  createDestination,
  deleteDestination,
  listDestinations,
  MAX_DESTINATION_NAME,
  MAX_HEADERS,
  testDestination,
  updateDestination,
} from "./export";
import {
  getRequest,
  getRequestMessages,
  getSession,
  getSettings,
  getSummary,
  listRequests,
  listSessions,
  MAX_REQUEST_PAGE,
  MAX_SESSION_PAGE,
  MESSAGE_PAGE_MAX,
  SESSION_WINDOW_MAX,
  setSettings,
} from "./reads";
import { deleteRequest, deleteSession } from "./retention";

const idInput = z.string().min(1).max(256);
const cursorInput = z.object({ at: z.number().int(), id: idInput });
const apiKeysInput = z.array(idInput).max(200);
/** Header names are validated against the token grammar by the service. */
const headersInput = z
  .record(z.string().max(256), z.string().max(8192))
  .refine((headers) => Object.keys(headers).length <= MAX_HEADERS, "Too many headers.");
// Trimmed and checked by the service; the bound only caps what is read.
const nameInput = z.string().max(MAX_DESTINATION_NAME * 4);
const endpointInput = z.string().max(2048);

/**
 * Convex `observability/telemetry.*` and `observability/telemetryRetention.*`: owner-only reads,
 * capture settings and deletes. Id-addressed procedures resolve the row's workspace and apply the
 * same owner and visibility check (`reads.ts`).
 */
export const telemetryRouter = router({
  getSettings: ownedWorkspaceProcedure.query(({ ctx }) =>
    getSettings(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setSettings: ownedWorkspaceProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        recordInputs: z.boolean(),
        recordOutputs: z.boolean(),
        retentionDays: z.number().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setSettings(ctx.runtime.drivers.db, ctx.access.workspace.id, input)),
  getSummary: ownedWorkspaceProcedure
    .input(z.object({ since: z.number() }))
    .query(({ ctx, input }) => getSummary(ctx.runtime.drivers.db, ctx.access, input.since)),
  listRequests: ownedWorkspaceProcedure
    .input(
      z.object({
        cursor: cursorInput.nullish(),
        limit: z.number().int().min(1).max(MAX_REQUEST_PAGE).default(20),
        session: idInput.optional(),
        status: telemetryRequestStatusSchema.optional(),
        model: z.string().min(1).max(256).optional(),
      }),
    )
    .query(({ ctx, input }) => listRequests(ctx.runtime.drivers.db, ctx.access, input)),
  listSessions: ownedWorkspaceProcedure
    .input(
      z.object({
        cursor: cursorInput.nullish(),
        limit: z.number().int().min(1).max(MAX_SESSION_PAGE).default(10),
      }),
    )
    .query(({ ctx, input }) => listSessions(ctx.runtime.drivers.db, ctx.access, input)),
  getRequest: sessionProcedure
    .input(z.object({ request: idInput }))
    .query(({ ctx, input }) => getRequest(ctx.runtime, ctx.user.id, input.request)),
  getRequestMessages: sessionProcedure
    .input(
      z.object({
        request: idInput,
        cursor: idInput.nullish(),
        limit: z.number().int().min(1).max(MESSAGE_PAGE_MAX).optional(),
      }),
    )
    .query(({ ctx, input }) => getRequestMessages(ctx.runtime, ctx.user.id, input)),
  getSession: sessionProcedure
    .input(
      z.object({
        session: idInput,
        limit: z.number().int().min(1).max(SESSION_WINDOW_MAX).optional(),
      }),
    )
    .query(({ ctx, input }) => getSession(ctx.runtime.drivers.db, ctx.user.id, input)),
  deleteRequest: sessionProcedure
    .input(z.object({ request: idInput }))
    .mutation(({ ctx, input }) => deleteRequest(ctx.runtime, ctx.user.id, input.request)),
  deleteSession: sessionProcedure
    .input(z.object({ session: idInput }))
    .mutation(({ ctx, input }) => deleteSession(ctx.runtime, ctx.user.id, input.session)),
});

/** Convex `observability/telemetryExport.*`: export destinations, owner only. */
export const telemetryExportRouter = router({
  listDestinations: ownedWorkspaceProcedure.query(({ ctx }) =>
    listDestinations(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  createDestination: ownedWorkspaceProcedure
    .input(
      z.object({
        kind: telemetryDestinationKindSchema,
        name: nameInput,
        endpoint: endpointInput,
        headers: headersInput.optional(),
        enabled: z.boolean().optional(),
        privacyMode: z.boolean().optional(),
        samplingRate: z.number().optional(),
        includeApiKeys: apiKeysInput.optional(),
        excludeApiKeys: apiKeysInput.optional(),
      }),
    )
    .mutation(({ ctx, input }) => createDestination(ctx.runtime, ctx.access.workspace.id, input)),
  updateDestination: ownedWorkspaceProcedure
    .input(
      z.object({
        destination: idInput,
        headers: headersInput.optional(),
        name: nameInput.optional(),
        endpoint: endpointInput.optional(),
        enabled: z.boolean().optional(),
        privacyMode: z.boolean().optional(),
        samplingRate: z.number().optional(),
        includeApiKeys: apiKeysInput.optional(),
        excludeApiKeys: apiKeysInput.optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateDestination(ctx.runtime, ctx.access.workspace.id, input)),
  deleteDestination: ownedWorkspaceProcedure
    .input(z.object({ destination: idInput }))
    .mutation(({ ctx, input }) =>
      deleteDestination(ctx.runtime.drivers.db, ctx.access.workspace.id, input.destination),
    ),
  testDestination: ownedWorkspaceProcedure
    .input(z.object({ destination: idInput }))
    .mutation(({ ctx, input }) =>
      testDestination(ctx.runtime, ctx.access.workspace.id, input.destination),
    ),
});
