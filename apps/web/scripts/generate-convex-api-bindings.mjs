import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseComponentName, parseRootComponents } from "./convex-config-parser.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsDirectory, "../../..");
const backendRoot = join(repositoryRoot, "packages/backend");
const functionsRoot = join(backendRoot, "convex");
const outputPath = join(functionsRoot, "_generated", "api.d.ts");
const backendPackageJson = join(backendRoot, "package.json");
const websiteRequire = createRequire(backendPackageJson);
const auditedConvexVersion = "1.46.0";
const args = process.argv.slice(2);

if (args.some((arg) => arg !== "--write")) {
  throw new Error("[offline Convex API bindings] only --write is supported");
}
const write = args.includes("--write");

function fail(message) {
  throw new Error(`[offline Convex API bindings] ${message}`);
}

function resolveComponentConfig(specifier) {
  if (!specifier.startsWith(".")) {
    try {
      return websiteRequire.resolve(specifier);
    } catch {
      fail(`cannot resolve mounted component ${specifier}`);
    }
  }
  const unresolved = resolve(functionsRoot, specifier);
  const candidates = [
    unresolved,
    unresolved.replace(/\.js$/, ".ts"),
    `${unresolved}.ts`,
    `${unresolved}.js`,
  ];
  const result = candidates.find((candidate) => fs.existsSync(candidate));
  if (!result) fail(`cannot resolve mounted component ${specifier}`);
  return result;
}

function mountedComponents() {
  const rootConfigPath = join(functionsRoot, "convex.config.ts");
  const rootConfig = fs.readFileSync(rootConfigPath, "utf8");
  return parseRootComponents(rootConfig, rootConfigPath, repositoryRoot).map(
    ({ component, specifier }) => {
      const configPath = resolveComponentConfig(specifier);
      const componentDirectory = dirname(configPath);
      const name = parseComponentName(
        fs.readFileSync(configPath, "utf8"),
        configPath,
        repositoryRoot,
      );
      const componentPath = relative(functionsRoot, componentDirectory).split(path.sep).join("/");
      if (!componentPath) fail(`mounted component ${specifier} must resolve to a child directory`);
      return {
        name,
        path: componentPath,
        importSpecifier: specifier.replace(/\/convex\.config(?:\.js)?$/, ""),
        componentDirectory,
        configPath,
        component,
      };
    },
  );
}

function compareModulePaths(a, b) {
  const left = a.split(path.sep).join("/");
  const right = b.split(path.sep).join("/");
  return left < right ? -1 : left > right ? 1 : 0;
}

function localModulePaths(directory) {
  const extensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".jsx"]);
  const modules = [];
  function visit(current) {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const filePath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(join(filePath, "convex.config.ts"))) visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(directory, filePath);
      const extension = extname(filePath).toLowerCase();
      if (!extensions.has(extension)) continue;
      if (relativePath.startsWith(`_deps${path.sep}`))
        fail(`entry point is under _deps: ${relativePath}`);
      if (relativePath.startsWith(`_generated${path.sep}`)) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("#")) continue;
      if (entry.name === "schema.ts" || entry.name === "schema.js") continue;
      if ((entry.name.match(/\./g) ?? []).length > 1) continue;
      if (relativePath.includes(" ")) continue;
      if (
        (extension === ".ts" || extension === ".tsx") &&
        !/^\s{0,100}(import|export)/m.test(fs.readFileSync(filePath, "utf8"))
      )
        continue;
      modules.push(relativePath);
    }
  }
  visit(directory);
  return modules.sort(compareModulePaths).map((modulePath) => modulePath.split(path.sep).join("/"));
}

const convexPackageJson = websiteRequire.resolve("convex/package.json");
const convexPackageRoot = dirname(convexPackageJson);
const packageInfo = JSON.parse(fs.readFileSync(convexPackageJson, "utf8"));
if (packageInfo.version !== auditedConvexVersion) {
  fail(`expected Convex ${auditedConvexVersion}, found ${packageInfo.version}`);
}
const componentApiModule = join(
  convexPackageRoot,
  "dist/esm/cli/codegen_templates/component_api.js",
);
const { componentApiDTS } = await import(pathToFileURL(componentApiModule).href);
const modules = localModulePaths(functionsRoot);
const mounts = mountedComponents();
process.env.RADIUM_OFFLINE_MODULES = JSON.stringify(modules);

const rootComponent = {
  isRoot: true,
  path: functionsRoot,
  definitionPath: join(functionsRoot, "convex.config.ts"),
  isRootWithoutConfig: false,
};
const componentsMap = new Map([[functionsRoot, rootComponent]]);
for (const mount of mounts) {
  componentsMap.set(mount.componentDirectory, {
    isRoot: false,
    path: mount.componentDirectory,
    definitionPath: mount.configPath,
    isRootWithoutConfig: false,
    importSpecifier: mount.importSpecifier,
  });
}

const generated = await componentApiDTS(
  {
    crash: async ({ printedMessage }) => fail(printedMessage ?? "template generation failed"),
  },
  {
    analysis: {
      "": {
        definition: {
          childComponents: mounts.map(({ name, path: componentPath }) => ({
            name,
            path: componentPath,
          })),
        },
      },
    },
  },
  rootComponent,
  rootComponent,
  componentsMap,
  { staticApi: false, useComponentApiImports: true },
);

const prettierPath = createRequire(convexPackageJson).resolve("prettier");
const prettierModule = await import(pathToFileURL(prettierPath).href);
const prettier = prettierModule.default ?? prettierModule;
const formatted = await prettier.format(generated, {
  parser: "typescript",
  pluginSearchDirs: false,
});

if (write) {
  if (!fs.existsSync(dirname(outputPath)))
    fail(`generated directory does not exist: ${relative(repositoryRoot, dirname(outputPath))}`);
  fs.writeFileSync(outputPath, formatted, "utf8");
} else {
  const checkedIn = fs.readFileSync(outputPath, "utf8");
  if (checkedIn !== formatted) {
    fail(`${relative(repositoryRoot, outputPath)} is stale; rerun with --write`);
  }
}

console.log(
  JSON.stringify(
    {
      convexVersion: packageInfo.version,
      output: relative(repositoryRoot, outputPath),
      wrote: write,
      moduleCount: modules.length,
      modules,
      components: mounts.map(({ name, importSpecifier }) => ({ name, importSpecifier })),
      sha256: createHash("sha256").update(formatted).digest("hex"),
    },
    null,
    2,
  ),
);
