/**
 * Drizzle schema entrypoint read by drizzle-kit. Each domain adds its tables in a sibling file
 * (`workspaces.ts`, `chats.ts`, …) and re-exports it here. Primary keys are `text`: imported rows
 * keep their Convex/Better Auth IDs verbatim because E2EE AAD binds them; new rows use UUIDv7.
 */
export {};
