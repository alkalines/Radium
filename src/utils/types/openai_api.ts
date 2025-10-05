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

export const ChatCompletions_NotStreaming_ResponseBody = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.union([
        z.string(),
        z.literal("stop"),
        z.literal("length"),
        z.literal("content_filter"),
        z.literal("tool_calls"),
        z.literal("function_call"),
      ]),
      index: z.int(),
      logprobs: z.nullish(
        z.object({
          content: z.array(
            z.object({
              bytes: z.array(z.any()),
              logprob: z.number(),
              token: z.string(),
              top_logprobs: z.array(
                z.object({
                  bytes: z.array(z.any()),
                  logprob: z.number(),
                  token: z.string(),
                })
              ),
            })
          ),
          refusal: z.array(
            z.object({
              bytes: z.array(z.any()),
              logprob: z.number(),
              token: z.string(),
              top_logprobs: z.array(
                z.object({
                  bytes: z.array(z.any()),
                  logprob: z.number(),
                  token: z.string(),
                })
              ),
            })
          ),
        })
      ),
      message: z.object({
        content: z.string(),
        refusal: z.string(),
        role: z.string(),
        annotations: z.array(
          z.object({
            type: z.literal("url_citation"),
            url_citation: z.object({
              end_index: z.int(),
              start_index: z.int(),
              title: z.string(),
              url: z.string(),
            }),
          })
        ),
        audio: z.object({
          data: z.string(),
          expires_at: z.int(), // UNIX Timestamp
          id: z.string(),
          transcript: z.string(),
        }),
        // @Deprecated
        function_call: z.nullish(
          z.object({
            arguments: z.string(),
            name: z.string(),
          })
        ),
        tool_calls: z.array(
          z.union([
            z.object({
              function: z.object({
                arguments: z.string(),
                name: z.string(),
              }),
              id: z.string(),
              type: z.union([z.string(), z.literal("function")]),
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
    })
  ),
  created: z.int(), // UNIX Timestamp
  id: z.string(),
  model: z.string(),
  object: z.literal("chat.completion"),
  service_tier: z.nullish(
    z.union([
      z.string(),
      z.literal("auto"),
      z.literal("default"),
      z.literal("flex"),
      z.literal("priority"),
    ])
  ),
  // @deprecated
  system_fingerprint: z.nullish(z.string()),
  usage: z.object({
    completion_tokens: z.int(),
    prompt_tokens: z.int(),
    total_tokens: z.int(),
    completion_tokens_details: {
      accepted_prediction_tokens: z.int(),
      audio_tokens: z.int(),
      reasoning_tokens: z.int(),
      rejected_prediction_tokens: z.int(),
      prompt_tokens_details: z.nullish(
        z.object({
          audio_tokens: z.int(),
          cached_tokens: z.int(),
        })
      ),
    },
  }),
});

export const ChatCompletions_Streaming_Chunk = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string(),
        // @deprecated
        function_call: z.object({
          arguments: z.string(),
          name: z.string(),
        }),
        refusal: z.string(),
        role: z.string(),
        tool_calls: z.array(
          z.object({
            index: z.int(),
            function: z.object({
              arguments: z.string(),
              name: z.string(),
            }),
            id: z.string(),
            type: z.literal("function"),
          })
        ),
      }),
    })
  ),
  created: z.int(),
  id: z.string(),
  model: z.string(),
  object: z.string(),
  service_tier: z.nullish(
    z.union([
      z.string(),
      z.literal("auto"),
      z.literal("default"),
      z.literal("flex"),
      z.literal("priority"),
    ])
  ),
  // @deprecated
  system_fingerprint: z.string(),
  usage: z.nullish(
    z.object({
      completion_tokens: z.int(),
      prompt_tokens: z.int(),
      total_tokens: z.int(),
      completion_tokens_details: z.nullish(
        z.object({
          accepted_prediction_tokens: z.nullish(z.int()),
          audio_tokens: z.nullish(z.int()),
          reasoning_tokens: z.nullish(z.int()),
          rejected_prediction_tokens: z.nullish(z.int()),
        })
      ),
      prompt_tokens_details: z.nullish(
        z.object({
          audio_tokens: z.nullish(z.int()),
          cached_tokens: z.nullish(z.int()),
        })
      ),
    })
  ),
});
