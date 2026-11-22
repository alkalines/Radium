import { defineConfig } from "drizzle-kit";

// `bun run db:generate` writes SQL migrations to `drizzle/`; they are applied by `bun run
// db:migrate` (src/db/migrate.ts), never by drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
