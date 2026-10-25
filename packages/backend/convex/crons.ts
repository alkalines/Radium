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
crons.interval("expired routing state", { minutes: 10 }, internal.routing.prune, {});
export default crons;
