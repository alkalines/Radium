import {
  v,
  type GenericId,
  type GenericValidator,
  type ObjectType,
  type VAny,
  type VArray,
  type VBoolean,
  type VBytes,
  type VFloat64,
  type VId,
  type VLiteral,
  type VNull,
  type VObject,
  type VOptional,
  type VRecord,
  type VString,
  type VUnion,
  type Validator,
} from "convex/values";
import { wireTypes } from "contracts/wire";
import type { core } from "zod";

/**
 * Convex validators derived from the zod schemas in `packages/contracts`, the single source of the
 * shapes the Convex schema and functions share with the web app and the Worker.
 *
 * `convex-helpers`' `zodToConvex` cannot be used: it recognizes ids only from its own `zid()`
 * registry and maps every other `z.custom` (our bytes) to `v.any()`, and contracts cannot import
 * `convex-helpers`. This converter covers exactly the subset contracts use (string, number,
 * boolean, null, any, single-value literals, objects, arrays, unions, optionals, records, and the
 * `idOf`/`bytes` schemas from `contracts/wire`) and throws on anything else, so no schema is ever
 * silently widened to `v.any()`. Refinements (`.max()`, `.regex()`, …) are not representable in
 * Convex and are dropped; contracts schemas used here carry none.
 */

type RequiredValidator = Validator<any, "required", any>;

/** The Convex validator `zodToConvex(schema)` returns for a schema of type `Z`. */
export type ZodToConvex<Z> =
  Z extends core.$ZodOptional<infer Inner>
    ? VOptional<ZodToConvex<Inner>>
    : Z extends core.$ZodCustom<infer Output, any>
      ? CustomToConvex<Output>
      : Z extends core.$ZodString
        ? VString
        : Z extends core.$ZodNumber
          ? VFloat64
          : Z extends core.$ZodBoolean
            ? VBoolean
            : Z extends core.$ZodNull
              ? VNull
              : Z extends core.$ZodAny | core.$ZodUnknown
                ? VAny
                : Z extends core.$ZodLiteral<infer Literal>
                  ? VLiteral<Literal>
                  : Z extends core.$ZodArray<infer Element>
                    ? VArray<Member<Element>["type"][], Member<Element>>
                    : Z extends core.$ZodObject<infer Shape>
                      ? ObjectToConvex<Shape>
                      : Z extends core.$ZodUnion<infer Options>
                        ? VUnion<Member<Options[number]>["type"], Members<Options>>
                        : Z extends core.$ZodRecord<infer Key, infer Value>
                          ? VRecord<
                              Record<RecordKey<Key>["type"], Member<Value>["type"]>,
                              RecordKey<Key>,
                              Member<Value>
                            >
                          : never;

/** Field validators of an object shape, as `v.object`/`defineTable` take them. */
export type FieldsToConvex<Shape> = { [K in keyof Shape]: ZodToConvex<Shape[K]> };

type ObjectToConvex<Shape> =
  FieldsToConvex<Shape> extends infer Fields extends Record<string, GenericValidator>
    ? VObject<ObjectType<Fields>, Fields>
    : never;

type CustomToConvex<Output> = Output extends ArrayBuffer
  ? VBytes
  : Output extends GenericId<infer TableName>
    ? VId<GenericId<TableName>>
    : never;

/** Validator of an array element, union member or record key/value, which cannot be optional. */
type Member<Z> = Extract<ZodToConvex<Z>, RequiredValidator>;

type Members<Options> = Options extends readonly [infer Head, ...infer Rest]
  ? [Member<Head>, ...Members<Rest>]
  : [];

type RecordKey<Z> = Extract<ZodToConvex<Z>, Validator<string, "required", any>>;

/** Convex validator of a contracts zod schema. */
export function zodToConvex<Z extends core.$ZodType>(schema: Z): ZodToConvex<Z> {
  return toValidator(schema) as ZodToConvex<Z>;
}

/** Convex field validators of a contracts object shape (`defineTable(zodToConvexFields(shape))`). */
export function zodToConvexFields<Shape extends Record<string, core.$ZodType>>(
  shape: Shape,
): FieldsToConvex<Shape> {
  return fieldsToValidators(shape) as FieldsToConvex<Shape>;
}

function fieldsToValidators(
  shape: Record<string, core.$ZodType>,
): Record<string, GenericValidator> {
  return Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, toValidator(field)]));
}

function toValidator(schema: core.$ZodType): GenericValidator {
  const wire = wireTypes.get(schema);
  if (wire) return wire.kind === "id" ? v.id(wire.table) : v.bytes();
  const def = (schema as core.$ZodTypes)._zod.def;
  switch (def.type) {
    case "string":
      return v.string();
    case "number":
      return v.number();
    case "boolean":
      return v.boolean();
    case "null":
      return v.null();
    case "any":
    case "unknown":
      return v.any();
    case "literal": {
      const [value, ...rest] = def.values;
      if (rest.length > 0 || value === undefined || value === null) break;
      return v.literal(value);
    }
    case "object":
      return v.object(fieldsToValidators(def.shape));
    case "array":
      return v.array(toValidator(def.element) as RequiredValidator);
    case "union":
      return v.union(...def.options.map((option) => toValidator(option) as RequiredValidator));
    case "optional":
      return v.optional(toValidator(def.innerType));
    case "record":
      return v.record(
        toValidator(def.keyType) as Validator<string, "required", any>,
        toValidator(def.valueType) as RequiredValidator,
      );
  }
  throw new Error(`zodToConvex: zod type "${def.type}" has no Convex validator here`);
}
