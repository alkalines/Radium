import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Path-policy rejection whose code is safe for the Worker edit response. */
export class WorkerEditPathError extends Error {
  constructor(readonly code: "PATH_OUTSIDE_ROOT" | "UNSAFE_PATH") {
    super(
      code === "PATH_OUTSIDE_ROOT"
        ? "Path is outside the authorized edit root."
        : "Path is not a safe editable file.",
    );
    this.name = "WorkerEditPathError";
  }
}

/** Validated path details returned by {@link resolveWorkerEditPath}. */
export interface ResolvedWorkerEditPath {
  /** Absolute path formed beneath the canonical execution root. */
  absolutePath: string;
  /** Slash-separated path relative to the execution root for public results. */
  displayPath: string;
  exists: boolean;
}

/**
 * Resolve an authored or native-engine path beneath a canonical execution root.
 * Existing path components must have the requested file/directory shape, and
 * symlink targets are allowed only when they remain inside that root. Missing
 * targets are returned with `exists: false`; unsafe paths throw a typed error.
 */
export async function resolveWorkerEditPath(
  root: string,
  authoredPath: string,
  kind: "file" | "directory" = "file",
): Promise<ResolvedWorkerEditPath> {
  const currentRoot = await realpath(root).catch(() => {
    throw new WorkerEditPathError("UNSAFE_PATH");
  });
  if (currentRoot !== root) throw new WorkerEditPathError("PATH_OUTSIDE_ROOT");
  if (
    !authoredPath ||
    authoredPath.includes("\0") ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(authoredPath)
  ) {
    throw new WorkerEditPathError("UNSAFE_PATH");
  }

  const absolutePath = resolve(root, authoredPath);
  const rootRelative = relative(root, absolutePath);
  if (!isWithinRoot(rootRelative) || (!rootRelative && kind === "file")) {
    throw new WorkerEditPathError("PATH_OUTSIDE_ROOT");
  }

  let exists = true;
  if (rootRelative) {
    const components = rootRelative.split(sep).filter(Boolean);
    let current = root;
    for (let index = 0; index < components.length; index += 1) {
      current = join(current, components[index]!);
      const entry = await lstat(current).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw new WorkerEditPathError("UNSAFE_PATH");
      });

      if (!entry) {
        exists = false;
        break;
      }

      const finalComponent = index === components.length - 1;
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(current).catch(() => {
          throw new WorkerEditPathError("UNSAFE_PATH");
        });
        if (!isWithinRoot(relative(root, resolved))) {
          throw new WorkerEditPathError("PATH_OUTSIDE_ROOT");
        }
        const target = await stat(current).catch(() => {
          throw new WorkerEditPathError("UNSAFE_PATH");
        });
        if (
          finalComponent
            ? kind === "file"
              ? !target.isFile()
              : !target.isDirectory()
            : !target.isDirectory()
        ) {
          throw new WorkerEditPathError("UNSAFE_PATH");
        }
      } else if (
        finalComponent
          ? kind === "file"
            ? !entry.isFile()
            : !entry.isDirectory()
          : !entry.isDirectory()
      ) {
        throw new WorkerEditPathError("UNSAFE_PATH");
      }
    }
  }

  return {
    absolutePath,
    displayPath: rootRelative.split(sep).join("/"),
    exists,
  };
}

export function isWithinRoot(pathFromRoot: string): boolean {
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
