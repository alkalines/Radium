import { authRelations } from "../auth/schema";

/**
 * Every table of the backend, for `drizzle-kit` (see `drizzle.config.ts`). Domains own their
 * tables in `src/<domain>/schema.ts`; other domains call that domain's services, never its tables.
 */
export * from "../acp/schema";
export * from "../auth/schema";
export * from "../chatroom/schema";
export * from "../e2ee/schema";
export * from "../gateway/schema";
export * from "../jobs/schema";
export * from "../notifications/schema";
export * from "../telemetry/schema";
export * from "../usage/schema";
export * from "../worker/schema";
export * from "../workspaces/schema";

/**
 * Relations given to the Drizzle client. Only the Better Auth adapter needs them (its session
 * lookup joins the user); domain code writes explicit joins.
 */
export const relations = { ...authRelations };
