import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { relations } from "../db/schema";
import { createAuth } from "./auth";

/**
 * Entry of `bun run auth:schema` only: the Better Auth CLI reads `auth` to generate `./schema.ts`.
 * It never connects or serves requests, so the database is Drizzle's mock and the secrets are
 * placeholders. The OPAQUE setup is not a valid serenity setup; a server that somehow used it
 * would fail closed with `INVALID_SERVER_SETUP`.
 */
export const auth = createAuth({
  db: drizzle.mock({ relations }),
  kv: {
    send() {
      throw new Error("The schema generator has no Valkey");
    },
  },
  siteUrl: "http://localhost:3000",
  secret: "schema-only: not a secret",
  opaqueServerSetup: "schema-only: not a server setup",
});
