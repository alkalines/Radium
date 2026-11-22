import { definePlugin } from "nitro";
import { closeProcessRuntime, useProcessRuntime } from "../runtime";

/**
 * Starts the process runtime before Nitro serves traffic (Nitro holds requests until async plugins
 * finish) and closes its connections on shutdown. A failed start check (missing configuration,
 * database behind this build, invalid OPAQUE setup) ends the process instead of serving errors.
 */
export default definePlugin(async (nitro) => {
  try {
    await useProcessRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backend failed to start");
    process.exit(1);
  }

  nitro.hooks.hook("close", async () => {
    await closeProcessRuntime();
  });
});
