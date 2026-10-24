import type { FunctionReturnType } from "convex/server";

import type { api } from "backend/convex/_generated/api";

/** A Worker identity as listed by the owner-only `api.workers.list` query. */
export type SessionWorker = FunctionReturnType<typeof api.workers.list>[number];

/**
 * The harness that runs a Session (`docs/Interface_Design.md` §2, Agent).
 *
 * - `built-in`: the Radium agent. It runs in Convex (`POST /api/aisdk/chat`) and only reaches the
 *   Worker through the owner-selected Worker tools, so it works with or without a Worker.
 * - `acp`: an external harness spoken to over the Agent Client Protocol, installed on one Worker.
 *   The agent process lives on that Worker, so once a Session has a message its Worker, Directory,
 *   and Agent are fixed.
 *
 * `logo` is a models.dev provider slug for ACP agents; the built-in agent uses the Radium letter.
 */
export type SessionAgent = {
  id: string;
  name: string;
  logo?: string;
  protocol: "built-in" | "acp";
};

/** The default agent of every Session; it is not shown in the Session context label. */
export const builtInAgent: SessionAgent = {
  id: "radium",
  name: "Radium",
  protocol: "built-in",
};

/**
 * Agents the given Worker can run. Today that is only the built-in Radium agent, which does not
 * depend on the Worker at all.
 *
 * ACP integration (planned, not implemented):
 * 1. The Worker advertises the ACP harnesses installed on its host (for example through its
 *    `capabilities` metadata), and this function appends one `acp` agent per advertised harness.
 * 2. The backend persists the chosen agent on the chat (accepted by `api.aisdk.CreateChat` next to
 *    `worker`), and `GetChat` returns it so the Session context can show `Worker (Agent)`.
 * 3. The chat transport routes the turn of an `acp` Session to that Worker instead of the Convex
 *    model pipeline.
 * Changing the Worker falls back to `builtInAgent` when the chosen ACP agent is missing there;
 * callers already apply that rule through `agentsOnWorker`.
 */
export function agentsOnWorker(_worker: SessionWorker | undefined): SessionAgent[] {
  return [builtInAgent];
}
