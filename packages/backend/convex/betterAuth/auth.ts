import type { GenericCtx } from "@convex-dev/better-auth";
import { betterAuth } from "better-auth/minimal";
import type { DataModel } from "../_generated/dataModel";
import { createSchemaAuthOptions } from "../auth";

// Static instance for Better Auth schema generation only (`auth:schema`); nothing else may import
// this file. Schema generation never touches the database, so an empty context is enough.
const schemaGenerationCtx = {} as unknown as GenericCtx<DataModel>;

export const auth = betterAuth(createSchemaAuthOptions(schemaGenerationCtx));
