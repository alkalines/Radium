import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

export interface ResolvedWorkerEditPath {
  absolutePath: string;
  displayPath: string;
  exists: boolean;
}

/** Resolve one authored or native-engine path while checking each existing component for symlink escapes. */
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
