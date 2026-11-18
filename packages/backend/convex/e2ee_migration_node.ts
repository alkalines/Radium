"use node";

/**
 * Node-runtime (512 MiB) phase 9 actions: the job driver and custody creation. Registered from
 * `src/e2ee/migration-node.ts`; queries, mutations and schema stay in `e2ee_migration.ts`.
 */
export { createCustody, runJob } from "../src/e2ee/migration-node";
