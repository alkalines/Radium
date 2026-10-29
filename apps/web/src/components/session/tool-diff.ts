/**
 * Readers for Worker file changes: the patch a `worker_edit` call streams (hashline or
 * apply_patch grammar, `packages/worker/src/edit/service.ts`), the diff its receipt reports, and
 * the numbered content `worker_read` returns. Every reader tolerates partial text so a call can
 * render while its input still streams.
 */

/** One rendered line of a patch or diff. `line` is the file line number when the source has one. */
export type DiffLine = {
  kind: "context" | "added" | "removed" | "hunk";
  text: string;
  line?: number;
};

/** The operations a receipt reports (`EditFileOutcome.op`); patches map onto the same set. */
export type DiffFileOp = "update" | "create" | "delete";

export type DiffFile = {
  path: string;
  op: DiffFileOp;
  /** Destination of a rename, when the patch or receipt reports one. */
  moveTo?: string;
  lines: DiffLine[];
};

export function countDiffLines(lines: DiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

const hashlineHeader = /^\[(.+)#[0-9A-F]{4}\]$/;
const applyPatchHeader = /^\*\*\* (Update|Add|Delete) File: (.+)$/;
const applyPatchOps: Record<string, DiffFileOp> = {
  Update: "update",
  Add: "create",
  Delete: "delete",
};
const hashlineOp = /^(PUT|CUT|REM|MV)\b/;

/**
 * Splits an edit patch into files. Hashline `PUT`/`CUT`/`REM`/`MV` operations and apply_patch
 * `@@` anchors become hunk lines; `+` bodies are additions and apply_patch `-` lines removals.
 * Hashline patches carry no removed text: a `CUT` or `PUT` range names the replaced lines.
 */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let isApplyPatch = false;

  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;

    const applyHeader = applyPatchHeader.exec(line);
    if (applyHeader) {
      isApplyPatch = true;
      current = {
        path: applyHeader[2]?.trim() ?? "",
        op: applyPatchOps[applyHeader[1] ?? ""] ?? "update",
        lines: [],
      };
      files.push(current);
      continue;
    }

    const header = hashlineHeader.exec(line);
    if (header) {
      current = { path: header[1] ?? "", op: "update", lines: [] };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (isApplyPatch && line.startsWith("*** Move to: ")) {
      current.moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "added", text: line.slice(1) });
      continue;
    }
    if (isApplyPatch && line.startsWith("-")) {
      current.lines.push({ kind: "removed", text: line.slice(1) });
      continue;
    }
    if (isApplyPatch && line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("@@") || (!isApplyPatch && hashlineOp.test(line))) {
      current.lines.push({ kind: "hunk", text: line });
      if (!isApplyPatch && line === "REM") current.op = "delete";
    }
  }

  return files;
}

const numberedDiffLine = /^([ +-])(\d+)\|(.*)$/;
const diffSigns: Record<string, DiffLine["kind"]> = {
  "+": "added",
  "-": "removed",
  " ": "context",
};

/**
 * Lines of a receipt diff: `@@ -a,b +c,d @@` hunks, then ` N|text`, `-N|text`, and `+N|text`
 * rows. Removed and context rows carry old line numbers, added rows new ones.
 */
export function parseReceiptDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const row of diff.split("\n")) {
    if (row.startsWith("@@")) {
      lines.push({ kind: "hunk", text: row });
      continue;
    }

    const match = numberedDiffLine.exec(row);
    if (!match) {
      if (row) lines.push({ kind: "context", text: row });
      continue;
    }

    lines.push({
      kind: diffSigns[match[1] ?? " "] ?? "context",
      line: Number(match[2]),
      text: match[3] ?? "",
    });
  }
  return lines;
}

/**
 * Files a successful `worker_edit`/`worker_create` receipt changed (`{ ok: true, action: "apply",
 * result: { files: [{ path, op, diff, moveTo? }] } }`). Undefined for any other shape.
 */
export function getReceiptFiles(output: unknown): DiffFile[] | undefined {
  if (typeof output !== "object" || output === null || !("result" in output)) return undefined;

  const result = output.result;
  if (typeof result !== "object" || result === null || !("files" in result)) return undefined;
  if (!Array.isArray(result.files)) return undefined;

  const files: DiffFile[] = [];
  for (const file of result.files as unknown[]) {
    if (typeof file !== "object" || file === null) continue;

    const record = file as Record<string, unknown>;
    if (typeof record.path !== "string") continue;
    const op = record.op === "create" || record.op === "delete" ? record.op : "update";
    files.push({
      path: record.path,
      op,
      moveTo: typeof record.moveTo === "string" ? record.moveTo : undefined,
      lines: typeof record.diff === "string" ? parseReceiptDiff(record.diff) : [],
    });
  }
  return files;
}

/**
 * `worker_read` content without its `[path#TAG]` snapshot header, its `N:` line prefixes turned
 * into a start line. Lines that lack a prefix (continuations of a partial row) stay as text.
 */
export function parseNumberedRead(content: string): { startLine: number; text: string } {
  const rows = content.split("\n");
  if (rows[0] && hashlineHeader.test(rows[0])) rows.shift();
  if (rows.at(-1) === "") rows.pop();

  let startLine: number | undefined;
  const lines = rows.map((row) => {
    const match = /^(\d+):(.*)$/.exec(row);
    if (!match) return row;
    startLine ??= Number(match[1]);
    return match[2] ?? "";
  });
  return { startLine: startLine ?? 1, text: lines.join("\n") };
}
