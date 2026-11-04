// Orders root `bun run dev`: `convex dev --start` marks its first successful push,
// and the Worker pane waits for that mark before connecting to the backend.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const marker = fileURLToPath(
  new URL("../node_modules/.cache/radium/convex-ready", import.meta.url),
);
const mode = process.argv[2];

if (mode === "reset") {
  rmSync(marker, { force: true });
} else if (mode === "mark") {
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "");
} else if (mode === "wait") {
  if (!existsSync(marker)) {
    console.log("Waiting for Convex's first successful push...");
    while (!existsSync(marker)) await Bun.sleep(250);
  }
} else {
  console.error("Usage: bun scripts/convex-ready.ts reset|mark|wait");
  process.exit(1);
}
