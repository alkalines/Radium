import { v, type Infer } from "convex/values";
import type { AcpAgentDefinition } from "./contract";

export const ACP_GATEWAY_PLACEHOLDERS = [
  "gateway.url",
  "gateway.key",
  "gateway.models",
  "gateway.model",
] as const;
export type AcpGatewayModel = { slug: string; name: string; context?: number; output?: number };
export type AcpGatewayValues = { url: string; key: string; models: AcpGatewayModel[] };

export function expandGatewayEnv(
  env: { name: string; value: string }[],
  values: AcpGatewayValues,
): { name: string; value: string }[] {
  const models = Object.fromEntries(
    values.models.map((model) => [
      model.slug,
      {
        name: model.name,
        ...(model.context !== undefined && model.output !== undefined
          ? { limit: { context: model.context, output: model.output } }
          : {}),
      },
    ]),
  );
  const replacements = {
    "gateway.url": values.url,
    "gateway.key": values.key,
    "gateway.models": JSON.stringify(models),
    "gateway.model": values.models[0]?.slug ?? "",
  };
  return env.map(({ name, value }) => ({
    name,
    value: value.replace(
      /\{\{([^{}]*)\}\}/g,
      (placeholder, key: string) => replacements[key as keyof typeof replacements] ?? placeholder,
    ),
  }));
}

export function acpGatewayProfileOffered(
  definition: Pick<AcpAgentDefinition, "enabled" | "gateway">,
): boolean {
  return definition.enabled && !!definition.gateway?.enabled && definition.gateway.env.length > 0;
}

const openCode = [
  {
    name: "OPENCODE_CONFIG_CONTENT",
    value:
      '{"enabled_providers":["radium"],"provider":{"radium":{"name":"Radium Gateway","npm":"@ai-sdk/openai-compatible","options":{"baseURL":"{{gateway.url}}","apiKey":"{{gateway.key}}"},"models":{{gateway.models}}}}}',
  },
];
export const ACP_GATEWAY_TEMPLATES: Readonly<
  Record<string, readonly { name: string; value: string }[]>
> = { opencode: openCode, "opencode-v2": openCode };
export const acpGatewayAccessValidator = v.union(
  v.literal("off"),
  v.literal("pending"),
  v.literal("active"),
  v.literal("missing"),
);
export type AcpGatewayAccess = Infer<typeof acpGatewayAccessValidator>;
export const keyTelemetryValidator = v.union(v.literal("workspace"), v.literal("off"));
