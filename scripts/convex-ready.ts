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
    const timeoutMs = 10 * 60_000;
    const hintMs = 30_000;
    const start = Date.now();
    let lastHint = start;
    console.log("Waiting for Convex's first successful push...");
    while (!existsSync(marker)) {
      await Bun.sleep(250);
      const now = Date.now();
      if (now - start >= timeoutMs) {
        console.error("Gave up waiting for Convex's first push; fix the error in the convex-dev pane and rerun `bun run dev`.");
        process.exit(1);
      }
      if (now - lastHint >= hintMs) {
        lastHint = now;
        console.log(
          `Still waiting for Convex's first successful push (${Math.round((now - start) / 1000)}s); the Worker starts after it. Check the convex-dev pane for errors.`,
        );
      }
    }
  }
} else {
  console.error("Usage: bun scripts/convex-ready.ts reset|mark|wait");
  process.exit(1);
}
