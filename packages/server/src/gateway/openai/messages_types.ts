import * as z from "zod"; // This thing is a fucking heavy

/**
 * Input Types
 */
/** Canonical OpenRouter reasoning detail with provider-specific continuation extensions. */
export const ReasoningDetail = z
  .object({
    type: z.string(),
    id: z.nullish(z.string()),
    format: z.nullish(z.string()),
    index: z.nullish(z.number()),
    text: z.nullish(z.string()),
    summary: z.nullish(z.string()),
    data: z.nullish(z.string()),
    signature: z.nullish(z.string()),
    provider_metadata: z.optional(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const OpenAI_Input_Image = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(), // URL of the image or a BASE64 encoded
    detail: z.optional(z.string()),
  }),
});

export const OpenAI_Input_Audio = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.union([z.literal("wav"), z.literal("mp3")]),
  }),
});

export const OpenAI_Input_File = z.object({
  type: z.literal("file"),
  file: z.object({
    file_data: z.optional(z.string()),
    file_id: z.optional(z.string()),
    filename: z.optional(z.string()),
    // OpenAI API reference lets everything as optional, so i guess its okay????
  }),
});

export const OpenAI_Input_TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: z.optional(
    z.object({ type: z.literal("ephemeral"), ttl: z.optional(z.enum(["5m", "1h"])) }).strict(),
  ),
});

/**
 * OpenAI Message Types
 */

export const OpenAI_Message_DeveloperSystem = z.object({
  role: z.union([z.literal("developer"), z.literal("system")]),
  content: z.union([z.string(), z.array(OpenAI_Input_TextPart)]),
  name: z.optional(z.string()),
});

export const OpenAI_Message_User = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(
      z.union([OpenAI_Input_TextPart, OpenAI_Input_Image, OpenAI_Input_Audio, OpenAI_Input_File]),
    ),
  ]),
  name: z.optional(z.string()),
});

export const OpenAI_Message_Assistant = z.object({
  role: z.literal("assistant"),
  audio: z.optional(
    z.object({
      id: z.string(),
    }),
  ),
  content: z.union([
    z.string(),
    z.null(),
    z.array(
      z.union([
        OpenAI_Input_TextPart,
        z.object({
          refusal: z.string(),
          type: z.string(),
        }),
      ]),
    ),
  ]),
  reasoning: z.nullish(z.string()),
  reasoning_content: z.nullish(z.string()),
  reasoning_details: z.optional(z.array(ReasoningDetail)),
  /**
   * @deprecated use `tool_calls` instead
   */
  function_call: z.optional(
    z.object({
      arguments: z.string(),
      name: z.string(),
    }),
  ),
  name: z.optional(z.string()),
  refusal: z.optional(z.string()),
  tool_calls: z.optional(
    z.array(
      z.union([
        z.object({
          function: z.object({
            arguments: z.string(),
            name: z.string(),
          }),
          id: z.string(),
          type: z.string(),
          provider_metadata: z.optional(z.record(z.string(), z.any())),
        }),
        z.object({
          custom: z.object({
            input: z.string(),
            name: z.string(),
          }),
          id: z.string(),
          type: z.literal("custom"),
          provider_metadata: z.optional(z.record(z.string(), z.any())),
        }),
      ]),
    ),
  ),
});

export const OpenAI_Message_Tool = z.object({
  content: z.union([z.string(), z.array(OpenAI_Input_TextPart)]),
  role: z.literal("tool"),
  tool_call_id: z.string(),
});

export const OpenAI_Message_Function = z.object({
  role: z.literal("function"),
  name: z.string(),
  content: z.string(),
});
