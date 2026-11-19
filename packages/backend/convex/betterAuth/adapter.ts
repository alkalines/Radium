import { createApi } from "@convex-dev/better-auth";
import { createSchemaAuthOptions } from "../auth";
import schema from "./schema";

// Adapter functions the component client calls. Component functions are never reachable from the
// internet, even when public. Component modules cannot read the deployment's environment
// variables, so they get the schema-only options (no OPAQUE server setup).
export const {
  create,
  findOne,
  findMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
  consumeOne,
  incrementOne,
} = createApi(schema, createSchemaAuthOptions);
