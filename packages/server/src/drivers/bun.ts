import { RedisClient, S3Client, SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { relations } from "../db/schema";
import { createLocalObjects } from "./local-objects";
import { ObjectTooLargeError } from "./types";
import type { Database, DriverOptions, Drivers, Objects } from "./types";

/**
 * Drivers of the `bun` preset: `Bun.SQL` under Drizzle, `Bun.RedisClient` and the object store
 * (`Bun.S3Client`, or local disk). Selected at build time through the `#drivers` alias, so other
 * presets never bundle or reference `bun`.
 */

/** Postgres alone, for tools that need no Valkey (`bin/migrate.ts`). */
export function createDatabase(databaseUrl: string): { db: Database; close(): Promise<void> } {
  const client = new SQL(databaseUrl);
  return { db: drizzle({ client, relations }), close: () => client.close() };
}

const KEY_PATTERN = /^[a-z]+\/[A-Za-z0-9_-]+$/;
const MISSING_CODES: Record<string, true> = { NoSuchKey: true, NotFound: true, ENOENT: true };

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && MISSING_CODES[String(error.code)] === true;
}

/** `Bun.S3Client` over any S3-compatible store. Uploads normally bypass `put` (presigned PUT). */
function createS3Objects(options: Extract<DriverOptions["objects"], { kind: "s3" }>): Objects {
  const client = new S3Client({
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    endpoint: options.endpoint,
    sessionToken: options.sessionToken,
  });
  const checked = (key: string) => {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid object key");
    return key;
  };
  return {
    async put(key, body, { maxBytes }) {
      if (body instanceof Uint8Array) {
        if (body.byteLength > maxBytes) throw new ObjectTooLargeError();
        await client.write(checked(key), body);
        return;
      }
      // The bound is at most one attachment, so it is buffered rather than streamed in parts.
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ObjectTooLargeError();
        }
        chunks.push(value as Uint8Array<ArrayBuffer>);
      }
      await client.write(checked(key), new Blob(chunks));
    },
    async get(key) {
      try {
        return await client.file(checked(key)).bytes();
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async stat(key) {
      try {
        const { size } = await client.file(checked(key)).stat();
        return { size };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      try {
        await client.delete(checked(key));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    presignPut: (key, { expiresInSeconds }) =>
      client.presign(checked(key), { method: "PUT", expiresIn: expiresInSeconds }),
    presignGet: (key, { expiresInSeconds }) =>
      client.presign(checked(key), { method: "GET", expiresIn: expiresInSeconds }),
    async list({ prefix, cursor, limit }) {
      const page = await client.list({
        prefix,
        maxKeys: limit,
        continuationToken: cursor ?? undefined,
      });
      return {
        keys: (page.contents ?? []).map((item) => ({
          key: item.key,
          lastModified: new Date(item.lastModified ?? 0),
        })),
        cursor: page.isTruncated ? (page.nextContinuationToken ?? null) : null,
      };
    },
  };
}

export function createDrivers(options: DriverOptions): Drivers {
  const database = createDatabase(options.databaseUrl);
  const kv = new RedisClient(options.valkeyUrl);
  const objects =
    options.objects.kind === "s3"
      ? createS3Objects(options.objects)
      : createLocalObjects(options.objects.dir);
  return {
    db: database.db,
    kv,
    objects,
    async close() {
      kv.close();
      await database.close();
    },
  };
}
