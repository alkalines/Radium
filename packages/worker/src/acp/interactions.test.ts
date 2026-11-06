import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { normalizeElicitation } from "./interactions.js";

describe("elicitation normalization", () => {
  it("preserves supported form constraints and titled enum choices", () => {
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId: "session",
      message: "Choose",
      requestedSchema: {
        type: "object",
        required: ["color", "count"],
        properties: {
          color: { type: "string", oneOf: [{ const: "blue", title: "Blue" }], minLength: 1 },
          count: { type: "integer", minimum: 1, maximum: 3 },
          enabled: { type: "boolean", default: true },
          tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }] }, maxItems: 1 },
        },
      },
    };
    expect(normalizeElicitation(request)).toEqual({
      kind: "elicitation",
      mode: "form",
      message: "Choose",
      required: ["color", "count"],
      fields: [
        {
          name: "color",
          type: "string",
          choices: [{ value: "blue", title: "Blue" }],
          minLength: 1,
        },
        { name: "count", type: "integer", minimum: 1, maximum: 3 },
        { name: "enabled", type: "boolean", default: true },
        { name: "tags", type: "array", choices: [{ value: "a", title: "A" }], maxItems: 1 },
      ],
    });
  });
  it("declines unsupported fields and preserves URL consent metadata", () => {
    expect(
      normalizeElicitation({
        mode: "form",
        sessionId: "s",
        message: "Unsupported",
        requestedSchema: { properties: { nested: { type: "object" } } },
      }),
    ).toBeNull();
    expect(
      normalizeElicitation({
        mode: "url",
        sessionId: "s",
        message: "Open",
        url: "https://example.test/consent",
        elicitationId: "link",
      }),
    ).toEqual({
      kind: "elicitation",
      mode: "url",
      message: "Open",
      url: "https://example.test/consent",
      elicitationId: "link",
    });
  });
});
