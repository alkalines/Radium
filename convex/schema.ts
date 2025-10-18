import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    credits: v.number(),
    // more later
  }),
  keys: defineTable({
    user: v.id("users"),
    creditLimit: v.optional(v.number()),
    usedCredits: v.number(),
    name: v.string(),
    hash: v.string(),
  }),
  chat_completions: defineTable({
    user: v.id("users"),
    key: v.id("keys"),
    provider: v.string(),
    model: v.string(),
    tokens: v.object({
      prompt: v.number(),
      completion: v.number(),
      reasoning: v.optional(v.number()),
      completion_image: v.optional(v.number()),
      cached: v.optional(v.number()),
    }),
    pricing: v.object({
      input: v.number(),
      output: v.number(),
      audio: v.optional(v.number()),
      image: v.optional(v.number()),
      // Caches
      cache_read: v.optional(v.number()),
      cache_write: v.optional(v.number()),
      cache_audio: v.optional(v.number()),
      // Fees
      byok_fee: v.optional(v.number()),
      tools: v.optional(v.number()), // Like websearch and others
    }),
    gen_time: v.number(),
    latency: v.number(),
    moderation_latency: v.number(),
    canceled: v.boolean(),
    streamed: v.boolean(),
    finish_reason: v.string(),
    byok: v.boolean(),
    app: v.optional(
      v.object({
        //id: v.id('completion_apps') // App use analytics
        title: v.string(),
        url: v.string(),
        icon: v.optional(v.string()), // URL
      })
    ),
    provider_responses: v.array(
      v.object({
        id: v.string(),
        provider: v.string(),
        status: v.number(),
        latency: v.number(),
        is_byok: v.boolean(),
      })
    ),
});