import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // Only `migrate`/`push` connect; `generate` works without a database.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
