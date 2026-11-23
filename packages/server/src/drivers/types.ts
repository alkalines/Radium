import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { relations } from "../db/schema";

/**
 * Drizzle database or transaction, independent of the Postgres driver. Code outside
 * `src/drivers/` uses only this type, never a driver-specific one, so every preset runs it.
 */
export type Database = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;

/**
 * Valkey connection: one raw command with string arguments, as both `Bun.RedisClient.send` and
 * node-redis `sendCommand` take it. Typed helpers live in `src/kv.ts`.
 */
export interface Kv {
  send(command: string, args: string[]): Promise<unknown>;
}

/** Thrown by {@link Objects.put} when the body is larger than `maxBytes`; nothing is stored. */
export class ObjectTooLargeError extends Error {
  constructor() {
    super("Object is too large");
    this.name = "ObjectTooLargeError";
  }
}

/**
 * Object store (`docs/Backend_Migration/Runtime.md`, Object Storage). Keys are `<namespace>/<id>`
 * (`^[a-z]+/[A-Za-z0-9_-]+$`): `chat/<uuid>` for uploads, `files/<convex storage id>` for imported
 * files. Adapters refuse any other key.
 */
export interface Objects {
  /** Stores `body`; throws {@link ObjectTooLargeError} (storing nothing) past `maxBytes`. */
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: { maxBytes: number },
  ): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  stat(key: string): Promise<{ size: number } | null>;
  /** Idempotent: a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** A presigned upload URL, or `null` when this adapter cannot presign (use `/api/files`). */
  presignPut(key: string, options: { expiresInSeconds: number }): string | null;
  /** A presigned download URL, or `null` when this adapter cannot presign. */
  presignGet(key: string, options: { expiresInSeconds: number }): string | null;
  /** One page of keys under `prefix` in key order; `cursor` null when the listing is complete. */
  list(options: {
    prefix: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ keys: { key: string; lastModified: Date }[]; cursor: string | null }>;
}

/** Connections to the backing services, created once per process (or request, on serverless). */
export interface Drivers {
  db: Database;
  kv: Kv;
  objects: Objects;
  /** Closes pools and connections; called on shutdown. */
  close(): Promise<void>;
}

/** What a driver module (`#drivers`) needs to connect. */
export type DriverOptions = {
  databaseUrl: string;
  valkeyUrl: string;
  objects:
    | { kind: "disk"; dir: string }
    | {
        kind: "s3";
        bucket: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        region?: string;
        endpoint?: string;
        sessionToken?: string;
      };
};
