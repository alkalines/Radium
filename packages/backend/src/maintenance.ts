import { customAction, customCtx, customMutation } from "convex-helpers/server/customFunctions";
import type { MiddlewareHandler } from "hono";
import { ConvexError } from "convex/values";
import { action as convexAction, mutation as convexMutation } from "../convex/_generated/server";

/**
 * Maintenance mode of the last Convex version (docs/deployment.md#last-convex-version-migration-status-and-maintenance-mode).
 *
 * The flag is the deployment environment variable `RADIUM_MAINTENANCE`, read per call from the
 * function environment, so checking it costs no database I/O and toggling it needs no deploy.
 * `convex.config.ts` declares its values, so the deployment rejects any other:
 *
 * - unset: `off`, every write path is open;
 * - `"drain"`: browser, API-key and sign-in writes are closed, Worker writes stay open so claimed
 *   commands and tasks can finish before the export;
 * - `"1"`: `on`, Worker writes are closed too. Any other value (only possible where the declared
 *   validator is not enforced, such as offline tests) also means `on`, failing closed.
 *
 * Internal functions, crons and scheduled functions are never gated: they are reachable only from
 * server code, and operators still need them (remediation, `migrationStatus`). Their writes after
 * the export are not in the snapshot.
 */
export type MaintenanceMode = "off" | "drain" | "on";

/** Who is writing: browser sessions and API clients, or a verified Worker machine. */
export type WriteSurface = "browser" | "worker";

/** Stable `ConvexError` code and HTTP error code of a write refused by maintenance mode. */
export const MAINTENANCE_ERROR_CODE = "MAINTENANCE";

/** Seconds a refused HTTP client should wait before retrying (`Retry-After`). */
const RETRY_AFTER_SECONDS = 300;

const MAINTENANCE_MESSAGE = "Radium is in maintenance; writes are temporarily disabled.";

/** Current mode from `RADIUM_MAINTENANCE`; see {@link MaintenanceMode}. */
export function maintenanceMode(): MaintenanceMode {
  const value = process.env.RADIUM_MAINTENANCE;
  if (value === undefined || value === "") return "off";
  if (value === "drain") return "drain";
  return "on";
}

/** Whether the current mode refuses writes from `surface`. */
export function writesClosed(surface: WriteSurface): boolean {
  const mode = maintenanceMode();
  return mode === "on" || (mode === "drain" && surface === "browser");
}

/**
 * Throw `ConvexError({ code: "MAINTENANCE" })` when the current mode refuses writes from `surface`.
 * Callers run it before any read or write, so a refused call has no effect and may be retried later.
 */
export function assertWritesOpen(surface: WriteSurface): void {
  if (writesClosed(surface)) {
    throw new ConvexError({ code: MAINTENANCE_ERROR_CODE, message: MAINTENANCE_MESSAGE });
  }
}

/** HTTP methods that never write; everything else is refused while writes are closed. */
export function isSafeHttpMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
}

/** `503` with `Retry-After` and an OpenAI-style error body, as the Gateway's other errors use. */
export function maintenanceResponse(): Response {
  return Response.json(
    { error: { code: MAINTENANCE_ERROR_CODE, message: MAINTENANCE_MESSAGE } },
    { status: 503, headers: { "Retry-After": String(RETRY_AFTER_SECONDS) } },
  );
}

/**
 * Maintenance gate for one HTTP request: the refusal response for a non-safe method while writes
 * from `surface` are closed, otherwise `null`.
 */
export function maintenanceRefusal(method: string, surface: WriteSurface): Response | null {
  if (isSafeHttpMethod(method) || !writesClosed(surface)) return null;
  return maintenanceResponse();
}

/**
 * Hono middleware applying {@link maintenanceRefusal} to every request it sees. Worker token
 * exchanges (`/api/worker/`) count as Worker writes, so they stay open while the deployment drains;
 * everything else counts as a browser write. Register it after the route's CORS middleware, so
 * browsers can read the 503, and before the route handlers, since Hono runs them in order.
 */
export const maintenanceGate: MiddlewareHandler = async (c, next) => {
  const surface = c.req.path.startsWith("/api/worker/") ? "worker" : "browser";
  const refusal = maintenanceRefusal(c.req.method, surface);
  if (refusal) return refusal;
  await next();
};

const browserWrites = customCtx(() => {
  assertWritesOpen("browser");
  return {};
});

const workerWrites = customCtx(() => {
  assertWritesOpen("worker");
  return {};
});

/**
 * Public mutation builder. Use it instead of `mutation` from `_generated/server` for every
 * client-callable mutation; it refuses calls in `drain` and `on` modes before the handler runs.
 */
export const mutation = customMutation(convexMutation, browserWrites);

/** Public action builder with the same gate as {@link mutation}. */
export const action = customAction(convexAction, browserWrites);

/**
 * Base of `workerMutation` (`src/worker/machine.ts`) only: refuses calls in `on` mode and stays
 * open in `drain`, so Workers can finish claimed work. Not for browser-callable functions.
 */
export const workerWriteMutation = customMutation(convexMutation, workerWrites);
