import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ObjectTooLargeError, type Objects } from "./types";

/**
 * Local-disk object store for single-node installs: one file per key under `root`. Keys are
 * relative `<namespace>/<id>` paths; anything else (`..`, absolute paths, extra segments) is
 * refused, so a key can never leave `root`. Writes go to `<root>/.tmp` and are renamed into
 * place, so a reader never sees a partial object and an aborted upload stores nothing.
 */

const KEY_PATTERN = /^[a-z]+\/[A-Za-z0-9_-]+$/;
const NAMESPACE_PATTERN = /^[a-z]+$/;
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertKey(key: string) {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("Invalid object key");
  }
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export function createLocalObjects(root: string): Objects {
  const temp = join(root, ".tmp");
  const pathOf = (key: string) => {
    assertKey(key);
    return join(root, key);
  };

  return {
    async put(key, body, { maxBytes }) {
      const target = pathOf(key);
      await mkdir(temp, { recursive: true });
      await mkdir(join(root, key.split("/", 1)[0]!), { recursive: true });
      const partial = join(temp, crypto.randomUUID());
      const out = createWriteStream(partial, { flags: "wx" });
      const { promise: written, resolve, reject } = Promise.withResolvers<void>();
      out.once("error", reject);
      out.once("finish", resolve);
      written.catch(() => {});
      try {
        let size = 0;
        const write = (chunk: Uint8Array) =>
          new Promise<void>((resolve, reject) => {
            size += chunk.byteLength;
            if (size > maxBytes) {
              reject(new ObjectTooLargeError());
              return;
            }
            out.write(chunk, (error) => (error ? reject(error) : resolve()));
          });
        if (body instanceof Uint8Array) {
          await write(body);
        } else {
          const reader = body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await write(value);
            }
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          }
        }
        out.end();
        await written;
        await rename(partial, target);
      } catch (error) {
        out.destroy();
        await rm(partial, { force: true });
        throw error;
      }
    },

    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async stat(key) {
      try {
        const info = await stat(pathOf(key));
        return info.isFile() ? { size: info.size } : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await rm(pathOf(key), { force: true });
    },

    presignPut: () => null,
    presignGet: () => null,

    async list({ prefix, cursor, limit }) {
      const slash = prefix.indexOf("/");
      const namespace = prefix.slice(0, slash);
      const namePrefix = prefix.slice(slash + 1);
      if (slash < 1 || !NAMESPACE_PATTERN.test(namespace) || (namePrefix && !NAME_PATTERN.test(namePrefix))) {
        throw new Error("Invalid object prefix");
      }
      let names: string[];
      try {
        names = await readdir(join(root, namespace));
      } catch (error) {
        if (isMissing(error)) return { keys: [], cursor: null };
        throw error;
      }
      const matching = names
        .filter((name) => NAME_PATTERN.test(name) && name.startsWith(namePrefix))
        .map((name) => `${namespace}/${name}`)
        .filter((key) => cursor === null || key > cursor)
        .sort();
      const page = matching.slice(0, limit);
      const keys: { key: string; lastModified: Date }[] = [];
      for (const key of page) {
        try {
          const info = await stat(join(root, key));
          if (info.isFile()) keys.push({ key, lastModified: info.mtime });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return { keys, cursor: matching.length > page.length ? page.at(-1)! : null };
    },
  };
}
