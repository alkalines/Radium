import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { loggingEnvelopeSchema } from "contracts/logging/contract";
import { zodToConvex } from "../../../src/zod-validators";

export default defineSchema({
  events: defineTable({
    ...zodToConvex(loggingEnvelopeSchema).fields,
    actorId: v.string(),
    receivedAt: v.number(),
  }).index("by_actorId_and_receivedAt", ["actorId", "receivedAt"]),
});
