import { defineComponent } from "convex/server";

// Explicitly declares that isolated identity persistence needs no app env inputs.
export default defineComponent("workerIdentity", { env: {} });
