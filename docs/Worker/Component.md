# Worker Identity Component

Status: **implemented persistence package and backend mount**. Worker machine
authentication, app authorization wrappers, transport, and execution remain planned.

## Packages And Integration Boundary

`packages/worker-component` is a private, built Bun workspace package following
the [Convex package-authoring pattern](https://docs.convex.dev/components/authoring#building-and-publishing-npm-package-components).
`packages/backend/package.json` declares `worker-component: workspace:*`;
`packages/backend/convex/convex.config.ts` mounts its `convex.config.js` export
with `app.use(workerIdentity)`.

TypeScript emits JavaScript, declarations and source maps into `dist/`. Package
exports point to this output, so the backend mounts the same files that a packaged
consumer would use. The root exports shared validators and Convex's generated
`ComponentApi` type; `/_generated/component.js` is a type-only entry point to
`dist/component/_generated/component.d.ts`. There is no custom API type mapping.
The `/test` entry point registers the built schema and JavaScript modules with
`convex-test`, including when the app chooses a custom mount name.

The separate HTTP client package has been removed. Durable control operations
belong in Convex queries/mutations, called through authenticated app wrappers.
App handlers use `components.workerIdentity` with `ctx.runQuery` or
`ctx.runMutation`. For example, after resolving owner authorization:

```ts
const workers = await ctx.runQuery(components.workerIdentity.identities.listWorkers, {
  workspaceId: authorizedWorkspace._id,
  limit: 50,
});
```

Components are internal and do not inherit the app's Better Auth sessions.
The browser and Worker process cannot call component functions directly. Future
Worker control subscriptions target narrowly authenticated app queries; mounting
this component does not implement those endpoints or machine identity validation.
Public wrappers and transport routes have not been added yet.

`packages/worker/src/index.ts` remains the external health-only service. Its future
Convex Client connection and ACP/process work are separate from identity persistence.
The component declares no environment variables and requires no hosted identity
provider, collector or network service. See the selected
[Convex Client transport plan](Convex_Transport.md) for the proposed authenticated
control and batched output integration.

## Isolated State

`src/component/schema.ts` owns:

- `enrollments`: workspace string, SHA-256 token digest, name, allowed capabilities,
  expiry, lifecycle state, and committed worker/key/request mapping.
- `workers`: workspace string, name, capabilities, active/revoked status and
  identity epoch. One workspace per worker; multiple workers per workspace.
- `keys`: worker reference and normalized public algorithm/material/thumbprint.
  A thumbprint belongs to only one worker, including after revocation;
  re-enrollment requires a fresh key.

No private keys, raw setup tokens, jobs, transcripts, heartbeats or ACP frames are
stored here. All public component IDs and parent workspace IDs are strings at
the boundary; the component normalizes its own IDs internally.

## Internal API

Every registered function has argument and return validators.

- `enrollment.createEnrollment`: accepts an app-generated SHA-256 lowercase hex
  digest, scope, name, capabilities and expiry. Rejects duplicate hashes. Expiry
  must be in the future and at most one hour away. Returns the enrollment selector.
- `enrollment.completeEnrollment`: transactionally consumes an unused enrollment
  and inserts its worker and public key. Checks workspace, expiry, revocation and
  key uniqueness. Exact retries return the committed identity; changed request ID
  or key material is rejected.
- `enrollment.recoverEnrollment`: returns the committed identity for an enrollment
  selector and app-verified original key thumbprint. Recovery and exact completion
  retries work after token expiry, but fail after worker revocation.
- `enrollment.revokeEnrollment`: revokes an unused scoped enrollment. Completed
  enrollment requires `identities.revokeWorker` instead.
- `enrollment.pruneEnrollments`: deletes expired unused/revoked enrollment records
  in indexed batches of 1–100; preserves completed recovery receipts.
- `identities.getWorkerMetadata`: returns scoped name, capabilities, status and
  epoch, without key or token material.
- `identities.listWorkers`: bounded first-page read of 1–100 workspace metadata
  records, not a paginated listing.
- `identities.getVerificationKey`: returns public material and current epoch only
  for an active worker in the requested workspace, otherwise `null`.
- `identities.revokeWorker`: marks the scoped worker revoked and advances its
  epoch once. Repeated revocation returns the same epoch; verification lookup and
  recovery reject revoked authority.

Creation bounds workspace/name strings to 256 characters and capabilities to 32
distinct strings of at most 128 characters. Public algorithm/material/thumbprint
strings are bounded to 32/4096/256 characters. They are **not cryptographically
validated** here: the app's selected verifier must restrict algorithms, normalize
keys and recompute thumbprints. No signature profile has been selected.

Failures use `ConvexError({ code })`, including `ENROLLMENT_EXPIRED`,
`ENROLLMENT_ALREADY_USED`, `KEY_MISMATCH`, `WORKER_REVOKED`, and `WORKER_NOT_FOUND`.
Cross-workspace access does not disclose foreign records. Future public wrappers
must collapse error details where needed to avoid enumeration.

## Trusted App Responsibilities

1. Validate the Better Auth session and workspace owner/archived-workspace policy
   before creation or revocation. Workspace equality is scope enforcement, not
   owner authentication.
2. Generate at least 32 random token bytes outside persistence function arguments,
   pass only the digest and deliver setup information securely. Use a fresh
   token/hash per enrollment. Include the enrollment selector for later token-free
   recovery. Keep tokens out of URLs and logs.
3. Verify fresh proof bound to deployment, enrollment, public key and request before
   completion/recovery. Pass server-derived workspace and verified key material,
   never client assertions such as `verified: true`.
4. Re-read current key/epoch inside the same parent mutation as an authorized state
   transition and compare it with the verified context. An earlier action lookup
   alone permits a revoke/commit race.
5. Own rate limits, challenges, signed-request replay admission, grants,
   workspace/chat/job policy, configuration and any necessary HTTP boundary.

Nested component operations participate in the parent mutation transaction. An
uncaught parent error rolls back registration and enrollment consumption together.
The enrollment request ID binds exact retries; it is not general replay protection.
Do not complete enrollment from an action and commit related app state separately.

## Reuse Decision

The [Convex catalog](https://www.convex.dev/components/llms.txt),
[`convex-invite`](https://github.com/dciccale/convex-invite/tree/main/packages/convex-invite),
and [convex-helpers](https://github.com/get-convex/convex-helpers) were evaluated.
`convex-invite` supports machine audiences, transactional acceptance and recovery,
but issuance/acceptance carry raw tokens through component mutations. This package
uses external hashes and selector/key-bound recovery without resending the token.
The invitation delivery/state API also exceeds this small identity boundary. This
is a fit decision, not a security-defect claim. Bearer API-key components do not
own the public-key identity contract; helpers remain suitable for future wrappers
and pagination, not identity persistence.

## Verification And Naming

From the repository root:

```bash
bun install --frozen-lockfile
bun run build:components
bun run --cwd packages/worker-component typecheck
bun run --cwd packages/backend test convex/worker-component.test.ts
```

Local builds use the checked-in generated bindings. `bun run dev` builds before
starting the component TypeScript watcher, Vite and Convex. The watcher rebuilds
implementation changes; it does not regenerate API bindings. After changing the
schema or function signatures, run `bun run codegen`: it bootstraps the package
output, runs standard component codegen, rebuilds, then generates backend bindings.
Both codegen steps use the backend's configured deployment; the component step
selects `src/component` with `--component-dir`. See
[standard binding codegen](../deployment.md#standard-binding-codegen).

The custom component offline generator and source-derived API mapping have been
removed. Convex owns `src/component/_generated/component.ts` and the other generated
files; regenerate them through the standard CLI when deployment access is
authorized. Never hand-edit generated files.

Refresh backend references with the existing
[offline API binding command](../deployment.md#offline-api-binding-codegen).
That offline backend command does not refresh the component's generated contract
or verify deployment/component analysis.

Worker naming covers the packages, `workerIdentity` mount, `workers` table,
`workerId` fields, metadata/revocation methods and `WORKER_*` error codes. This
renames the undeployed component created in this session; no persisted records
were migrated or remote deployment changed.

Eight handler regressions cover exact retries, changed key/request rejection,
expiry, scoped/revoked denial, key uniqueness, recovery after expiry, bounded
cleanup and parent transaction rollback. Deployed OCC races, cryptography,
network transport and owner/machine authorization remain unverified.

The packaged-component follow-up passed `bun run build:components`,
`bun run --cwd packages/worker-component typecheck`, and
`bun run --cwd packages/backend test convex/worker-component.test.ts` (**8 tests**).
`bun run test` also passed **113 tests in 23 files**, including the initial package
build. Frozen-lockfile installation and runtime package-export resolution passed.
The handler regressions now load the package's built `/test` entry point rather
than importing component source paths. No remote generation, deployment or
migration was run.

## Planned And Known Limitations

- App wrappers, challenges/replay, rotation, grants, machine JWT issuer,
  subscriptions, Convex-mediated output, ACP and execution integration remain future work.
- Completed receipts and worker/key records are retained indefinitely. Cleanup of
  unused tokens is explicit; no cron or lifecycle deletion policy is installed.
- Revocation persists authority but does not propagate to sockets or processes yet.
- Listing provides a bounded first page; management pagination is future work.
- The existing root formatter/linter workspace-resolution issues are separate:
  use the web package's installed formatter for scoped checks. Root ESLint config
  currently cannot resolve its `eslint` dependency.

See [task 06](../tasks/06_Chatroom_Worker.md) for the remaining integration and
execution-isolation work.
