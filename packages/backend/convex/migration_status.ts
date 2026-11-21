/**
 * Internal-only readiness report for the final Convex export; nothing here is client-callable.
 * Operators run `bunx convex run migration_status:migrationStatus '{}'`; the queries are its
 * bounded sub-checks.
 */
export { e2eeResidue, migrationStatus, queueResidue, scheduledPage } from "../src/migration_status";
