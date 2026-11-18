import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import { authorizeChatRecord } from "../../convex/workspaces";
import type { ProofState, ProofWork, TelemetryAudience } from "./migration-telemetry-contract";

type Ctx = QueryCtx | MutationCtx;
type Workspace = Doc<"workspaces">;

/** Reads one in-transaction proof may spend; below Convex's per-function limits. */
const TRANSACTION_READ_BUDGET = 900;
/** Largest referrer list one equality scan may return inside a transaction; more is `over_budget`. */
const SCAN_LIMIT = 100;
/** Documents per paginated step of the persisted proof. */
const STEP_PAGE = 50;
/** Frontier bound; a wider subtree is declared unprovable instead of growing the document. */
const MAX_WORK = 3000;

type ChatVisibility = "owner" | "hidden" | "missing";

/**
 * Whether the workspace owner may see a chat's telemetry. Mirrors `visibleWorkspaceChat`
 * (`convex/chatroom.ts`) for a server-derived owner ID: owning the workspace alone never exposes
 * another user's personal or unlisted shared chat.
 */
async function ownerChatVisibility(ctx: Ctx, workspace: Workspace, chatId: Id<"aisdk_chats">): Promise<ChatVisibility> {
  const chat = await ctx.db.get("aisdk_chats", chatId);
  if (!chat) return "missing";
  const authorized = await authorizeChatRecord(ctx, chatId, workspace.ownerId);
  if (!authorized || authorized.workspace._id !== workspace._id) return "hidden";
  const belongs = chat.workspace
    ? chat.workspace === workspace._id && (chat.balance === undefined || chat.balance === workspace.legacyBalance)
    : chat.balance !== undefined && chat.balance === workspace.legacyBalance;
  return belongs ? "owner" : "hidden";
}

/** Audience of a row that carries its own attribution (request, legacy trace). No chat means Gateway. */
export async function directAudience(
  ctx: Ctx,
  workspace: Workspace,
  chatId: Id<"aisdk_chats"> | undefined,
): Promise<TelemetryAudience> {
  if (!chatId) return { kind: "owner" };
  const visibility = await ownerChatVisibility(ctx, workspace, chatId);
  if (visibility === "owner") return { kind: "owner" };
  if (visibility === "missing") return { kind: "custody", reason: "missing_chat" };
  return { kind: "chat", chat: chatId };
}

/** Number of request indexes that point straight at a blob (see `scan`). */
const DIRECT_INDEXES = 7;

/** Initial frontier: every way a request can reach this blob or conversation node. */
export function startProof(row: { table: "telemetry_blobs" | "telemetry_nodes"; id: string }): ProofState {
  const work: ProofWork[] = row.table === "telemetry_nodes"
    ? [{ kind: "node", id: row.id }]
    : [
        { kind: "members", id: row.id },
        ...Array.from({ length: DIRECT_INDEXES }, (_, index) => ({ kind: "direct" as const, id: row.id, index })),
        { kind: "blobNodes", id: row.id },
      ];
  return { owner: false, hidden: [], missingChat: false, seen: 0, work, tooWide: false };
}

/** The verdict reached so far, or `undefined` while more referrers could still change it. */
export function proofVerdict(state: ProofState): TelemetryAudience | undefined {
  if (state.tooWide) return { kind: "custody", reason: "too_wide" };
  if (state.missingChat) return { kind: "custody", reason: "missing_chat" };
  // One hidden audience beside any other audience can never be released to a single recipient.
  if (state.hidden.length > 1 || (state.owner && state.hidden.length > 0)) return { kind: "custody", reason: "mixed" };
  if (state.work.length > 0) return undefined;
  if (state.seen === 0) return { kind: "custody", reason: "orphan" };
  if (state.hidden.length === 0) return { kind: "owner" };
  return { kind: "chat", chat: state.hidden[0]! };
}

class OverBudget extends Error {}

/** The indexed equality scan a work item stands for. It is unbounded; callers bound it themselves. */
function scan(ctx: Ctx, item: ProofWork) {
  const id = item.id;
  const requests = ctx.db.query("telemetry_requests");
  switch (item.kind) {
    case "nodeRequests":
      return item.index === 0
        ? requests.withIndex("by_input", (q) => q.eq("input", id as Id<"telemetry_nodes">))
        : requests.withIndex("by_output", (q) => q.eq("output", id as Id<"telemetry_nodes">));
    case "children":
      return ctx.db.query("telemetry_nodes").withIndex("by_parent", (q) => q.eq("parent", id as Id<"telemetry_nodes">));
    case "blobNodes":
      return ctx.db.query("telemetry_nodes").withIndex("by_blob", (q) => q.eq("blob", id as Id<"telemetry_blobs">));
    case "members":
      return ctx.db.query("telemetry_toolset_tools").withIndex("by_tool", (q) => q.eq("tool", id as Id<"telemetry_blobs">));
    case "toolset":
      return requests.withIndex("by_toolset", (q) => q.eq("toolset", id as Id<"telemetry_blobs">));
    case "direct": {
      const blob = id as Id<"telemetry_blobs">;
      switch (item.index) {
        case 0: return requests.withIndex("by_system", (q) => q.eq("system", blob));
        case 1: return requests.withIndex("by_toolset", (q) => q.eq("toolset", blob));
        case 2: return requests.withIndex("by_params", (q) => q.eq("params", blob));
        case 3: return requests.withIndex("by_headers", (q) => q.eq("headers", blob));
        case 4: return requests.withIndex("by_legacy_input", (q) => q.eq("legacy.input", blob));
        case 5: return requests.withIndex("by_legacy_output", (q) => q.eq("legacy.output", blob));
        default: return requests.withIndex("by_legacy_spans", (q) => q.eq("legacy.spans", blob));
      }
    }
    default:
      throw new Error("Telemetry proof item is not a scan");
  }
}

/**
 * Tally of one referrer proof. Content-addressed rows are shared across requests, so one hidden
 * referrer is enough to keep a row out of the owner's reach, and `owner` needs a complete
 * enumeration. Every scan is read in full (inside a transaction) or by opaque paginate cursor
 * (persisted proof); there is no time-based seek, so rows sharing a creation time are never skipped.
 */
class ProofRun {
  private reads = 0;
  private readonly chats = new Map<string, ChatVisibility>();

  constructor(
    private readonly ctx: Ctx,
    private readonly workspace: Workspace,
    readonly state: ProofState,
    private readonly budget: number,
  ) {}

  spend(count = 1) {
    this.reads += count;
    if (this.reads > this.budget) throw new OverBudget();
  }

  private push(...items: ProofWork[]) {
    if (this.state.work.length + items.length > MAX_WORK) this.state.tooWide = true;
    else this.state.work.push(...items);
  }

  private async audit(request: Doc<"telemetry_requests">) {
    const { state } = this;
    if (request.workspace !== this.workspace._id) throw new Error("Telemetry reference crosses workspaces");
    state.seen++;
    if (!request.chatId) {
      state.owner = true;
      return;
    }
    let visibility = this.chats.get(request.chatId);
    if (!visibility) {
      this.spend(2);
      visibility = await ownerChatVisibility(this.ctx, this.workspace, request.chatId);
      this.chats.set(request.chatId, visibility);
    }
    if (visibility === "owner") state.owner = true;
    else if (visibility === "missing") state.missingChat = true;
    else if (!state.hidden.includes(request.chatId)) state.hidden.push(request.chatId);
  }

  /** Expand a node into the scans that reach every request seeing it (itself and descendants). */
  async visitNode(item: ProofWork) {
    this.spend();
    const node = await this.ctx.db.get("telemetry_nodes", item.id as Id<"telemetry_nodes">);
    if (!node) return;
    if (node.workspace !== this.workspace._id) throw new Error("Telemetry reference crosses workspaces");
    this.push(
      { kind: "children", id: node._id },
      { kind: "nodeRequests", id: node._id, index: 1 },
      { kind: "nodeRequests", id: node._id, index: 0 },
    );
  }

  /** Apply one scan result (a complete list or one page) to the tally and the frontier. */
  async consume(item: ProofWork, docs: Array<Doc<"telemetry_requests"> | Doc<"telemetry_nodes"> | Doc<"telemetry_toolset_tools">>) {
    this.spend(docs.length);
    for (const doc of docs) {
      switch (item.kind) {
        case "nodeRequests":
        case "direct":
        case "toolset":
          await this.audit(doc as Doc<"telemetry_requests">);
          break;
        case "children":
        case "blobNodes":
          this.push({ kind: "node", id: doc._id });
          break;
        case "members":
          this.push({ kind: "toolset", id: (doc as Doc<"telemetry_toolset_tools">).toolset });
          break;
      }
    }
  }
}

/**
 * Single-transaction proof for seal-time decisions and release fallbacks. Every equality scan is
 * read with `take(SCAN_LIMIT + 1)`; a scan or read budget that overflows is `over_budget`
 * (custody), never a partial tally. Rows that need more are finished by the persisted proof.
 */
export async function referrerAudience(
  ctx: Ctx,
  workspace: Workspace,
  row: { table: "telemetry_blobs" | "telemetry_nodes"; id: string },
): Promise<TelemetryAudience> {
  const run = new ProofRun(ctx, workspace, startProof(row), TRANSACTION_READ_BUDGET);
  try {
    for (let verdict = proofVerdict(run.state); verdict === undefined; verdict = proofVerdict(run.state)) {
      const item = run.state.work.pop()!;
      if (item.kind === "node") {
        await run.visitNode(item);
        continue;
      }
      const docs = await scan(ctx, item).take(SCAN_LIMIT + 1);
      if (docs.length > SCAN_LIMIT) return { kind: "custody", reason: "over_budget" };
      await run.consume(item, docs);
    }
  } catch (error) {
    if (error instanceof OverBudget) return { kind: "custody", reason: "over_budget" };
    throw error;
  }
  return proofVerdict(run.state)!;
}

/**
 * One persisted-proof step: reads at most ONE paginated scan page (Convex allows one paginated
 * query per function), so the caller persists `state` and runs the next step in a new mutation.
 * Returns the verdict once decided. The scan's opaque cursor is stored in the frontier item.
 */
export async function advanceProofStep(
  ctx: MutationCtx,
  workspace: Workspace,
  state: ProofState,
): Promise<TelemetryAudience | undefined> {
  const run = new ProofRun(ctx, workspace, state, TRANSACTION_READ_BUDGET);
  let current: ProofWork | undefined;
  try {
    for (let verdict = proofVerdict(state); verdict === undefined; verdict = proofVerdict(state)) {
      current = state.work.pop()!;
      if (current.kind === "node") {
        await run.visitNode(current);
        continue;
      }
      const page = await scan(ctx, current).paginate({ numItems: STEP_PAGE, cursor: current.cursor ?? null });
      await run.consume(current, page.page);
      if (!page.isDone) state.work.push({ ...current, cursor: page.continueCursor });
      current = undefined;
      break;
    }
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    // Node visits are idempotent; the item restarts in the next mutation.
    if (current) state.work.push(current);
  }
  return proofVerdict(state);
}
