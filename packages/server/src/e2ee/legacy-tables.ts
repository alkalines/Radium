import { inArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { acpAgentSessions, acpInteractions, acpSessions } from "../acp/schema";
import { chatFiles, chatMessages, chats } from "../chatroom/schema";
import type { Database } from "../drivers/types";
import { notifications } from "../notifications/schema";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
} from "../telemetry/schema";
import { workerAgents, workerChatCalls } from "../worker/schema";
import { projects, workspaces } from "../workspaces/schema";

/**
 * Every table with a `legacy_content` sidecar (historical content sealed before end-to-end
 * encryption). A sidecar too large for the row keeps its envelope in the object store at
 * `files/<storageId>` (`docs/Backend_Migration/Convex_Import.md`, File storage). This module only
 * imports schemas, so object deletion paths can ask "is this object a sidecar envelope?" without
 * pulling in the authorization code of {@link ./legacy-storage}. A new table with a `legacy_content`
 * column MUST be added here.
 */
const LEGACY_TABLES: ReadonlyArray<{ table: PgTable; column: AnyPgColumn }> = [
  { table: workspaces, column: workspaces.legacyContent },
  { table: projects, column: projects.legacyContent },
  { table: chats, column: chats.legacyContent },
  { table: chatMessages, column: chatMessages.legacyContent },
  { table: chatFiles, column: chatFiles.legacyContent },
  { table: notifications, column: notifications.legacyContent },
  { table: acpAgentSessions, column: acpAgentSessions.legacyContent },
  { table: acpSessions, column: acpSessions.legacyContent },
  { table: acpInteractions, column: acpInteractions.legacyContent },
  { table: workerAgents, column: workerAgents.legacyContent },
  { table: workerChatCalls, column: workerChatCalls.legacyContent },
  { table: telemetryBlobs, column: telemetryBlobs.legacyContent },
  { table: telemetryNodes, column: telemetryNodes.legacyContent },
  { table: telemetrySessions, column: telemetrySessions.legacyContent },
  { table: telemetryRequests, column: telemetryRequests.legacyContent },
];

const KEY_PREFIX = "files/";

/** The object key of an imported storage id. */
export const legacyObjectKey = (storageId: string) => `${KEY_PREFIX}${storageId}`;

/**
 * The keys among `keys` that some `legacy_content.storageId` still names. Only `files/` keys can:
 * the other namespaces (`chat/`) are never sidecar envelopes. The sidecar column is not indexed
 * (the lookup is for the rare deletion of an imported `files/` object), so each table is scanned.
 */
export async function legacyReferencedKeys(db: Database, keys: readonly string[]) {
  const storageIds = keys.filter((key) => key.startsWith(KEY_PREFIX)).map((key) => key.slice(KEY_PREFIX.length));
  if (storageIds.length === 0) return new Set<string>();
  const found = await Promise.all(
    LEGACY_TABLES.map(({ table, column }) => {
      const storageId = sql<string>`${column}->>'storageId'`;
      return db.select({ storageId }).from(table).where(inArray(storageId, storageIds));
    }),
  );
  return new Set(found.flat().map((row) => legacyObjectKey(row.storageId)));
}
