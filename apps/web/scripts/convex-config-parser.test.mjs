import assert from "node:assert/strict";
import test from "node:test";
import { parseComponentName, parseRootComponents } from "./convex-config-parser.mjs";

const repositoryRoot = "/repo";
const rootConfigPath = "/repo/packages/backend/convex/convex.config.ts";

test("parses typed app env declarations and references from component mounts", () => {
  const config = `
    import { defineApp } from "convex/server";
    import { v } from "convex/values";
    import secretStore from "convex-secret-store/convex.config.js";
    const app = defineApp({ env: {
      STORE_KEY_MATERIAL: v.string(),
      LOG_LEVEL: v.optional(v.union(v.literal("debug"), v.literal("info"))),
    } });
    app.use(secretStore, { env: { SECRET_STORE_KEYS: app.env.STORE_KEY_MATERIAL } });
    export default app;
  `;

  assert.deepEqual(parseRootComponents(config, rootConfigPath, repositoryRoot), [
    { component: "secretStore", specifier: "convex-secret-store/convex.config.js" },
  ]);
});

test("keeps legacy literal process.env component bindings supported", () => {
  const config = `
    import { defineApp } from "convex/server";
    import secretStore from "convex-secret-store/convex.config.js";
    const app = defineApp();
    app.use(secretStore, { env: { SECRET_STORE_KEYS: process.env.SECRET_STORE_KEYS! } });
    export default app;
  `;

  assert.equal(parseRootComponents(config, rootConfigPath, repositoryRoot).length, 1);
});

test("checks root imports throughout the config, including after component mounts", () => {
  const lateValidImport = `
    import { defineApp } from "convex/server";
    const app = defineApp();
    app.use(secretStore);
    import secretStore from "convex-secret-store/convex.config.js";
    export default app;
  `;
  const lateUnsupportedImport = `
    import { defineApp } from "convex/server";
    const app = defineApp();
    import secretStore from "not-a-component";
    export default app;
  `;
  const lateDuplicateImport = `
    import { defineApp } from "convex/server";
    const app = defineApp();
    import secretStore from "convex-secret-store/convex.config.js";
    import secretStore from "another-component/convex.config.js";
    app.use(secretStore);
    export default app;
  `;

  assert.deepEqual(parseRootComponents(lateValidImport, rootConfigPath, repositoryRoot), [
    { component: "secretStore", specifier: "convex-secret-store/convex.config.js" },
  ]);
  assert.throws(
    () => parseRootComponents(lateUnsupportedImport, rootConfigPath, repositoryRoot),
    /unsupported root config import/,
  );
  assert.throws(
    () => parseRootComponents(lateDuplicateImport, rootConfigPath, repositoryRoot),
    /duplicate root component import secretStore/,
  );
});

test("rejects undeclared app env references and dynamic env expressions", () => {
  const undeclared = `
    import { defineApp } from "convex/server";
    import { v } from "convex/values";
    import secretStore from "convex-secret-store/convex.config.js";
    const app = defineApp({ env: { SECRET_STORE_KEYS: v.string() } });
    app.use(secretStore, { env: { SECRET_STORE_KEYS: app.env.OTHER_KEY } });
    export default app;
  `;
  const dynamic = `
    import { defineApp } from "convex/server";
    import secretStore from "convex-secret-store/convex.config.js";
    const app = defineApp();
    app.use(secretStore, { env: { SECRET_STORE_KEYS: process.env[name] } });
    export default app;
  `;

  assert.throws(
    () => parseRootComponents(undeclared, rootConfigPath, repositoryRoot),
    /unsupported environment expression/,
  );
  assert.throws(
    () => parseRootComponents(dynamic, rootConfigPath, repositoryRoot),
    /unsupported environment expression/,
  );
});

test("parses an explicitly empty component env contract", () => {
  const config = `
    import { defineComponent } from "convex/server";
    export default defineComponent("workerIdentity", { env: {} });
  `;

  assert.equal(
    parseComponentName(
      config,
      "/repo/packages/worker-component/src/component/convex.config.ts",
      repositoryRoot,
    ),
    "workerIdentity",
  );
});

test("rejects non-string env validators and unsupported app options", () => {
  const invalidValidator = `
    import { defineApp } from "convex/server";
    import { v } from "convex/values";
    const app = defineApp({ env: { BAD_VALUE: v.boolean() } });
    export default app;
  `;
  const unsupportedOption = `
    import { defineApp } from "convex/server";
    const app = defineApp({ dynamicOptions: true });
    export default app;
  `;

  assert.throws(
    () => parseRootComponents(invalidValidator, rootConfigPath, repositoryRoot),
    /unsupported environment validator boolean/,
  );
  assert.throws(
    () => parseRootComponents(unsupportedOption, rootConfigPath, repositoryRoot),
    /unsupported app options option dynamicOptions/,
  );
});
