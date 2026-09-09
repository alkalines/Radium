import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { loggingEnvelopeSchema } from "../../../src/utils/logging/contract";

export default defineSchema({
  events: defineTable({
    ...loggingEnvelopeSchema.fields,
    actorId: v.string(),
    receivedAt: v.number(),
  }).index("by_actorId_and_receivedAt", ["actorId", "receivedAt"]),
});
