import { v, type Infer } from "convex/values";

/** Worker file-tool request; writable requests use a snapshot/preview lifecycle. */
const workerEditRequestFields = {
  sessionId: v.string(),
  writeMode: v.optional(v.union(v.literal("edit"), v.literal("create"))),
  action: v.union(
    v.object({
      kind: v.literal("read"),
      path: v.string(),
      startLine: v.optional(v.number()),
      maxLines: v.optional(v.number()),
    }),
    v.object({ kind: v.literal("preview"), patch: v.string() }),
    v.object({ kind: v.literal("apply"), previewId: v.string() }),
    v.object({ kind: v.literal("close") }),
  ),
};

/** Optional only to retain pre-directory persisted tasks; Workers refuse to execute those tasks. */
export const workerEditRequest = v.object({
  ...workerEditRequestFields,
  directory: v.optional(v.string()),
});
/** New dispatch always carries its execution directory in the backend instructions. */
export const workerEditDispatchRequest = v.object({
  ...workerEditRequestFields,
  directory: v.string(),
});

export type WorkerEditRequest = Infer<typeof workerEditRequest>;
export const WORKER_EDIT_INPUT_BYTES = 32 * 1024;
export const WORKER_EDIT_OUTPUT_BYTES = 128 * 1024;

/** Explicit tool output, never operational logging; chat receipts may outlive the task. */
export const workerEditResult = v.union(
  v.object({ ok: v.literal(true), output: v.string() }),
  v.object({ ok: v.literal(false), code: v.string(), output: v.optional(v.string()) }),
);
export type WorkerEditResult = Infer<typeof workerEditResult>;

/** Field-order-independent dispatch deduplication. */
export function workerEditRequestKey(request: WorkerEditRequest): string {
  const action = request.action;
  return JSON.stringify([
    request.sessionId,
    request.directory ?? null,
    request.writeMode ?? null,
    action.kind,
    action.kind === "read"
      ? [action.path, action.startLine ?? 1, action.maxLines ?? null]
      : action.kind === "preview"
        ? action.patch
        : action.kind === "apply"
          ? action.previewId
          : null,
  ]);
}

export function validWorkerEditRequest(request: WorkerEditRequest): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.sessionId)) return false;
  if (new TextEncoder().encode(JSON.stringify(request)).length > WORKER_EDIT_INPUT_BYTES)
    return false;
  if (
    request.directory !== undefined &&
    (!request.directory.trim() ||
      request.directory.length > 4096 ||
      request.directory.includes("\0"))
  )
    return false;
  switch (request.action.kind) {
    case "read":
      return (
        request.action.path.length > 0 &&
        request.action.path.length <= 4096 &&
        (request.action.startLine === undefined ||
          (Number.isSafeInteger(request.action.startLine) && request.action.startLine > 0)) &&
        (request.action.maxLines === undefined ||
          (Number.isSafeInteger(request.action.maxLines) &&
            request.action.maxLines > 0 &&
            request.action.maxLines <= 5000))
      );
    case "preview":
      return request.action.patch.length > 0;
    case "apply":
      return /^[a-zA-Z0-9_-]{1,128}$/.test(request.action.previewId);
    case "close":
      return true;
  }
}
