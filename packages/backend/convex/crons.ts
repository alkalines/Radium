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
crons.interval("usage limit polling", { minutes: 5 }, internal.limits.pollDue, {});
crons.interval("expired limit events", { hours: 1 }, internal.limits.pruneEvents, {});
export default crons;
