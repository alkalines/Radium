import { z } from "zod";
import { keyTelemetryValidator } from "contracts/acp/gateway";
import { providerRoutingValidator, routingSettingsValidator } from "contracts/routing/settings";
import { serviceTiersValidator } from "contracts/workspaces/provider";
import { ownedWorkspaceProcedure, router, workspaceProcedure } from "../trpc/init";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  updateCredential,
} from "./credentials";
import { createApiKey, listApiKeys, renameApiKey, revokeApiKey, setApiKeyTelemetry } from "./keys";
import { availableModels } from "./models";
import {
  addProviderModels,
  deleteProvider,
  importModelInput,
  importProvider,
  importProviderInput,
  listProviders,
  MAX_IMPORT_MODELS,
  removeProviderModel,
  setProviderEnabled,
  setProviderModelServiceTiers,
} from "./providers";
import {
  getRoutingConfiguration,
  resetCooldown,
  setProviderRouting,
  setRoutingSettings,
} from "./routing/state";

const idInput = z.string().min(1).max(256);
const slugInput = z.string().min(1).max(128);
const modelInput = z.string().min(1).max(256);
const importModels = z.array(importModelInput).max(MAX_IMPORT_MODELS);
/** One value per provider environment variable; values are API keys and endpoints. */
const credentialValues = z
  .record(z.string().max(128), z.string().max(8192))
  .refine((values) => Object.keys(values).length <= 16, "Too many credential values.");
const placementNumber = z.number();

/** Provider configuration and credential pools: owner only, as in Convex. */
export const providersRouter = router({
  list: ownedWorkspaceProcedure.query(({ ctx }) =>
    listProviders(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  importProvider: ownedWorkspaceProcedure
    .input(z.object({ provider: importProviderInput, models: importModels }))
    .mutation(({ ctx, input }) =>
      importProvider(ctx.runtime.drivers.db, ctx.access.workspace.id, input),
    ),
  setEnabled: ownedWorkspaceProcedure
    .input(z.object({ slug: slugInput, enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setProviderEnabled(ctx.runtime.drivers.db, ctx.access.workspace.id, input.slug, input.enabled),
    ),
  addProviderModels: ownedWorkspaceProcedure
    .input(z.object({ slug: slugInput, models: importModels }))
    .mutation(({ ctx, input }) =>
      addProviderModels(ctx.runtime.drivers.db, ctx.access.workspace.id, input.slug, input.models),
    ),
  setProviderModelServiceTiers: ownedWorkspaceProcedure
    .input(
      z.object({ slug: slugInput, model: modelInput, service_tiers: serviceTiersValidator.max(32) }),
    )
    .mutation(({ ctx, input }) =>
      setProviderModelServiceTiers(ctx.runtime.drivers.db, ctx.access.workspace.id, input),
    ),
  removeProviderModel: ownedWorkspaceProcedure
    .input(z.object({ slug: slugInput, model: modelInput }))
    .mutation(({ ctx, input }) =>
      removeProviderModel(ctx.runtime.drivers.db, ctx.access.workspace.id, input.slug, input.model),
    ),
  deleteProvider: ownedWorkspaceProcedure
    .input(z.object({ slug: slugInput }))
    .mutation(async ({ ctx, input }) => {
      await deleteProvider(ctx.runtime, ctx.access.workspace.id, input.slug);
    }),
  listCredentials: ownedWorkspaceProcedure.query(({ ctx }) =>
    listCredentials(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  createCredential: ownedWorkspaceProcedure
    .input(
      z.object({
        provider: slugInput,
        label: z.string().max(256).optional(),
        priority: placementNumber.optional(),
        weight: placementNumber.optional(),
        credentials: credentialValues,
      }),
    )
    .mutation(({ ctx, input }) => createCredential(ctx.runtime, ctx.access.workspace.id, input)),
  updateCredential: ownedWorkspaceProcedure
    .input(
      z.object({
        credential: idInput,
        label: z.string().max(256).optional(),
        enabled: z.boolean().optional(),
        priority: placementNumber.optional(),
        weight: placementNumber.optional(),
        credentials: credentialValues.optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateCredential(ctx.runtime, ctx.access.workspace.id, input)),
  deleteCredential: ownedWorkspaceProcedure
    .input(z.object({ provider: slugInput, credential: idInput }))
    .mutation(({ ctx, input }) => deleteCredential(ctx.runtime, ctx.access.workspace.id, input)),
});

/** Model catalogue as the workspace can route it; members read it to pick models. */
export const modelsRouter = router({
  availableModels: workspaceProcedure.query(({ ctx }) =>
    availableModels(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
});

/** Gateway API keys: owner only. */
export const keysRouter = router({
  list: ownedWorkspaceProcedure.query(({ ctx }) =>
    listApiKeys(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  create: ownedWorkspaceProcedure
    .input(z.object({ name: z.string().max(256) }))
    .mutation(({ ctx, input }) =>
      createApiKey(ctx.runtime.drivers.db, ctx.access.workspace.id, input.name),
    ),
  update: ownedWorkspaceProcedure
    .input(z.object({ key: idInput, name: z.string().max(256) }))
    .mutation(({ ctx, input }) =>
      renameApiKey(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace.id, input),
    ),
  delete: ownedWorkspaceProcedure
    .input(z.object({ key: idInput }))
    .mutation(({ ctx, input }) =>
      revokeApiKey(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace.id, input.key),
    ),
  setKeyTelemetry: ownedWorkspaceProcedure
    .input(z.object({ key: idInput, telemetry: keyTelemetryValidator }))
    .mutation(({ ctx, input }) =>
      setApiKeyTelemetry(
        ctx.runtime.drivers.db,
        ctx.runtime.drivers.kv,
        ctx.access.workspace.id,
        input,
      ),
    ),
});

const providerRoutingInput = providerRoutingValidator.extend({
  errorRules: providerRoutingValidator.shape.errorRules.max(32),
});

/** Routing settings, provider overrides and cooldowns: owner only. */
export const routingRouter = router({
  getConfiguration: ownedWorkspaceProcedure.query(({ ctx }) =>
    getRoutingConfiguration(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace.id),
  ),
  setSettings: ownedWorkspaceProcedure
    .input(z.object({ settings: routingSettingsValidator }))
    .mutation(({ ctx, input }) =>
      setRoutingSettings(ctx.runtime.drivers.db, ctx.access.workspace.id, input.settings),
    ),
  setProviderRouting: ownedWorkspaceProcedure
    .input(
      z.object({
        provider: slugInput,
        routing: providerRoutingInput,
        credentials: z
          .array(z.object({ credential: idInput, priority: z.number(), weight: z.number() }))
          .max(50)
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setProviderRouting(ctx.runtime.drivers.db, ctx.access.workspace.id, input),
    ),
  resetCooldown: ownedWorkspaceProcedure
    .input(z.object({ provider: slugInput, cooldown: z.string().max(1024).optional() }))
    .mutation(({ ctx, input }) =>
      resetCooldown(ctx.runtime.drivers.kv, ctx.access.workspace.id, input),
    ),
});
