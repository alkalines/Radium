# Worker Component

Private, built Bun workspace package for Radium's isolated Convex Worker
identity persistence. Mounted as `workerIdentity` by the backend.

See the [component guide](../../docs/Worker/Component.md) for the internal
API, trusted app boundary, implementation limits, and verification commands.

```ts
import workerIdentity from "worker-component/convex.config.js";

app.use(workerIdentity);
```

The package follows the [Convex package-authoring layout](https://docs.convex.dev/components/authoring#building-and-publishing-npm-package-components).
Runtime exports resolve to JavaScript in `dist/`; type exports resolve to emitted
declarations. `worker-component/_generated/component.js` exposes Convex's generated
`ComponentApi` type. The package root exports that type and the shared validators.
`worker-component/test` registers the built component with `convex-test`.

From the repository root:

```bash
bun install
bun run build:components
bun run --cwd packages/worker-component typecheck
bun run --cwd packages/backend test convex/worker-component.test.ts
```

`bun run dev` builds first and watches the component alongside Vite and Convex.
After changing function signatures or the schema, explicitly run `bun run codegen`
to generate component bindings, rebuild, and generate app bindings in order. That
command needs the backend's configured deployment. A local build uses checked-in
bindings and requires no deployment access. The package remains `private: true`
and is consumed through `workspace:*`; no npm publication is required.
