import { defineComponent } from "convex/server";

// Locally installed Better Auth component: its schema is generated from Radium's auth options
// (`bun run --cwd packages/backend auth:schema`), so plugins can add fields and tables.
const component = defineComponent("betterAuth");

export default component;
