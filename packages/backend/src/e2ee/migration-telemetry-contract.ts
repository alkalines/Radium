import { v, type Infer } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

// Pure module: the schema imports it, so it may import only `convex/values` and types. Never
// import workspaces, responses, schema or any runtime that reaches the schema.

/**
 * Who may read historical telemetry content. `custody` means no single authorized audience was
 * proven (yet); the content stays deployment-custodied and is never released to a guess.
 */
export type TelemetryAudience =
  | { kind: "owner" }
  | { kind: "chat"; chat: Id<"aisdk_chats"> }
  | { kind: "custody"; reason: "orphan" | "mixed" | "missing_chat" | "over_budget" | "too_wide" };

export const telemetryVerdictValidator = v.union(
  v.object({ kind: v.literal("owner") }),
  v.object({ kind: v.literal("chat"), chat: v.id("aisdk_chats") }),
  v.object({
    kind: v.literal("custody"),
    reason: v.union(
      v.literal("orphan"), v.literal("mixed"), v.literal("missing_chat"),
      v.literal("over_budget"), v.literal("too_wide"),
    ),
  }),
);

/**
 * Whether a finished proof still describes a row after one more referrer with audience `referrer`
 * appears. Referrers only ever add to the tally, so a verdict that already stopped being releasable
 * stays that way, and an `owner`/`chat` verdict survives only a referrer of the very same audience.
 * `orphan` and `over_budget` are not stable: more referrers can still change what they mean.
 */
export function verdictSurvivesReferrer(verdict: TelemetryAudience, referrer: TelemetryAudience): boolean {
  switch (verdict.kind) {
    case "custody":
      return verdict.reason === "mixed" || verdict.reason === "missing_chat" || verdict.reason === "too_wide";
    case "owner":
      return referrer.kind === "owner";
    case "chat":
      return referrer.kind === "chat" && referrer.chat === verdict.chat;
  }
}

/** One resumable scan step; `cursor` is Convex's opaque paginate cursor for that indexed scan. */
export const proofWorkValidator = v.object({
  kind: v.union(
    v.literal("blobNodes"), v.literal("direct"), v.literal("members"), v.literal("toolset"),
    v.literal("node"), v.literal("nodeRequests"), v.literal("children"),
  ),
  id: v.string(),
  index: v.optional(v.number()),
  cursor: v.optional(v.string()),
});
export type ProofWork = Infer<typeof proofWorkValidator>;

/**
 * Serializable state of one referrer proof. Persisting it lets a proof that does not fit one
 * transaction continue in later ones. Legacy rows cannot gain referrers once plaintext writers
 * are frozen, so a finished tally stays valid for that freeze generation.
 */
export const proofStateValidator = v.object({
  /** At least one referencing request is owner-visible. */
  owner: v.boolean(),
  /** Distinct hidden chats seen; two or more already decide `mixed`, so the list stays tiny. */
  hidden: v.array(v.id("aisdk_chats")),
  missingChat: v.boolean(),
  seen: v.number(),
  work: v.array(proofWorkValidator),
  /** Set when the scan frontier outgrew its bound; the proof can then never complete. */
  tooWide: v.boolean(),
});
export type ProofState = Infer<typeof proofStateValidator>;

export const proofTableValidator = v.union(v.literal("telemetry_blobs"), v.literal("telemetry_nodes"));
export type ProofTable = Infer<typeof proofTableValidator>;

/** Current value of `proofFormat`: the revision counter lives in `e2ee_telemetry_revisions`. */
export const PROOF_FORMAT = 2;

/** Table fields for `e2ee_telemetry_proofs` (index `by_table_and_record` [table, record]). */
export const telemetryProofFields = {
  table: proofTableValidator,
  record: v.string(),
  workspace: v.id("workspaces"),
  generation: v.number(),
  /** Workspace graph revision (`e2ee_telemetry_revisions`); native referrers may still change after cutover. */
  graphRevision: v.optional(v.number()),
  /**
   * Revision source the proof was taken under (`PROOF_FORMAT`). Proofs without it were taken when the
   * revision counter lived on the workspace document (`workspaces.telemetryProofRevision`); their
   * `graphRevision` is not comparable with the dedicated counter, so they are never trusted and
   * every pass restarts them, even when the numbers happen to match.
   */
  proofFormat: v.optional(v.number()),
  /**
   * `failed`: a step threw (`failure` holds the bounded reason). The row keeps no verdict, so its
   * custody row stays custodial; the next refresh pass or `advanceProofs` restarts it.
   */
  status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
  failure: v.optional(v.string()),
  state: proofStateValidator,
  verdict: v.optional(telemetryVerdictValidator),
  updatedAt: v.number(),
};

/**
 * Per-workspace proof graph revision, bumped whenever a referrer or audience change could alter a
 * finished proof. A dedicated document keeps the hot workspace document (read by every workspace
 * mutation) out of write conflicts. Index `by_workspace` [workspace]; absent means revision 0.
 */
export const telemetryRevisionFields = {
  workspace: v.id("workspaces"),
  revision: v.number(),
};
