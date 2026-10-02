import type { FunctionReference, FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "./component/_generated/api.js";

type InternalReferences<Api, Name extends string | undefined> = {
  [Key in keyof Api]: Api[Key] extends FunctionReference<infer Type>
    ? FunctionReference<
        Type,
        "internal",
        FunctionArgs<Api[Key]>,
        FunctionReturnType<Api[Key]>,
        Name
      >
    : InternalReferences<Api[Key], Name>;
};

/** Source-derived component API; all boundary IDs are explicitly validated strings. */
export type ComponentApi<Name extends string | undefined = string | undefined> = InternalReferences<
  typeof api,
  Name
>;
