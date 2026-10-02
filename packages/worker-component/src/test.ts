/// <reference types="vite/client" />

import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

// Consumers exercise the built component, just like the application's mount.
const modules = import.meta.glob("./component/**/*.js");

/** Register the built component under the same name used in the app's config. */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "workerIdentity",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
