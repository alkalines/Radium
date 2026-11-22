import { z } from "zod";
import type { CodeModeInteractions } from "../chatroom/code-mode-runtime";

/**
 * A user's approval of one call: Ed25519 `signature` (base64url) by identity key `signerKeyId` over
 * `toolApprovalStatement`, with `input`, the exact JSON text that was signed (`JSON.stringify` of the
 * tool part input the user saw), and `approvedAt`, the signing client's clock in milliseconds.
 */
export type WorkerApprovalSignature = {
  signature: string;
  signerKeyId: string;
  input: string;
  approvedAt: number;
};

/** Wire bounds of an approval signature; inputs are bounded again by the tool schemas. */
export const workerApprovalSignatureSchema = z.object({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  signerKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  input: z.string().max(64 * 1024),
  approvedAt: z.number().int().positive(),
});

/** At most this many approvals travel with one chat request (one assistant step's calls). */
const MAX_REQUEST_APPROVALS = 32;

/**
 * Parse the chat request body's `approvals` (`{ [toolCallId]: WorkerApprovalSignature }`, at most
 * {@link MAX_REQUEST_APPROVALS} entries). Malformed input yields `null`; absent input yields an
 * empty map. Signatures are verified by the Worker, never here.
 */
export function parseWorkerApprovals(value: unknown): Map<string, WorkerApprovalSignature> | null {
  if (value === undefined) return new Map();
  const parsed = z
    .record(z.string().min(1).max(128), workerApprovalSignatureSchema)
    .refine((entries) => Object.keys(entries).length <= MAX_REQUEST_APPROVALS)
    .safeParse(value);
  return parsed.success ? new Map(Object.entries(parsed.data)) : null;
}

/**
 * Code Mode prompt persistence that turns signed approvals into {@link WorkerApprovalSignature}s
 * for the Worker tools. The browser signs `JSON.stringify` of the call input the prompt shows
 * (`CodeModeCall.input`, which reaches it as JSON); this records that same text when the prompt
 * opens, so the signed input never round-trips through `codemode_interactions`. Should the two
 * texts ever differ, the Worker's signature check refuses the call.
 */
export function workerCodeModeInteractions(
  base: CodeModeInteractions,
  approvals: Map<string, WorkerApprovalSignature>,
): CodeModeInteractions {
  const presented = new Map<string, { callId: string; input: string | undefined }>();
  return {
    open: async (kind, callId, input) => {
      const id = await base.open(kind, callId, input);
      presented.set(id, { callId, input: JSON.stringify(input) });
      return id;
    },
    response: async (id) => {
      const response = await base.response(id);
      const call = presented.get(id);
      if (
        response?.kind === "approval" &&
        response.approved &&
        response.signature &&
        call?.input !== undefined
      ) {
        approvals.set(call.callId, { ...response.signature, input: call.input });
      }
      return response;
    },
    close: async (id) => {
      presented.delete(id);
      await base.close(id);
    },
  };
}
