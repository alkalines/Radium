import * as z from "zod"; // This thing is a fucking heavy

export const ChatCompletions_RequestBody = z.object({
  messages: z.array(
    z.union([
      // developer, system
      z.object({
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
      }),
      // user
      z.object({
        role: z.literal("user"),
        content: z.union([
          z.string(),
          z.array(
            z.union([
              z.object({
                type: z.string(),
                text: z.string(),
              }),
              z.object({
                type: z.string(),
                image_url: z.object({
                  url: z.string(), // URL of the image or a BASE64 encoded
                  detail: z.optional(z.string()),
                }),
              }),
              z.object({
                type: z.literal("input_audio"),
                input_audio: z.object({
                  data: z.string(),
                  format: z.union([z.literal("wav"), z.literal("mp3")]),
                }),
              }),
              z.object({
                type: z.literal("file"),
                file: z.object({
                  file_data: z.optional(z.string()),
                  file_id: z.optional(z.string()),
                  filename: z.optional(z.string()),
                  // OpenAI API reference lets everything as optional, so i guess its okay????
                }),
              }),
            ])
          ),
        ]),
        name: z.optional(z.string()),
      }),
      // assistant
      z.object({
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
              z.object({
                text: z.string(),
                type: z.string(),
              }),
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
      }),
      // tool
      z.object({
        content: z.union([
          z.string(),
          z.array(
            z.object({
              text: z.string(),
              type: z.string(),
            })
          ),
        ]),
        role: z.literal("tool"),
        tool_call_id: z.string(),
      }),
      // @deprecated
      // function
      z.object({
        role: z.literal("function"),
        name: z.string(),
        content: z.string(),
      }),
    ])
  ),
  model: z.string(),
  audio: z.nullish(
    z.object({
      // https://platform.openai.com/docs/api-reference/chat/create#chat-create-audio
      format: z.union([
        z.literal("wav"),
        z.literal("mp3"),
        z.literal("flac"),
        z.literal("opus"),
        z.literal("pcm16"),
      ]),
      voice: z.string(),
    })
  ),
  frequency_penalty: z.nullish(z.number().min(-2).max(2)),
  // @deprecated use `tool_choice` instead
  function_call: z.optional(
    z.union([
      z.string(),
      z.object({
        name: z.string(),
      }),
    ])
  ),
  // @deprecated use `tools` instead
  functions: z.optional(
    z.array(
      z.object({
        name: z.string(),
        description: z.optional(z.string()),
        parameters: z.optional(z.object()),
      })
    )
  ),
  logit_bias: z.optional(z.any()), // Map
  logprobs: z.nullish(z.boolean()),
  max_completion_tokens: z.nullish(z.int()),
  // @deprecated use `max_completion_tokens` instead
  max_tokens: z.nullish(z.int()),
  metadata: z.optional(z.any()), // Map
  modalities: z.optional(z.array(z.string())), // ['text', 'audio']
  n: z.optional(z.int().min(1)),
  parallel_tool_calls: z.optional(z.boolean()),
  prediction: z.optional(
    z.object({
      content: z.union([
        z.string(),
        z.array(
          z.object({
            text: z.string(),
            type: z.string(),
          })
        ),
      ]),
      type: z.literal("content"),
    })
  ),
  presence_penalty: z.nullish(z.number().min(-2).max(2)),
  prompt_cache_key: z.optional(z.string()),
  reasoning_effort: z.optional(
    z.union([
      z.literal("minimal"),
      z.literal("low"),
      z.literal("medium"),
      z.literal("high"),
    ])
  ),
  response_format: z.optional(
    z.union([
      z.object({
        type: z.literal("text"),
      }),
      z.object({
        type: z.literal("json_object"),
      }),
      z.object({
        type: z.literal("json_schema"),
        json_schema: z.object({
          name: z.string(),
          description: z.optional(z.string()),
          schema: z.optional(z.object()),
          strict: z.optional(z.boolean()),
        }),
      }),
    ])
  ),
  safety_identifier: z.optional(z.string()),
  // @deprecated
  seed: z.optional(z.int()),
  service_tier: z.optional(z.string()),
  stop: z.nullish(z.union([z.string(), z.array(z.string())])),
  store: z.nullish(z.boolean()),
  stream: z.nullish(z.boolean()),
  stream_options: z.optional(
    z.object({
      include_obfuscation: z.optional(z.boolean()),
      include_usage: z.optional(z.boolean()),
    })
  ),
  temperature: z.optional(z.number().min(0).max(2)),
  tool_choice: z.optional(
    z.union([
      z.string(),
      z.object({
        type: z.literal("allowed_tools"),
        allowed_tools: z.object({
          mode: z.union([z.literal("auto"), z.literal("required")]),
          tools: z.array(
            z.object({
              type: z.literal("function"), // Guest what there is just the example!
              function: z.object({
                name: z.string(),
              }),
            })
          ),
        }),
      }),
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
        }),
      }),
      z.object({
        type: z.literal("custom"),
        custom: z.object({
          name: z.string(),
        }),
      }),
    ])
  ),
  tools: z.optional(
    z.array(
      z.union([
        z.object({
          type: "function",
          function: z.object({
            name: z.string(),
            description: z.optional(z.string()),
            parameters: z.optional(z.object()),
            strict: z.optional(z.boolean()),
          }),
        }),
        z.object({
          type: "custom",
          custom: z.object({
            name: z.string(),
            description: z.optional(z.string()),
            format: z.optional(
              z.union([
                z.object({
                  type: z.literal("text"),
                }),
                z.object({
                  type: z.literal("grammar"),
                  grammar: z.object({
                    definition: z.string(),
                    syntax: z.string(),
                  }),
                }),
              ])
            ),
          }),
        }),
      ])
    )
  ),
  top_logprobs: z.optional(z.int().min(0).max(20)),
  top_p: z.optional(z.number()),
  // @deprecated use `safety_identifier` or `prompt_cache_key` instead
  user: z.optional(z.string()),
  verbosity: z.optional(z.string()),
  web_search_options: z.optional(z.object({
    search_context_size: z.optional(z.union([
      z.literal('low'),
      z.literal('medium'),
      z.literal('high'),
    ])),
    user_location: z.nullish(z.object({
      type: z.string(),
      approximate: z.object({
        city: z.optional(z.string()),
        country: z.optional(z.string()),
        region: z.optional(z.string()),
        timezone: z.optional(z.string()),
      })
    }))
  }))
});
