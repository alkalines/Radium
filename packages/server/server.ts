import { createApp } from "./src/app";
import { useProcessRuntime } from "./src/runtime";

// Nitro server entry: Nitro adapts the Hono app to the build's preset. Long-lived presets share
// one runtime per process (`src/plugins/runtime.ts` starts and checks it before traffic).
export default createApp(useProcessRuntime);
