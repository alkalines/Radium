import { relative } from "node:path";

function fail(message) {
  throw new Error(`[offline Convex API bindings] ${message}`);
}

function stripComments(source, filePath, repositoryRoot) {
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

function statements(source, filePath, repositoryRoot) {
  const text = stripComments(source, filePath, repositoryRoot).replace(/\s+/g, " ").trim();
  if (!text.endsWith(";"))
    fail(`${relative(repositoryRoot, filePath)} must use semicolon-terminated statements`);
  const result = text.split(";").map((statement) => statement.trim());
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
    } else if (")]}".includes(character)) {
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

function validateEnvironmentValidator(source, description, allowOptional = true) {
  const match = /^v\.([A-Za-z_$][\w$]*)\((.*)\)$/.exec(source.trim());
  if (!match) fail(`${description} uses unsupported environment validator syntax`);
  const args = match[2].trim() ? splitTopLevel(match[2]) : [];

  if (match[1] === "string") {
    if (args.length !== 0) fail(`${description} v.string() takes no arguments`);
    return;
  }
  if (match[1] === "literal") {
    if (args.length !== 1 || !/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(args[0])) {
      fail(`${description} must use a string literal`);
    }
    return;
  }
  if (match[1] === "union") {
    if (args.length < 2) fail(`${description} v.union() requires at least two validators`);
    for (const [index, argument] of args.entries()) {
      validateEnvironmentValidator(argument, `${description} union item ${index + 1}`, false);
    }
    return;
  }
  if (match[1] === "optional" && allowOptional) {
    if (args.length !== 1) fail(`${description} v.optional() requires one validator`);
    validateEnvironmentValidator(args[0], description, false);
    return;
  }
  fail(`${description} uses unsupported environment validator ${match[1]}`);
}

function environmentDefinition(source, description, validatorImported) {
  const names = new Set();
  for (const property of objectProperties(source, description)) {
    if (names.has(property.name)) fail(`${description} repeats ${property.name}`);
    names.add(property.name);
    if (!validatorImported) fail(`${description} requires the convex/values v import`);
    validateEnvironmentValidator(property.value, `${description}.${property.name}`);
  }
  return names;
}

function optionsEnvironment(source, description, validatorImported) {
  if (!source.trim()) return new Set();
  let environment = new Set();
  const names = new Set();
  for (const option of objectProperties(source, description)) {
    if (names.has(option.name)) fail(`${description} repeats ${option.name}`);
    names.add(option.name);
    if (option.name !== "env") fail(`unsupported ${description} option ${option.name}`);
    environment = environmentDefinition(option.value, `${description}.env`, validatorImported);
  }
  return environment;
}

function rootEnvironmentObject(source, description, appEnvironment) {
  for (const property of objectProperties(source, description)) {
    const processEnvironment = /^process\.env\.([$A-Za-z_][$A-Za-z0-9_]*)!?$/.exec(property.value);
    if (processEnvironment && processEnvironment[1] === property.name) continue;

    const appEnvironmentReference = /^app\.env\.([$A-Za-z_][$A-Za-z0-9_]*)$/.exec(property.value);
    if (appEnvironmentReference && appEnvironment.has(appEnvironmentReference[1])) continue;

    fail(`${description}.${property.name} uses an unsupported environment expression`);
  }
}

function parseComponentOptions(source, validatorImported) {
  optionsEnvironment(source, "component options", validatorImported);
}

function parseComponentCall(source, validatorImported, configPath, repositoryRoot) {
  const match = /^defineComponent\(("([^"\\]*)"|'([^'\\]*)')(?:,\s*(.*))?\)$/.exec(source);
  if (!match) fail(`unsupported defineComponent syntax in ${relative(repositoryRoot, configPath)}`);
  const name = match[2] ?? match[3];
  if (!name) fail("component name cannot be empty");
  if (match[4]) parseComponentOptions(match[4], validatorImported);
  return name;
}

/** Read an isolated component's name without executing its configuration. */
export function parseComponentName(source, configPath, repositoryRoot) {
  const parsed = statements(source, configPath, repositoryRoot);
  let defineComponentImported = false;
  let validatorImported = false;
  const childImports = new Map();
  for (const statement of parsed) {
    const serverImport = /^import \{ defineComponent \} from "convex\/server"$/.test(statement);
    const valuesImport = /^import \{ v \} from "convex\/values"$/.test(statement);
    if (serverImport) {
      if (defineComponentImported) fail("component config imports defineComponent more than once");
      defineComponentImported = true;
    } else if (valuesImport) {
      if (validatorImported) fail("component config imports v more than once");
      validatorImported = true;
    } else if (statement.startsWith("import ")) {
      const match =
        /^import ([$A-Za-z_][$A-Za-z0-9_]*) from "([^"]+\/convex\.config(?:\.js)?)"$/.exec(
          statement,
        );
      if (!match)
        fail(`unsupported component config import in ${relative(repositoryRoot, configPath)}`);
      childImports.set(match[1], match[2]);
    }
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
      name = parseComponentCall(declarationMatch[2], validatorImported, configPath, repositoryRoot);
      continue;
    }
    const exportMatch = /^export default (.*)$/.exec(statement);
    if (exportMatch) {
      if (exported) fail(`component config exports more than once`);
      exported = true;
      if (exportMatch[1].startsWith("defineComponent(")) {
        if (declaration) fail("component config mixes direct and declared component exports");
        name = parseComponentCall(exportMatch[1], validatorImported, configPath, repositoryRoot);
      } else {
        exportedIdentifier = exportMatch[1];
      }
      continue;
    }
    const useMatch = /^([$A-Za-z_][$A-Za-z0-9_]*)\.use\(([$A-Za-z_][$A-Za-z0-9_]*)\)$/.exec(
      statement,
    );
    if (useMatch && useMatch[1] === declaration && childImports.has(useMatch[2])) continue;
    fail(`unsupported component config syntax in ${relative(repositoryRoot, configPath)}`);
  }
  if (!exported) fail(`component config must have one export default`);
  if (exportedIdentifier && (!declaration || exportedIdentifier !== declaration)) {
    fail("component config must export its defineComponent value");
  }
  if (!name) fail("component config must export defineComponent(...)");
  return name;
}

/**
 * Read direct component mounts using the audited static config grammar.
 * Env validators/references are checked structurally, never evaluated. Unsupported
 * expressions fail closed so API generation cannot execute config or read secrets.
 */
export function parseRootComponents(source, configPath, repositoryRoot) {
  const parsed = statements(source, configPath, repositoryRoot);
  const imports = new Map();
  let defineAppImported = false;
  let validatorImported = false;
  for (const statement of parsed) {
    if (!statement.startsWith("import ")) continue;
    if (/^import \{ defineApp \} from "convex\/server"$/.test(statement)) {
      if (defineAppImported) fail("root config imports defineApp more than once");
      defineAppImported = true;
      continue;
    }
    if (/^import \{ v \} from "convex\/values"$/.test(statement)) {
      if (validatorImported) fail("root config imports v more than once");
      validatorImported = true;
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
  let appEnvironment = new Set();
  const mounts = [];
  for (const statement of parsed) {
    if (statement.startsWith("import ")) continue;
    const appDeclaration = /^const app = defineApp\((.*)\)$/.exec(statement);
    if (appDeclaration) {
      if (appDeclared) fail("root config declares app more than once");
      appDeclared = true;
      appEnvironment = optionsEnvironment(appDeclaration[1], "app options", validatorImported);
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
        rootEnvironmentObject(options[0].value, `app.use(${match[1]}).env`, appEnvironment);
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
