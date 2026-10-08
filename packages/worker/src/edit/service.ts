import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  EditSession,
  EditStore,
  editDescription,
  editGrammar,
  editInspect,
  hashlineFormatHeader,
  hashlineFormatNumberedLines,
  type EditApplyOutcome,
  type EditFileOutcome,
  type EditPolicy,
  type EditWriteRequest,
} from "@oh-my-pi/pi-natives";
import {
  WORKER_EDIT_INPUT_BYTES,
  WORKER_EDIT_OUTPUT_BYTES,
  type WorkerEditRequest,
  validWorkerEditRequest,
} from "backend/src/worker/edit-contract";
import { resolveWorkerEditPath, WorkerEditPathError } from "./path-policy.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const READ_CONTENT_BYTES = 48 * 1024;
const MAX_SESSIONS = 64;
// Native staging mutates registers and exposes no clone/rollback API. Fence that
// scratch state until the pending preview is applied or the session is reset.
const MAX_PREVIEWS_PER_SESSION = 1;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const OUTPUT_TOO_LARGE = JSON.stringify({ ok: false, code: "OUTPUT_TOO_LARGE" });
const WORKER_WORKFLOW =
  "Worker edit lifecycle: read, preview, then apply using previewId. Keep one pending preview per session; close the session to discard it. Failed or expired staging resets native scratch state: read again. Create files by previewing apply_patch envelopes with *** Add File headers.\n\n";
const EDIT_INSTRUCTIONS = WORKER_WORKFLOW + editDescription("hashline");
const EDIT_GRAMMAR = editGrammar("hashline") ?? "";
const APPLY_PATCH_INSTRUCTIONS = WORKER_WORKFLOW + editDescription("apply_patch");
const APPLY_PATCH_GRAMMAR = editGrammar("apply_patch") ?? "";
type EditMode = "hashline" | "apply_patch";
type WorkerWriteMode = "edit" | "create";

interface SnapshotSeed {
  text: string;
  seenLines: number[];
}

interface ExpectedPath {
  path: string;
  /** null means the path must still be absent. */
  text: string | null;
}

interface StagedPreview {
  id: string;
  createdAt: number;
  bytes: number;
  writeMode?: WorkerWriteMode;
  writes: EditWriteRequest[];
  expectations: ExpectedPath[];
  outcome: EditApplyOutcome;
}

interface EditContext {
  store: EditStore;
  previews: Map<string, StagedPreview>;
  closed: boolean;
}

interface SerializedResult {
  json: string;
  oversized: boolean;
}

/** Worker-local native edit adapter for one authorized execution root. */
export class WorkerEditService {
  private readonly sessions = new Map<string, EditContext>();
  private pendingBytes = 0;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly root: string) {}

  /** Retained preview memory and the shared budget used across backend-selected directories. */
  get stagingUsage(): { bytes: number; limit: number } {
    return { bytes: this.pendingBytes, limit: MAX_STAGED_BYTES };
  }

  /** Create a service bound to an existing, canonical execution directory. */
  static async create(root: string): Promise<WorkerEditService> {
    const canonicalRoot = await realpath(root);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("Worker edit root must be a directory.");
    }
    return new WorkerEditService(canonicalRoot);
  }

  /** Execute one read, preview, apply, or session-close request and return bounded JSON. */
  async execute(request: WorkerEditRequest): Promise<string> {
    const result = this.queue.then(async () => {
      const existed = this.sessions.has(request.sessionId);
      let output: string | undefined;
      try {
        output = await this.executeSerial(request);
        return output;
      } finally {
        // A failed first read/preview must not consume one of the bounded session slots.
        if (!existed && (!output || JSON.parse(output).ok !== true)) {
          const context = this.sessions.get(request.sessionId);
          if (context) this.disposeContext(context);
          this.sessions.delete(request.sessionId);
        }
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeSerial(request: WorkerEditRequest): Promise<string> {
    if (this.closed) return encode({ ok: false, code: "SERVICE_CLOSED" }).json;
    if (!validWorkerEditRequest(request)) {
      return encode({ ok: false, code: "INVALID_REQUEST" }).json;
    }
    for (const context of this.sessions.values()) this.expirePreviews(context);

    if (request.action.kind === "close") {
      const context = this.sessions.get(request.sessionId);
      if (!context) return encode({ ok: true, action: "close", closed: false }).json;
      this.disposeContext(context);
      this.sessions.delete(request.sessionId);
      return encode({ ok: true, action: "close", closed: true }).json;
    }

    let context = this.sessions.get(request.sessionId);
    if (!context && request.action.kind !== "apply") {
      if (this.sessions.size >= MAX_SESSIONS) {
        return encode({ ok: false, code: "SESSION_LIMIT" }).json;
      }
      context = {
        store: new EditStore(),
        previews: new Map(),
        closed: false,
      };
      this.sessions.set(request.sessionId, context);
    }
    if (!context) return encode({ ok: false, code: "UNKNOWN_SESSION" }).json;
    const activeContext = context;

    if (activeContext.closed || this.closed)
      return encode({ ok: false, code: "SESSION_CLOSED" }).json;
    this.expirePreviews(activeContext);
    const writeMode = request.writeMode;
    try {
      switch (request.action.kind) {
        case "read":
          return await this.read(
            activeContext,
            request.action.path,
            request.action.startLine,
            request.action.maxLines,
          );
        case "preview":
          return await this.preview(activeContext, request.action.patch, writeMode);
        case "apply":
          return await this.apply(activeContext, request.action.previewId, writeMode);
        default:
          return encode({ ok: false, code: "INVALID_ACTION" }).json;
      }
    } catch (error) {
      if (request.action.kind === "preview") activeContext.store.clear();
      if (error instanceof WorkerEditPathError) {
        return encode({ ok: false, code: error.code }).json;
      }
      if (error instanceof EditServiceError) {
        return encode({
          ok: false,
          code: error.code,
          message: applyErrorMessage(error),
        }).json;
      }
      return encode({ ok: false, code: "EDIT_IO_ERROR" }).json;
    }
  }

  /** Dispose all session snapshots and pending previews. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    for (const context of this.sessions.values()) this.disposeContext(context);
    this.sessions.clear();
  }

  private async read(
    context: EditContext,
    authoredPath: string,
    startLine = 1,
    maxLines?: number,
  ): Promise<string> {
    const resolved = await resolveWorkerEditPath(this.root, authoredPath);
    if (!resolved.exists) return encode({ ok: false, code: "FILE_NOT_FOUND" }).json;
    const text = await readTextFile(resolved.absolutePath);
    const formatted = formatRead(text, startLine, maxLines);
    if (formatted.truncated && formatted.visibleLines.length === 0) {
      return encode({ ok: false, code: "READ_LINE_TOO_LARGE" }).json;
    }
    const tag = context.store.recordSnapshot(resolved.absolutePath, text, []);
    const content = `${hashlineFormatHeader(resolved.displayPath, tag)}\n${formatted.content}`;

    const response = {
      ok: true,
      action: "read",
      mode: "hashline",
      content,
      truncated: formatted.truncated,
      ...(formatted.truncated ? { nextLine: formatted.nextLine } : {}),
      instructions: EDIT_INSTRUCTIONS,
      grammar: EDIT_GRAMMAR,
      availableFormats: [
        { mode: "hashline", instructions: EDIT_INSTRUCTIONS, grammar: EDIT_GRAMMAR },
        {
          mode: "apply_patch",
          instructions: APPLY_PATCH_INSTRUCTIONS,
          grammar: APPLY_PATCH_GRAMMAR,
        },
      ],
    };
    const serialized = encode(response);
    if (serialized.oversized) return OUTPUT_TOO_LARGE;
    context.store.recordSeenLinesFromBody(resolved.absolutePath, tag, formatted.content);
    return serialized.json;
  }

  private async preview(
    context: EditContext,
    patch: string,
    writeMode?: WorkerWriteMode,
  ): Promise<string> {
    if (new TextEncoder().encode(patch).byteLength > WORKER_EDIT_INPUT_BYTES) {
      return encode({ ok: false, code: "INPUT_TOO_LARGE" }).json;
    }
    if (context.previews.size >= MAX_PREVIEWS_PER_SESSION) {
      return encode({
        ok: false,
        code: "PENDING_PREVIEW",
        message: "Apply the pending preview or close this session before staging another edit.",
      }).json;
    }

    const mode = editModeFor(patch);
    const inspection = editInspect(mode, JSON.stringify({ input: patch }));
    const authoredPaths = new Set<string>(inspection.paths);
    for (const operation of inspection.fileOps) {
      assertWriteModeAllows(writeMode, operation.kind);
      authoredPaths.add(operation.path);
      if (operation.to) authoredPaths.add(operation.to);
    }
    if (authoredPaths.size === 0) {
      return encode({ ok: false, code: "NO_EDIT_PATHS" }).json;
    }

    const seeds = new Map<string, SnapshotSeed | null>();
    const baselines = new Map<string, string | null>();
    for (const authoredPath of authoredPaths) {
      const resolved = await resolveWorkerEditPath(this.root, authoredPath);
      const oldHash = context.store.headHash(resolved.absolutePath);
      const oldText = oldHash ? context.store.byHashText(resolved.absolutePath, oldHash) : null;
      baselines.set(
        resolved.absolutePath,
        resolved.exists ? await readTextFile(resolved.absolutePath) : null,
      );
      seeds.set(
        resolved.absolutePath,
        oldText === null
          ? null
          : {
              text: oldText,
              seenLines: context.store.seenLines(resolved.absolutePath, oldHash!) ?? [],
            },
      );
    }

    const writes: EditWriteRequest[] = [];
    let writerValidationError: unknown;
    const nativeSession = new EditSession(context.store, this.policy(mode), null);
    let outcome: EditApplyOutcome;
    try {
      nativeSession.setArgsJson(patch);
      nativeSession.finish();
      outcome = await nativeSession.apply({ lspFlush: false }, async (error, request) => {
        if (error) throw error;
        try {
          await this.validateStagedWrite(request, writeMode);
          await this.captureBaseline(request.path, baselines);
          if (request.moveTo) await this.captureBaseline(request.moveTo, baselines);
        } catch (validationError) {
          writerValidationError = validationError;
          throw validationError;
        }
        writes.push({ ...request });
        // The native engine only updates its session store through this host writer.
        // A preview acknowledges into memory; disk writes happen in apply().
        return { written: request.content ?? "" };
      });
    } catch (error) {
      context.store.clear();
      throw error;
    } finally {
      nativeSession.close();
      await this.refreshSnapshots(context, seeds);
    }

    if (writerValidationError !== undefined) {
      context.store.clear();
      return encode({ ok: false, code: errorCode(writerValidationError) }).json;
    }
    if (outcome.isError) {
      context.store.clear();
      return this.encodeWithInstructions(
        {
          ok: false,
          action: "preview",
          code: "EDIT_REJECTED",
          message: outcome.text,
        },
        mode,
      );
    }
    if (writes.length === 0 || outcome.files.length === 0) {
      context.store.clear();
      return this.encodeWithInstructions(
        {
          ok: false,
          action: "preview",
          code: "NO_CHANGES",
          message: outcome.text,
        },
        mode,
      );
    }

    const expectations = this.makeExpectations(writes, outcome, baselines);
    const bytes = stagedByteSize(writes, expectations);
    if (bytes > 8 * 1024 * 1024 || this.pendingBytes + bytes > MAX_STAGED_BYTES) {
      context.store.clear();
      return encode({ ok: false, code: "STAGED_PREVIEW_TOO_LARGE" }).json;
    }

    const preview: StagedPreview = {
      id: randomUUID().replaceAll("-", ""),
      createdAt: Date.now(),
      bytes,
      writeMode,
      writes,
      expectations,
      outcome,
    };
    const response = {
      ok: true,
      action: "preview",
      mode,
      previewId: preview.id,
      expiresInMs: PREVIEW_TTL_MS,
      instructions: instructionsFor(mode),
      grammar: grammarFor(mode),
      result: publicOutcome(outcome, this.root),
    };
    const serialized = encode(response);
    const applyResponse = encode({
      ok: true,
      action: "apply",
      result: publicOutcome(outcome, this.root),
      applied: appliedLabels(writes, this.root),
    });
    if (serialized.oversized || applyResponse.oversized) {
      context.store.clear();
      return OUTPUT_TOO_LARGE;
    }

    context.previews.set(preview.id, preview);
    this.pendingBytes += bytes;
    return serialized.json;
  }

  private async apply(
    context: EditContext,
    previewId: string,
    writeMode?: WorkerWriteMode,
  ): Promise<string> {
    const preview = context.previews.get(previewId);
    if (!preview) return encode({ ok: false, code: "UNKNOWN_PREVIEW" }).json;
    if (preview.writeMode !== undefined && preview.writeMode !== writeMode) {
      return encode({
        ok: false,
        action: "apply",
        code: "WRITE_MODE_DENIED",
        message: "Apply must use the write mode that was approved for this preview.",
      }).json;
    }
    try {
      // Validate the complete staged batch before the first filesystem write. This
      // prevents a later incompatible operation from leaving an earlier write applied.
      for (const request of preview.writes) {
        assertWriteModeAllows(writeMode ?? preview.writeMode, request.op);
      }
    } catch (error) {
      return encode({
        ok: false,
        action: "apply",
        code: errorCode(error),
        message: applyErrorMessage(error),
      }).json;
    }
    this.dropPreview(context, previewId);

    const applied: string[] = [];
    const attempted: string[] = [];
    try {
      for (const expected of preview.expectations) {
        await this.assertExpected(expected);
      }

      for (const request of preview.writes) {
        attempted.push(displayPath(this.root, request.path));
        await this.applyWrite(request, preview.expectations);
        applied.push(
          request.moveTo
            ? `${displayPath(this.root, request.path)} -> ${displayPath(this.root, request.moveTo)}`
            : displayPath(this.root, request.path),
        );
      }

      for (const request of preview.writes) {
        if (request.op === "delete") {
          context.store.invalidate(request.path);
        } else if (request.op === "move") {
          context.store.invalidate(request.path);
          if (request.moveTo && request.content !== undefined) {
            const tag = context.store.recordSnapshot(request.moveTo, request.content, []);
            const file = preview.outcome.files.find((candidate) => candidate.path === request.path);
            if (file?.text) context.store.recordSeenLinesFromBody(request.moveTo, tag, file.text);
          }
        } else if (request.content !== undefined) {
          const tag = context.store.recordSnapshot(request.path, request.content, []);
          const file = preview.outcome.files.find((candidate) => candidate.path === request.path);
          if (file?.text) context.store.recordSeenLinesFromBody(request.path, tag, file.text);
        }
      }

      const serialized = encode({
        ok: true,
        action: "apply",
        result: publicOutcome(preview.outcome, this.root),
        applied,
      });
      return serialized.oversized ? OUTPUT_TOO_LARGE : serialized.json;
    } catch (error) {
      // Discard uncommitted clipboard/no-op state as well as snapshots after a failed apply.
      context.store.clear();
      return encode({
        ok: false,
        action: "apply",
        code: attempted.length ? "APPLY_PARTIAL" : errorCode(error),
        message: applyErrorMessage(error),
        applied,
      }).json;
    }
  }

  private async validateStagedWrite(
    request: EditWriteRequest,
    writeMode?: WorkerWriteMode,
  ): Promise<void> {
    if (!["create", "update", "delete", "move"].includes(request.op)) {
      throw new WorkerEditPathError("UNSAFE_PATH");
    }
    assertWriteModeAllows(writeMode, request.op);
    if (request.op !== "delete" && typeof request.content !== "string") {
      throw new EditServiceError("MISSING_EDIT_CONTENT");
    }
    if (
      request.content !== undefined &&
      (request.content.includes("\0") ||
        new TextEncoder().encode(request.content).byteLength > MAX_FILE_BYTES)
    ) {
      throw new EditServiceError("FILE_TOO_LARGE");
    }
    const source = await resolveWorkerEditPath(this.root, request.path);
    if (request.op === "create") {
      if (source.exists) throw new WorkerEditPathError("UNSAFE_PATH");
    } else if (!source.exists) {
      throw new WorkerEditPathError("UNSAFE_PATH");
    }

    if (request.op === "move") {
      if (!request.moveTo) throw new WorkerEditPathError("UNSAFE_PATH");
      const destination = await resolveWorkerEditPath(this.root, request.moveTo);
      if (destination.exists) throw new WorkerEditPathError("UNSAFE_PATH");
    }
  }

  private makeExpectations(
    writes: EditWriteRequest[],
    outcome: EditApplyOutcome,
    baselines: Map<string, string | null>,
  ): ExpectedPath[] {
    const expectations = new Map<string, string | null>();
    for (const write of writes) {
      const file = outcome.files.find((candidate) => candidate.path === write.path);
      const baseline = baselines.get(write.path);
      if (baseline === undefined) throw new WorkerEditPathError("UNSAFE_PATH");
      if (write.op === "create") {
        if (baseline !== null) throw new EditServiceError("STALE_PREVIEW");
        expectations.set(write.path, null);
      } else {
        if (baseline === null) {
          throw new WorkerEditPathError("UNSAFE_PATH");
        }
        if (typeof file?.oldText === "string" && file.oldText !== baseline) {
          throw new EditServiceError("STALE_PREVIEW");
        }
        expectations.set(write.path, baseline);
      }
      if (write.op === "move" && write.moveTo) {
        if (baselines.get(write.moveTo) !== null) throw new EditServiceError("STALE_PREVIEW");
        expectations.set(write.moveTo, null);
      }
    }
    return [...expectations].map(([path, text]) => ({ path, text }));
  }

  private async assertExpected(expected: ExpectedPath): Promise<void> {
    const resolved = await resolveWorkerEditPath(this.root, expected.path);
    if (expected.text === null) {
      if (resolved.exists) throw new EditServiceError("STALE_PREVIEW");
      return;
    }
    if (!resolved.exists || (await readTextFile(resolved.absolutePath)) !== expected.text) {
      throw new EditServiceError("STALE_PREVIEW");
    }
  }

  private async captureBaseline(
    authoredPath: string,
    baselines: Map<string, string | null>,
  ): Promise<void> {
    const resolved = await resolveWorkerEditPath(this.root, authoredPath);
    const current = resolved.exists ? await readTextFile(resolved.absolutePath) : null;
    const inspected = baselines.get(resolved.absolutePath);
    if (inspected !== undefined && inspected !== current) {
      throw new EditServiceError("STALE_PREVIEW");
    }
    baselines.set(resolved.absolutePath, current);
  }

  private async applyWrite(request: EditWriteRequest, expectations: ExpectedPath[]): Promise<void> {
    const sourceExpected = expectations.find((entry) => entry.path === request.path);
    if (!sourceExpected) throw new WorkerEditPathError("UNSAFE_PATH");
    await this.assertExpected(sourceExpected);

    if (request.op === "delete") {
      await unlink(request.path);
      return;
    }

    if (request.op === "create") {
      await ensureParentDirectories(this.root, request.path);
      await resolveWorkerEditPath(this.root, request.path);
      await writeFile(request.path, request.content ?? "", { flag: "wx" });
      if ((await readTextFile(request.path)) !== request.content) {
        throw new EditServiceError("WRITE_VERIFICATION_FAILED");
      }
      return;
    }

    if (request.op === "move") {
      if (!request.moveTo) throw new WorkerEditPathError("UNSAFE_PATH");
      const destinationExpected = expectations.find((entry) => entry.path === request.moveTo);
      if (!destinationExpected) throw new WorkerEditPathError("UNSAFE_PATH");
      await this.assertExpected(destinationExpected);
      await ensureParentDirectories(this.root, request.moveTo);
      await resolveWorkerEditPath(this.root, request.moveTo);
      const mode = (await stat(request.path)).mode & 0o777;
      await writeFile(request.moveTo, request.content ?? "", { flag: "wx", mode });
      try {
        if ((await readTextFile(request.moveTo)) !== request.content) {
          throw new EditServiceError("WRITE_VERIFICATION_FAILED");
        }
        await this.assertExpected(sourceExpected);
        await unlink(request.path);
      } catch (error) {
        await unlink(request.moveTo).catch(() => undefined);
        throw error;
      }
      return;
    }

    await resolveWorkerEditPath(this.root, request.path);
    await writeFile(request.path, request.content ?? "");
    if ((await readTextFile(request.path)) !== (request.content ?? "")) {
      throw new EditServiceError("WRITE_VERIFICATION_FAILED");
    }
  }

  private async refreshSnapshots(
    context: EditContext,
    seeds: Map<string, SnapshotSeed | null>,
  ): Promise<void> {
    for (const [absolutePath, seed] of seeds) {
      try {
        const resolved = await resolveWorkerEditPath(this.root, absolutePath);
        if (!resolved.exists) {
          context.store.invalidate(absolutePath);
          continue;
        }
        const text = await readTextFile(absolutePath);
        context.store.recordSnapshot(absolutePath, text, seed?.text === text ? seed.seenLines : []);
      } catch {
        context.store.invalidate(absolutePath);
      }
    }
  }

  private policy(mode: EditMode): EditPolicy {
    return {
      cwd: this.root,
      mode,
      allowFuzzy: false,
      fuzzyThreshold: 0.8,
      enforceSeenLines: true,
      blockAutoGenerated: false,
      planActive: false,
      urlSchemes: [],
      urlAliasSchemes: [],
      planWritableRoots: [],
      homeDir: this.root,
      rawInput: true,
    };
  }

  private encodeWithInstructions(value: Record<string, unknown>, mode: EditMode): string {
    const result = encode({
      ...value,
      mode,
      instructions: instructionsFor(mode),
      grammar: grammarFor(mode),
    });
    return result.oversized ? OUTPUT_TOO_LARGE : result.json;
  }

  private expirePreviews(context: EditContext): void {
    const now = Date.now();
    for (const preview of context.previews.values()) {
      if (now - preview.createdAt > PREVIEW_TTL_MS) {
        this.dropPreview(context, preview.id);
        context.store.clear();
      }
    }
  }

  private dropPreview(context: EditContext, previewId: string): void {
    const preview = context.previews.get(previewId);
    if (!preview) return;
    context.previews.delete(previewId);
    this.pendingBytes = Math.max(0, this.pendingBytes - preview.bytes);
  }

  private disposeContext(context: EditContext): void {
    if (context.closed) return;
    context.closed = true;
    for (const previewId of context.previews.keys()) this.dropPreview(context, previewId);
    context.store.clear();
  }
}

class EditServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function encode(value: unknown): SerializedResult {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > WORKER_EDIT_OUTPUT_BYTES) {
    return { json: OUTPUT_TOO_LARGE, oversized: true };
  }
  return { json, oversized: false };
}

function publicOutcome(outcome: EditApplyOutcome, root: string) {
  return {
    text: outcome.text,
    isError: outcome.isError,
    files: outcome.files.map((file: EditFileOutcome) => ({
      path: file.displayPath,
      op: file.op,
      ...(file.moveTo ? { moveTo: displayPath(root, file.moveTo) } : {}),
      diff: file.diff,
      ...(file.firstChangedLine ? { firstChangedLine: file.firstChangedLine } : {}),
      snapshotsPruned: file.snapshotsPruned,
      warnings: file.warnings,
      ...(file.diagnosticsJson ? { diagnosticsJson: file.diagnosticsJson } : {}),
      text: file.text,
      parseRegressed: file.parseRegressed,
    })),
  };
}

function displayPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function appliedLabels(writes: EditWriteRequest[], root: string): string[] {
  return writes.map((request) =>
    request.moveTo
      ? `${displayPath(root, request.path)} -> ${displayPath(root, request.moveTo)}`
      : displayPath(root, request.path),
  );
}

function editModeFor(patch: string): EditMode {
  // Both exported grammars use Begin Patch; their file headers distinguish them.
  return /^\*\*\* Begin Patch\s*\r?\n\s*\*\*\* (?:Add|Update|Delete) File:/u.test(patch.trimStart())
    ? "apply_patch"
    : "hashline";
}

function assertWriteModeAllows(writeMode: WorkerWriteMode | undefined, operation: string): void {
  if (
    writeMode !== undefined &&
    (writeMode === "edit" ? operation !== "update" : operation !== "create")
  ) {
    throw new EditServiceError("WRITE_MODE_DENIED");
  }
}

function instructionsFor(mode: EditMode): string {
  return mode === "hashline" ? EDIT_INSTRUCTIONS : APPLY_PATCH_INSTRUCTIONS;
}

function grammarFor(mode: EditMode): string {
  return mode === "hashline" ? EDIT_GRAMMAR : APPLY_PATCH_GRAMMAR;
}

function formatRead(
  text: string,
  startLine: number,
  maxLines?: number,
): {
  content: string;
  visibleLines: number[];
  truncated: boolean;
  nextLine: number;
} {
  const chunks: string[] = [];
  const visibleLines: number[] = [];
  let bytes = 0;
  let lineNumber = 1;
  let truncated = false;
  for (const line of textLines(text)) {
    if (lineNumber < startLine) {
      lineNumber += 1;
      continue;
    }
    const formatted = `${hashlineFormatNumberedLines(line.text, lineNumber)}${line.separator}`;
    const formattedBytes = new TextEncoder().encode(formatted).byteLength;
    if (
      bytes + formattedBytes > READ_CONTENT_BYTES ||
      (maxLines !== undefined && visibleLines.length >= maxLines)
    ) {
      truncated = true;
      break;
    }
    chunks.push(formatted);
    visibleLines.push(lineNumber);
    bytes += formattedBytes;
    lineNumber += 1;
  }
  if (lineNumber <= countLines(text)) truncated = true;
  return { content: chunks.join(""), visibleLines, truncated, nextLine: lineNumber };
}

function* textLines(text: string): Generator<{ text: string; separator: string }> {
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\n" && char !== "\r") continue;
    const separator = char === "\r" && text[index + 1] === "\n" ? "\r\n" : char!;
    yield { text: text.slice(start, index), separator };
    if (separator.length === 2) index += 1;
    start = index + 1;
  }
  if (start < text.length || start === text.length) {
    yield { text: text.slice(start), separator: "" };
  }
}

function countLines(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n" || text[index] === "\r") {
      if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
      count += 1;
    }
  }
  return count;
}

async function readTextFile(absolutePath: string): Promise<string> {
  if ((await stat(absolutePath)).size > MAX_FILE_BYTES) {
    throw new EditServiceError("FILE_NOT_TEXT_OR_TOO_LARGE");
  }
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) {
    throw new EditServiceError("FILE_NOT_TEXT_OR_TOO_LARGE");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EditServiceError("FILE_NOT_UTF8");
  }
}

function stagedByteSize(writes: EditWriteRequest[], expectations: ExpectedPath[]): number {
  const encoder = new TextEncoder();
  return (
    writes.reduce((size, write) => size + encoder.encode(write.content ?? "").byteLength, 0) +
    expectations.reduce(
      (size, expected) => size + encoder.encode(expected.text ?? "").byteLength,
      0,
    )
  );
}

async function ensureParentDirectories(root: string, absolutePath: string): Promise<void> {
  const parent = dirname(absolutePath);
  const relativeParent = relative(root, parent);
  let current = root;
  for (const component of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, component);
    const resolved = await resolveWorkerEditPath(root, current, "directory");
    if (!resolved.exists) {
      await mkdir(current);
      await resolveWorkerEditPath(root, current, "directory");
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof WorkerEditPathError) return error.code;
  if (error instanceof EditServiceError) return error.code;
  return "EDIT_APPLY_FAILED";
}

function applyErrorMessage(error: unknown): string {
  if (error instanceof EditServiceError && error.code === "STALE_PREVIEW") {
    return "A file changed after this preview. Read the current file and preview the edit again.";
  }
  if (error instanceof WorkerEditPathError) return error.message;
  if (error instanceof EditServiceError) return error.code;
  return "The staged edit could not be applied.";
}
