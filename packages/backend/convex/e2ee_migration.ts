/** Internal-only phase 9 cutover, custody and legacy sealing entry points; nothing here is client-callable. */
export {
  advance,
  commitRelease,
  commitSeal,
  custodialRows,
  custodyPublicKey,
  custodySeed,
  discardSidecar,
  endCustody,
  failJob,
  finishCutover,
  installCustody,
  loadPage,
  pauseJob,
  resumeJob,
  setFrozen,
  startJobs,
  status,
} from "../src/e2ee/migration-core";
// The `runJob`/`createCustody` actions live in `e2ee_migration_node.ts` (Node runtime, 512 MiB).
