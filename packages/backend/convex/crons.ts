import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
  "expired worker auth challenges",
  { minutes: 1 },
  internal.workers.pruneChallenges,
  {},
);
crons.interval("terminal worker tasks", { minutes: 5 }, internal.worker_tasks.prune, {});
export default crons;
