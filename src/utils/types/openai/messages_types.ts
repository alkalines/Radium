import * as z from "zod"; // This thing is a fucking heavy

/**
 * Input Types
 */

export const OpenAI_Input_Image = z.object({
  type: z.string(),
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
  type: z.string(),
  text: z.string(),
});

/**
 * OpenAI Message Types
 */

export const OpenAI_Message_DeveloperSystem = z.object({
  role: z.union([z.literal("developer"), z.literal("system")]),
  content: z.array(
    z.union([
      z.string(),
      z.object({
        type: z.string(),
        text: z.string(),
      }),
    ])
  ),
  name: z.optional(z.string()),
});

export const OpenAI_Message_User = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(
      z.union([
        OpenAI_Input_TextPart,
        OpenAI_Input_Image,
        OpenAI_Input_Audio,
        OpenAI_Input_File,
      ])
    ),
  ]),
  name: z.optional(z.string()),
});

export const OpenAI_Message_Assistant = z.object({
  role: z.literal("assistant"),
  audio: z.optional(
    z.object({
      id: z.string(),
    })
  ),
  content: z.union([
    z.string(),
    z.array(
      z.union([
        OpenAI_Input_TextPart,
        z.object({
          refusal: z.string(),
          type: z.string(),
        }),
      ])
    ),
  ]),
  /**
   * @deprecated use `tool_calls` instead
   */
  function_call: z.optional(
    z.object({
      arguments: z.string(),
      name: z.string(),
    })
  ),
  name: z.optional(z.string()),
  refusal: z.optional(z.string()),
  tool_calls: z.array(
    z.union([
      z.object({
        function: z.object({
          arguments: z.string(),
          name: z.string(),
        }),
        id: z.string(),
        type: z.string(),
      }),
      z.object({
        custom: z.object({
          input: z.string(),
          name: z.string(),
        }),
        id: z.string(),
        type: z.literal("custom"),
      }),
    ])
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