# Workspace Operations And Documentation

Status: Not started. Independent task for existing workspace migration drift.

## Entry Points

Root and package `package.json` files, `README.md`, `docs/architecture.md`,
`docs/deployment.md`, `docs/api.md`, `docker-compose*.yml`,
`packages/website/Dockerfile*`, `packages/website/docker/`, root ESLint config,
and `.github/workflows/release.yml`.

## Work

1. Correct stale root `src/`, `convex/`, and website command references in existing guides. Preserve actual deployment caveats until behavior changes.
2. Verify Docker build contexts against the root workspace lockfile and dependencies; inspection found website-only contexts copying an unavailable root `bun.lock` and release references to moved Dockerfiles.
3. Repair workspace lint resolution and define useful scoped test/typecheck commands after inventorying existing failures. Do not hide diagnostics or mix broad code cleanup into tooling work.
4. Verify clean-install, local development, production build/start, and container/release paths without publishing or deploying. Document what was actually exercised and separate environmental blockers.
5. Update README quick start and the owning operational guides in the same change. Product guides follow `AGENTS.md`; do not duplicate architecture prose across every file.

## Acceptance

- Documented root commands exist and resolve workspace dependencies correctly.
- Build contexts and release paths refer to files that actually exist.
- Local checks have reproducible commands and baseline failures are recorded, not silently suppressed.
- No remote release, deployment, or incidental product/schema change.
