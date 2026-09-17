import path from "node:path";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolvePath(scriptsDirectory, "..");
const convexEsmRoot = resolvePath(websiteRoot, "node_modules/convex/dist/esm");

// The published CLI bundles these imports. Keep the direct template usable
// without loading the deployment-oriented CLI modules.
const entryPointModule = `
  import path from "node:path";

  export async function entryPoints(_ctx, directory) {
    const modules = JSON.parse(process.env.RADIUM_OFFLINE_MODULES ?? "[]");
    return modules.map((modulePath) => path.resolve(directory, modulePath));
  }
`;

const configModule = `
  export async function getFunctionsDirectoryPath() {
    return "convex";
  }
`;

function moduleUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function isConvexModule(filePath, relativePath) {
  const normalizedPath = filePath.split(path.sep).join("/");
  const expectedPath = join(convexEsmRoot, relativePath).split(path.sep).join("/");
  return (
    normalizedPath === expectedPath ||
    normalizedPath.endsWith(`/node_modules/convex/dist/esm/${relativePath}`)
  );
}

export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith("file:") && specifier.startsWith(".")) {
    const target = fileURLToPath(new URL(specifier, context.parentURL));
    if (isConvexModule(target, "bundler/index.js")) {
      return { url: moduleUrl(entryPointModule), shortCircuit: true };
    }
    if (isConvexModule(target, "cli/lib/config.js")) {
      return { url: moduleUrl(configModule), shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
