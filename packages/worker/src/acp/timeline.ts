import type {
  ContentBlock,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import {
  ACP_HISTORY_PAGE_ITEMS,
  ACP_ITEM_CONTENT_BYTES,
  ACP_SNAPSHOT_BYTES,
  utf8Bytes,
  type AcpConfig,
  type AcpConfigOption,
  type AcpItem,
  type AcpItemPatch,
  type AcpMessagePart,
  type AcpOp,
  type AcpPromptBlock,
  type AcpStopReason,
  type AcpToolContent,
} from "backend/src/acp/contract";

type MessageItem = Extract<AcpItem, { text: string }>;
type ToolItem = Extract<AcpItem, { kind: "tool" }>;
type NoticeItem = Extract<AcpItem, { kind: "notice" }>;
const MEMORY_BYTES = 8 * 1024 * 1024;

function prefix(value: string, bytes: number): string {
  if (bytes <= 0) return "";
  if (utf8Bytes(value) <= bytes) return value;
  const encoded = new TextEncoder().encode(value);
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

function messagePart(content: ContentBlock): AcpMessagePart | undefined {
  switch (content.type) {
    case "text":
      return undefined;
    case "image":
      return {
        type: "image",
        mimeType: content.mimeType,
        ...(content.uri ? { uri: content.uri } : {}),
      };
    case "audio":
      return { type: "audio", mimeType: content.mimeType };
    case "resource_link":
      return {
        type: "resource_link",
        uri: content.uri,
        name: content.name,
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      };
    case "resource":
      return {
        type: "resource",
        uri: content.resource.uri,
        ...(content.resource.mimeType ? { mimeType: content.resource.mimeType } : {}),
      };
  }
}

function toolContent(content: ToolCallContent): AcpToolContent | undefined {
  switch (content.type) {
    case "diff":
      return {
        type: "diff",
        path: content.path,
        newText: content.newText,
        ...(content.oldText != null ? { oldText: content.oldText } : {}),
      };
    case "terminal":
      return { type: "terminal", terminalId: content.terminalId };
    case "content": {
      const block = content.content;
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "image") return { type: "image", mimeType: block.mimeType };
      if (block.type === "resource_link")
        return {
          type: "resource",
          uri: block.uri,
          name: block.name,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        };
      if (block.type === "resource")
        return {
          type: "resource",
          uri: block.resource.uri,
          ...(block.resource.mimeType ? { mimeType: block.resource.mimeType } : {}),
        };
      return undefined;
    }
  }
}

function configOptions(options: SessionConfigOption[]): AcpConfigOption[] {
  return options.map((option) => {
    const common = {
      id: option.id,
      name: option.name,
      ...(option.description != null ? { description: option.description } : {}),
      ...(option.category != null ? { category: option.category } : {}),
    };
    if (option.type === "boolean")
      return { ...common, type: "boolean", currentValue: option.currentValue };
    const choices = option.options.flatMap<
      Extract<AcpConfigOption, { type: "select" }>["choices"][number]
    >((entry) =>
      "group" in entry
        ? entry.options.map((choice) => ({
            value: choice.value,
            name: choice.name,
            group: entry.group,
            ...(choice.description != null ? { description: choice.description } : {}),
          }))
        : [
            {
              value: entry.value,
              name: entry.name,
              ...(entry.description != null ? { description: entry.description } : {}),
            },
          ],
    );
    return { ...common, type: "select", currentValue: option.currentValue, choices };
  });
}

/** Normalize SDK response config, preserving fields omitted by partial responses. */
export function normalizeConfig(
  response: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null },
  previous?: AcpConfig,
): AcpConfig {
  const config: AcpConfig = {
    ...previous,
    options:
      response.configOptions != null
        ? configOptions(response.configOptions)
        : (previous?.options ?? []),
  };
  if (response.modes != null) {
    config.modes = {
      currentModeId: response.modes.currentModeId,
      available: response.modes.availableModes.map(({ id, name, description }) => ({
        id,
        name,
        ...(description != null ? { description } : {}),
      })),
    };
  }
  return config;
}

/** Remove binary payloads and bound normalized tool content for host-side permission mapping. */
export function normalizeToolContent(content: ToolCallContent[]): AcpToolContent[] {
  const normalized = content.flatMap((block) => {
    const result = toolContent(block);
    return result ? [result] : [];
  });
  return (
    boundTool({ id: "", order: 0, kind: "tool", title: "", toolCallId: "", content: normalized })
      .content ?? []
  );
}

// Bound the combined content/raw budget, retaining valid normalized content rather than broken JSON.
function boundTool(item: ToolItem): ToolItem {
  let remaining = ACP_ITEM_CONTENT_BYTES - 2;
  let truncated = false;
  const take = (value: string): string => {
    let result = value;
    if (utf8Bytes(JSON.stringify(result)) - 2 > remaining) {
      let low = 0;
      let high = Math.min(utf8Bytes(value), remaining);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (utf8Bytes(JSON.stringify(prefix(value, middle))) - 2 <= remaining) low = middle;
        else high = middle - 1;
      }
      result = prefix(value, low);
    }
    remaining -= utf8Bytes(JSON.stringify(result)) - 2;
    if (result !== value) truncated = true;
    return result;
  };
  const content: AcpToolContent[] = [];
  for (const block of item.content ?? []) {
    const empty =
      block.type === "text"
        ? { ...block, text: "" }
        : block.type === "diff"
          ? { ...block, newText: "", ...(block.oldText !== undefined ? { oldText: "" } : {}) }
          : block;
    const overhead = utf8Bytes(JSON.stringify(empty)) + (content.length ? 1 : 0);
    if (overhead > remaining) {
      truncated = true;
      break;
    }
    remaining -= overhead;
    let bounded: AcpToolContent;
    if (block.type === "text") bounded = { ...block, text: take(block.text) };
    else if (block.type === "diff")
      bounded = {
        ...block,
        ...(block.oldText !== undefined ? { oldText: take(block.oldText) } : {}),
        newText: take(block.newText),
      };
    else bounded = block;
    content.push(bounded);
  }
  const result = { ...item, ...(item.content !== undefined ? { content } : {}) };
  if (item.rawInput !== undefined) result.rawInput = take(item.rawInput);
  if (item.rawOutput !== undefined) result.rawOutput = take(item.rawOutput);
  if (truncated) result.truncated = true;
  return result;
}

/** In-memory ACP transcript; content never persists here beyond this Worker process. */
export class AcpTimeline {
  /** Latest merged metadata, mirrored by the host independently of warm frames. */
  public sessionPatch: Extract<AcpOp, { op: "session.patch" }> = { op: "session.patch" };
  /** Older items were evicted; the host must reload the agent before serving missing history. */
  public needsReload = false;
  private readonly items = new Map<string, AcpItem>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;
  private order = 0;
  private serial = 0;
  private turnId: string | undefined;
  private message: { id: string; kind: MessageItem["kind"] } | undefined;

  /** Begin a locally admitted turn and reset implicit message grouping. */
  public startTurn(turnId: string): AcpOp[] {
    this.turnId = turnId;
    this.message = undefined;
    return [{ op: "turn.start", turnId }];
  }

  /** Finish the current turn; errors also remain visible as timeline notices. */
  public endTurn(stopReason?: AcpStopReason, error?: string): AcpOp[] {
    if (!this.turnId) return [];
    const ops: AcpOp[] = [];
    if (error)
      ops.push(
        ...this.store({
          ...this.base(`notice:${++this.serial}`),
          kind: "notice",
          severity: "error",
          title: error,
        }),
      );
    ops.push({
      op: "turn.end",
      turnId: this.turnId,
      ...(stopReason ? { stopReason } : {}),
      ...(error ? { error } : {}),
    });
    this.turnId = undefined;
    this.message = undefined;
    return ops;
  }

  /** Record the text/resource-only prompt sent by the host as one user item. */
  public user(prompt: AcpPromptBlock[]): AcpOp[] {
    this.message = undefined;
    const parts = prompt
      .filter((block) => block.type === "resource_link")
      .map((block) => ({ ...block }));
    return this.store({
      ...this.base(`user:${++this.serial}`),
      kind: "user",
      text: prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      ...(parts.length ? { parts } : {}),
    });
  }

  /** Normalize all stable SDK session updates, preserving patch/null and chunk semantics. */
  public update(update: SessionUpdate): AcpOp[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind =
          update.sessionUpdate === "user_message_chunk"
            ? "user"
            : update.sessionUpdate === "agent_message_chunk"
              ? "agent"
              : "thought";
        const id =
          update.messageId != null
            ? `msg:${update.messageId}`
            : this.message?.kind === kind
              ? this.message.id
              : `message:${++this.serial}`;
        this.message = { id, kind };
        const existing = this.items.get(id);
        const previous = existing && "text" in existing ? existing : undefined;
        const part = messagePart(update.content);
        const item: MessageItem = {
          ...(previous ?? this.base(id)),
          kind,
          text:
            (previous?.text ?? "") + (update.content.type === "text" ? update.content.text : ""),
          ...(update.messageId != null ? { messageId: update.messageId } : {}),
          ...(part ? { parts: [...(previous?.parts ?? []), part] } : {}),
        };
        this.store(item);
        if (!previous) return [{ op: "item.upsert", item }];
        if (update.content.type === "text")
          return [{ op: "text.append", id, text: update.content.text }];
        return [{ op: "item.upsert", item: { id, parts: item.parts } }];
      }
      case "tool_call":
      case "tool_call_update": {
        this.message = undefined;
        const id = `tool:${update.toolCallId}`;
        const previous = this.items.get(id);
        const fresh = update.sessionUpdate === "tool_call" || previous?.kind !== "tool";
        const item: ToolItem =
          previous?.kind === "tool" && update.sessionUpdate !== "tool_call"
            ? { ...previous }
            : {
                ...this.base(id),
                kind: "tool",
                toolCallId: update.toolCallId,
                title: update.title ?? update.toolCallId,
              };
        const patch: AcpItemPatch = fresh ? { ...item } : { id };
        if (fresh && previous) {
          Object.assign(patch, {
            toolKind: null,
            status: null,
            locations: null,
            content: null,
            rawInput: null,
            rawOutput: null,
            truncated: null,
          });
        }
        // SDK field names differ from the relay contract; this record only addresses known item keys.
        const fields = item as unknown as Record<string, unknown>;
        for (const [source, target] of [
          ["title", "title"],
          ["kind", "toolKind"],
          ["status", "status"],
          ["locations", "locations"],
          ["content", "content"],
          ["rawInput", "rawInput"],
          ["rawOutput", "rawOutput"],
        ] as const) {
          const value = update[source];
          if (value === undefined) continue;
          let normalized: unknown = value;
          if (source === "content" && update.content != null)
            normalized = update.content.flatMap((block) => {
              const result = toolContent(block);
              return result ? [result] : [];
            });
          if (source === "locations" && update.locations != null)
            normalized = update.locations.map((location) => ({
              path: location.path,
              ...(location.line != null ? { line: location.line } : {}),
            }));
          if ((source === "rawInput" || source === "rawOutput") && value !== null)
            normalized = JSON.stringify(value);
          Object.assign(patch, { [target]: normalized });
          if (normalized === null) delete fields[target];
          else Object.assign(item, { [target]: normalized });
        }
        const bounded =
          update.content !== undefined ||
          update.rawInput !== undefined ||
          update.rawOutput !== undefined
            ? boundTool(item)
            : item;
        if (bounded !== item) {
          for (const field of ["content", "rawInput", "rawOutput", "truncated"] as const) {
            if (JSON.stringify(bounded[field]) !== JSON.stringify(item[field]))
              Object.assign(patch, { [field]: bounded[field] });
          }
        }
        this.store(bounded);
        return [{ op: "item.upsert", item: patch }];
      }
      case "plan":
        return this.store({
          ...this.base(`plan:${this.turnId ?? "replay"}`),
          kind: "plan",
          entries: update.entries.map(({ content, status, priority }) => ({
            content,
            status,
            priority,
          })),
        });
      case "notice":
        return this.store({
          ...this.base(`notice:${++this.serial}`),
          kind: "notice",
          severity: update.severity,
          title: update.title,
          ...(update.description != null ? { description: update.description } : {}),
        });
      case "compaction_update":
      case "compaction_summary_chunk": {
        const id = `compaction:${update.compactionId}`;
        const previous = this.items.get(id);
        const item: NoticeItem =
          previous?.kind === "notice"
            ? { ...previous, compaction: { ...previous.compaction! } }
            : {
                ...this.base(id),
                kind: "notice",
                severity: "info",
                title: "Context compaction",
                compaction: { id: update.compactionId, status: "in_progress" },
              };
        const summaryText = (block: ContentBlock) =>
          block.type === "text"
            ? block.text
            : block.type === "resource_link"
              ? block.uri
              : block.type === "resource"
                ? block.resource.uri
                : `[${block.type}]`;
        if (update.sessionUpdate === "compaction_summary_chunk")
          item.compaction!.summary = (item.compaction!.summary ?? "") + summaryText(update.content);
        else {
          item.compaction!.status = update.status;
          if (update.summary !== undefined) {
            if (update.summary === null) delete item.compaction!.summary;
            else item.compaction!.summary = update.summary.map(summaryText).join("");
          }
          if (update.error !== undefined) {
            if (update.error === null) delete item.description;
            else item.description = update.error;
          }
          item.severity = update.status === "failed" ? "error" : "info";
        }
        this.store(item);
        return [
          {
            op: "item.upsert",
            item: {
              ...item,
              ...(update.sessionUpdate === "compaction_update" && update.error === null
                ? { description: null }
                : {}),
            },
          },
        ];
      }
      case "available_commands_update":
        return this.patch({
          commands: update.availableCommands.map(({ name, description, input }) => ({
            name,
            description,
            ...(input ? { hint: input.hint } : {}),
          })),
        });
      case "config_option_update":
        return this.patch({ config: normalizeConfig(update, this.sessionPatch.config) });
      case "current_mode_update":
        return this.patch({
          config: {
            options: [],
            ...this.sessionPatch.config,
            modes: {
              available: this.sessionPatch.config?.modes?.available ?? [],
              currentModeId: update.currentModeId,
            },
          },
        });
      case "usage_update":
        return this.patch({
          usage: {
            used: update.used,
            size: update.size,
            ...(update.cost
              ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
              : {}),
          },
        });
      case "session_info_update":
        return this.patch({
          info: {
            ...this.sessionPatch.info,
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
          },
        });
    }
  }

  /** Return a latest whole-item window; oversized items remain available through history. */
  public snapshot(maxBytes = ACP_SNAPSHOT_BYTES): AcpOp[] {
    const tail: AcpOp[] = [this.sessionPatch];
    const head: AcpOp[] = this.turnId ? [{ op: "turn.start", turnId: this.turnId }] : [];
    const selected: AcpOp[] = [];
    const items = [...this.items.values()];
    let start = this.order;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      const op: AcpOp = { op: "item.upsert", item };
      const candidate: AcpOp[] = [
        { op: "window", start: item.order, hasMore: item.order > 0 || this.needsReload },
        ...head,
        op,
        ...selected,
        ...tail,
      ];
      if (utf8Bytes(JSON.stringify(candidate)) > maxBytes) break;
      selected.unshift(op);
      start = item.order;
    }
    return [
      { op: "window", start, hasMore: start > 0 || this.needsReload },
      ...head,
      ...selected,
      ...tail,
    ];
  }

  /** Return at most one bounded item-count page strictly older than `before`. */
  public history(before: number, limit: number): AcpOp[] {
    const count = Math.max(1, Math.min(ACP_HISTORY_PAGE_ITEMS, Math.floor(limit) || 1));
    const eligible = [...this.items.values()].filter((item) => item.order < before);
    const items = eligible.slice(-count);
    const start = items[0]?.order ?? before;
    return [
      { op: "window", start, before, hasMore: eligible.length > items.length || this.needsReload },
      ...items.map((item): AcpOp => ({ op: "item.upsert", item })),
    ];
  }

  private patch(patch: Omit<Extract<AcpOp, { op: "session.patch" }>, "op">): AcpOp[] {
    this.sessionPatch = { ...this.sessionPatch, ...patch };
    return [{ op: "session.patch", ...patch }];
  }

  private base(id: string): { id: string; order: number; turnId?: string } {
    const old = this.items.get(id);
    return {
      id,
      order: old?.order ?? this.order++,
      ...((old?.turnId ?? this.turnId) ? { turnId: old?.turnId ?? this.turnId } : {}),
    };
  }

  private store(item: AcpItem): AcpOp[] {
    this.bytes -= this.sizes.get(item.id) ?? 0;
    const size = utf8Bytes(JSON.stringify(item));
    this.items.set(item.id, item);
    this.sizes.set(item.id, size);
    this.bytes += size;
    while (this.bytes > MEMORY_BYTES && this.items.size > 0) {
      const oldest = this.items.keys().next().value!;
      this.bytes -= this.sizes.get(oldest)!;
      this.sizes.delete(oldest);
      this.items.delete(oldest);
      if (this.message?.id === oldest) this.message = undefined;
      this.needsReload = true;
    }
    return [{ op: "item.upsert", item }];
  }
}
