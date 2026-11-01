import {
  CreateElicitationRequest,
  ElicitationPropertySchema,
  MultiSelectItems,
} from "@agentclientprotocol/sdk";
import type { AcpElicitationField, AcpInteractionRequest } from "backend/src/acp/contract";

/** Normalize supported ACP forms; unknown schema types decline rather than inventing a UI. */
export function normalizeElicitation(
  request: CreateElicitationRequest,
): AcpInteractionRequest | null {
  const common = {
    kind: "elicitation" as const,
    message: request.message,
    ...("toolCallId" in request && typeof request.toolCallId === "string"
      ? { toolCallId: request.toolCallId }
      : {}),
  };
  if (CreateElicitationRequest.isUrl(request)) {
    return { ...common, mode: "url", elicitationId: request.elicitationId, url: request.url };
  }
  if (!CreateElicitationRequest.isForm(request)) return null;
  const schema = request.requestedSchema;
  const fields: AcpElicitationField[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const labels = {
      name,
      ...(typeof property.title === "string" ? { title: property.title } : {}),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
    };
    if (ElicitationPropertySchema.isString(property)) {
      fields.push({
        ...labels,
        type: "string",
        ...(property.format ? { format: property.format } : {}),
        ...(property.minLength != null ? { minLength: property.minLength } : {}),
        ...(property.maxLength != null ? { maxLength: property.maxLength } : {}),
        ...(property.default != null ? { default: property.default } : {}),
        ...(property.enum ? { choices: property.enum.map((value) => ({ value })) } : {}),
        ...(property.oneOf
          ? {
              choices: property.oneOf.map((choice) => ({
                value: choice.const,
                title: choice.title,
              })),
            }
          : {}),
      });
    } else if (
      ElicitationPropertySchema.isNumber(property) ||
      ElicitationPropertySchema.isInteger(property)
    ) {
      fields.push({
        ...labels,
        type: property.type,
        ...(property.minimum != null ? { minimum: property.minimum } : {}),
        ...(property.maximum != null ? { maximum: property.maximum } : {}),
        ...(property.default != null ? { default: property.default } : {}),
      });
    } else if (ElicitationPropertySchema.isBoolean(property)) {
      fields.push({
        ...labels,
        type: "boolean",
        ...(property.default != null ? { default: property.default } : {}),
      });
    } else if (ElicitationPropertySchema.isArray(property)) {
      const items = property.items;
      let choices: { value: string; title?: string }[];
      if (MultiSelectItems.isString(items)) choices = items.enum.map((value) => ({ value }));
      else if (MultiSelectItems.isTitled(items))
        choices = items.anyOf.map((choice) => ({ value: choice.const, title: choice.title }));
      else return null;
      fields.push({
        ...labels,
        type: "array",
        choices,
        ...(property.minItems != null ? { minItems: property.minItems } : {}),
        ...(property.maxItems != null ? { maxItems: property.maxItems } : {}),
        ...(property.default != null ? { default: property.default } : {}),
      });
    } else return null;
  }
  return {
    ...common,
    mode: "form",
    fields,
    required: schema.required ?? [],
    ...(schema.title ? { title: schema.title } : {}),
    ...(schema.description ? { description: schema.description } : {}),
  };
}
