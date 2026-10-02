# Worker Component

Private, source-only Bun workspace package for Radium's isolated Convex Worker
identity persistence. Mounted as `workerIdentity` by the backend.

See the [component guide](../../docs/Worker/Component.md) for the internal
API, trusted app boundary, implementation limits, and verification commands.

```ts
import workerIdentity from "worker-component/convex.config.js";

app.use(workerIdentity);
```

The package root exports validators and `ComponentApi`. The conventional
`worker-component/_generated/component.js` export resolves to the
source-derived API type, not a hand-authored generated declaration. All public
boundary IDs are strings; the component normalizes its own IDs internally.
