import { expect, test } from "vitest";
import { acpAgentDefinitionError, type AcpAgentDefinition } from "./contract";
import { ACP_GATEWAY_TEMPLATES, acpGatewayProfileOffered, expandGatewayEnv } from "./gateway";

const definition: AcpAgentDefinition = {
  agentId: "opencode",
  name: "OpenCode",
  command: "opencode",
  args: ["acp"],
  env: [],
  enabled: true,
  source: "registry",
};

test("Gateway env expands all placeholders and the verified OpenCode model configuration", () => {
  const models = [
    { slug: "org/model", name: "Model", context: 100, output: 20 },
    { slug: "partial", name: "Partial", context: 50 },
  ];
  const values = { url: "https://gateway/api/openai/v1", key: "rad-sk-secret", models };
  const env = expandGatewayEnv([...ACP_GATEWAY_TEMPLATES.opencode!], values);
  expect(JSON.parse(env[0]!.value)).toEqual({
    enabled_providers: ["radium"],
    provider: {
      radium: {
        name: "Radium Gateway",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: values.url, apiKey: values.key },
        models: {
          "org/model": { name: "Model", limit: { context: 100, output: 20 } },
          partial: { name: "Partial" },
        },
      },
    },
  });
  expect(
    expandGatewayEnv([{ name: "MODEL", value: "{{gateway.model}}/{{gateway.model}}" }], values),
  ).toEqual([{ name: "MODEL", value: "org/model/org/model" }]);
  expect(ACP_GATEWAY_TEMPLATES["opencode-v2"]).toEqual(ACP_GATEWAY_TEMPLATES.opencode);
  expect(
    expandGatewayEnv([{ name: "MODEL", value: "{{gateway.model}}" }], { ...values, models: [] })[0]!
      .value,
  ).toBe("");
});

test("Gateway definitions validate environment restrictions and placeholders", () => {
  const withEnv = (env: { name: string; value: string }[], enabled = true) => ({
    ...definition,
    gateway: { enabled, env },
  });
  expect(acpAgentDefinitionError(withEnv([...ACP_GATEWAY_TEMPLATES.opencode!]))).toBeNull();
  expect(acpAgentDefinitionError(withEnv([]))).toBe(
    "Add at least one Gateway environment variable.",
  );
  expect(acpAgentDefinitionError(withEnv([{ name: "KEY", value: "{{gateway.nope}}" }]))).toBe(
    "Unknown placeholder {{gateway.nope}} in KEY.",
  );
  for (const env of [
    [{ name: "PATH", value: "x" }],
    [{ name: "RADIUM_SECRET", value: "x" }],
    [{ name: "BAD-NAME", value: "x" }],
    [{ name: "KEY", value: "\0" }],
    [{ name: "KEY", value: "x".repeat(4097) }],
    [
      { name: "KEY", value: "x" },
      { name: "KEY", value: "y" },
    ],
    Array.from({ length: 33 }, (_, i) => ({ name: `KEY_${i}`, value: "x" })),
  ])
    expect(acpAgentDefinitionError(withEnv(env))).not.toBeNull();
  expect(acpGatewayProfileOffered(definition)).toBe(false);
  expect(acpGatewayProfileOffered(withEnv([]))).toBe(false);
  expect(acpGatewayProfileOffered(withEnv([{ name: "KEY", value: "{{gateway.key}}" }]))).toBe(true);
  expect(acpGatewayProfileOffered(withEnv([{ name: "KEY", value: "x" }], false))).toBe(false);
  expect(
    acpGatewayProfileOffered({ ...withEnv([{ name: "KEY", value: "x" }]), enabled: false }),
  ).toBe(false);
});
