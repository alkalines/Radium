import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(scriptsDirectory, "..");
const repositoryRoot = resolve(websiteRoot, "../..");
const functionsRoot = join(websiteRoot, "convex");
const outputPath = join(functionsRoot, "_generated", "api.d.ts");
const websitePackageJson = join(websiteRoot, "package.json");
const websiteRequire = createRequire(websitePackageJson);
const auditedConvexVersion = "1.45.0";
const args = process.argv.slice(2);

if (args.some((arg) => arg !== "--write")) {
  throw new Error("[offline Convex API bindings] only --write is supported");
}
const write = args.includes("--write");

function fail(message) {
  throw new Error(`[offline Convex API bindings] ${message}`);
}

function stripComments(source, filePath) {
  let result = "";
  let quote;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) fail(`unterminated comment in ${relative(repositoryRoot, filePath)}`);
      result += " ";
      index = end + 1;
    } else {
      result += character;
    }
  }
  if (quote) fail(`unterminated string in ${relative(repositoryRoot, filePath)}`);
  return result;
}

function statements(filePath) {
  const source = stripComments(fs.readFileSync(filePath, "utf8"), filePath)
    .replace(/\s+/g, " ")
    .trim();
  if (!source.endsWith(";"))
    fail(`${relative(repositoryRoot, filePath)} must use semicolon-terminated statements`);
  const result = source.split(";").map((statement) => statement.trim());
  if (result[result.length - 1] !== "")
    fail(`unsupported semicolon syntax in ${relative(repositoryRoot, filePath)}`);
  return result.slice(0, -1).filter(Boolean);
}

function splitTopLevel(source, delimiter = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")] }".replace(/ /g, "").includes(character)) {
      depth -= 1;
      if (depth < 0) fail("unbalanced config expression");
    } else if (character === delimiter && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) fail("unbalanced config expression");
  parts.push(source.slice(start).trim());
  return parts;
}

function objectProperties(source, description) {
  const value = source.trim();
  if (!value.startsWith("{") || !value.endsWith("}"))
    fail(`${description} must be an object literal`);
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const parts = splitTopLevel(body);
  if (parts.at(-1) === "") parts.pop();
  return parts.map((part) => {
    if (!part) fail(`${description} contains an empty property`);
    const colon = splitTopLevel(part, ":");
    if (colon.length !== 2 || !/^[$A-Za-z_][$A-Za-z0-9_]*$/.test(colon[0])) {
      fail(`${description} contains an unsupported property`);
    }
    return { name: colon[0], value: colon[1] };
  });
}

function rootEnvironmentObject(source, description) {
  for (const property of objectProperties(source, description)) {
    const match = /^process\.env\.([$A-Za-z_][$A-Za-z0-9_]*)!?$/.exec(property.value);
    if (!match || match[1] !== property.name) {
      fail(`${description}.${property.name} uses an unsupported environment expression`);
    }
  }
}

const supportedValidators = new Set([
  "any",
  "array",
  "bigint",
  "boolean",
  "bytes",
  "float64",
  "id",
  "int64",
  "literal",
  "null",
  "number",
  "object",
  "optional",
  "record",
  "string",
  "union",
]);

function validatorArgument(source, description) {
  const value = source.trim();
  if (/^(?:["'](?:\\.|[^"'])*["']|[0-9]+(?:\.[0-9]+)?|true|false)$/.test(value)) return;
  if (/^v\.[A-Za-z_$][\w$]*\(.*\)$/.test(value)) {
    validatorExpression(value, description);
    return;
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    for (const property of objectProperties(value, description))
      validatorArgument(property.value, `${description}.${property.name}`);
    return;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    for (const item of splitTopLevel(value.slice(1, -1))) {
      if (item) validatorArgument(item, `${description} array item`);
    }
    return;
  }
  fail(`${description} uses unsupported validator argument syntax`);
}

function validatorExpression(source, description) {
  const match = /^v\.([A-Za-z_$][\w$]*)\((.*)\)$/.exec(source.trim());
  if (!match || !supportedValidators.has(match[1]))
    fail(`${description} uses unsupported validator syntax`);
  const args = match[2].trim() ? splitTopLevel(match[2]) : [];
  for (const [index, argument] of args.entries())
    validatorArgument(argument, `${description} argument ${index + 1}`);
}

function componentOptions(source, validatorImported) {
  const options = objectProperties(source, "component options");
  const names = new Set();
  for (const option of options) {
    if (names.has(option.name)) fail(`component options repeat ${option.name}`);
    names.add(option.name);
    if (option.name !== "env") fail(`unsupported component option ${option.name}`);
    if (!validatorImported) fail("component env requires the convex/values v import");
    for (const property of objectProperties(option.value, "component env")) {
      validatorExpression(property.value, `component env.${property.name}`);
    }
  }
}

function componentName(configPath) {
  const parsed = statements(configPath);
  let defineComponentImported = false;
  let validatorImported = false;
  for (const statement of parsed) {
    const serverImport = /^import \{ defineComponent \} from "convex\/server"$/.test(statement);
    const valuesImport = /^import \{ v \} from "convex\/values"$/.test(statement);
    if (serverImport) defineComponentImported = true;
    else if (valuesImport) validatorImported = true;
    else if (statement.startsWith("import "))
      fail(`unsupported component config import in ${relative(repositoryRoot, configPath)}`);
  }
  if (!defineComponentImported)
    fail(`component config must import defineComponent from convex/server`);

  let declaration;
  let exported = false;
  let exportedIdentifier;
  let name;
  for (const statement of parsed) {
    if (statement.startsWith("import ")) continue;
    const declarationMatch = /^const ([$A-Za-z_][$A-Za-z0-9_]*) = (defineComponent\(.*\))$/.exec(
      statement,
    );
    if (declarationMatch) {
      if (declaration) fail(`component config declares more than one component`);
      declaration = declarationMatch[1];
      name = parseComponentCall(declarationMatch[2], validatorImported, configPath);
      continue;
    }
    const exportMatch = /^export default (.*)$/.exec(statement);
    if (exportMatch) {
      if (exported) fail(`component config exports more than once`);
      exported = true;
      if (exportMatch[1].startsWith("defineComponent(")) {
        if (declaration) fail("component config mixes direct and declared component exports");
        name = parseComponentCall(exportMatch[1], validatorImported, configPath);
      } else {
        exportedIdentifier = exportMatch[1];
      }
      continue;
    }
    fail(`unsupported component config syntax in ${relative(repositoryRoot, configPath)}`);
  }
  if (!exported) fail(`component config must have one export default`);
  if (exportedIdentifier && (!declaration || exportedIdentifier !== declaration)) {
    fail("component config must export its defineComponent value");
  }
  if (!name) fail("component config must export defineComponent(...)");
  return name;
}

function parseComponentCall(source, validatorImported, configPath) {
  const match = /^defineComponent\(("([^"\\]*)"|'([^'\\]*)')(?:,\s*(.*))?\)$/.exec(source);
  if (!match) fail(`unsupported defineComponent syntax in ${relative(repositoryRoot, configPath)}`);
  const name = match[2] ?? match[3];
  if (!name) fail("component name cannot be empty");
  if (match[4]) componentOptions(match[4], validatorImported);
  return name;
}

function rootComponents() {
  const configPath = join(functionsRoot, "convex.config.ts");
  const parsed = statements(configPath);
  const imports = new Map();
  let defineAppImported = false;
  for (const statement of parsed) {
    if (!statement.startsWith("import ")) break;
    if (/^import \{ defineApp \} from "convex\/server"$/.test(statement)) {
      if (defineAppImported) fail("root config imports defineApp more than once");
      defineAppImported = true;
      continue;
    }
    const match = /^import ([$A-Za-z_][$A-Za-z0-9_]*) from "([^"]+)"$/.exec(statement);
    if (!match || !/\/convex\.config(?:\.js)?$/.test(match[2])) {
      fail(`unsupported root config import in ${relative(repositoryRoot, configPath)}`);
    }
    if (imports.has(match[1])) fail(`duplicate root component import ${match[1]}`);
    imports.set(match[1], match[2]);
  }
  if (!defineAppImported) fail("root config must import defineApp from convex/server");

  let appDeclared = false;
  let appExported = false;
  const mounts = [];
  for (const statement of parsed) {
    if (statement.startsWith("import ")) continue;
    if (statement === "const app = defineApp()") {
      if (appDeclared) fail("root config declares app more than once");
      appDeclared = true;
      continue;
    }
    const match = /^app\.use\(([$A-Za-z_][$A-Za-z0-9_]*)(?:,\s*(.*))?\)$/.exec(statement);
    if (match) {
      const specifier = imports.get(match[1]);
      if (!specifier) fail(`app.use references unsupported component ${match[1]}`);
      if (match[2]) {
        const options = objectProperties(match[2], `app.use(${match[1]}) options`);
        if (options.length !== 1 || options[0].name !== "env")
          fail(`app.use(${match[1]}) uses unsupported options`);
        rootEnvironmentObject(options[0].value, `app.use(${match[1]}).env`);
      }
      if (mounts.some((mount) => mount.component === match[1]))
        fail(`component ${match[1]} is mounted more than once`);
      mounts.push({ component: match[1], specifier });
      continue;
    }
    if (statement === "export default app") {
      if (appExported) fail("root config exports app more than once");
      appExported = true;
      continue;
    }
    fail(`unsupported root config syntax in ${relative(repositoryRoot, configPath)}`);
  }
  if (!appDeclared || !appExported) fail("root config must define and export app");
  if (mounts.length !== imports.size)
    fail("every imported component must have exactly one direct app.use mount");
  return mounts.map(({ specifier, ...mount }) => ({ ...mount, specifier }));
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
  return rootComponents().map(({ component, specifier }) => {
    const configPath = resolveComponentConfig(specifier);
    const componentDirectory = dirname(configPath);
    const name = componentName(configPath);
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
  });
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
