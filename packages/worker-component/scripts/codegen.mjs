import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Offline bootstrap using installed templates only. No CLI, deployment selection,
// bundling, remote component analysis, or synthetic deployment analysis.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const convexPackage = require.resolve("convex/package.json");
const { version } = JSON.parse(readFileSync(convexPackage, "utf8"));
if (version !== "1.46.0") throw new Error(`Unaudited Convex template version: ${version}`);
const templates = join(dirname(convexPackage), "dist/esm/cli/codegen_templates");
const load = (name) => import(pathToFileURL(join(templates, `${name}.js`)).href);
const [{ componentServerTS }, { dynamicDataModelTS }, { apiCodegen }] = await Promise.all([
  load("component_server"),
  load("dataModel"),
  load("api"),
]);
const prettier = createRequire(convexPackage)("prettier");
const generated = join(root, "src/component/_generated");
mkdirSync(generated, { recursive: true });
const files = {
  "server.ts": componentServerTS(false, []),
  "dataModel.ts": dynamicDataModelTS(),
  "api.ts": apiCodegen(["enrollment.ts", "identities.ts"], { useTypeScript: true }).TS,
};
for (const [name, source] of Object.entries(files)) {
  writeFileSync(join(generated, name), await prettier.format(source, { parser: "typescript" }));
}
console.log(
  `Generated ${Object.keys(files).length} offline component bindings (Convex ${version}).`,
);
