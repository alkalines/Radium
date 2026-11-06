import type { AcpConfig } from "./contract";

/**
 * ACP model vocabulary. Agents advertise models as opaque select choices (`provider/model` from
 * OpenCode, aliases such as `claude-agent/haiku`, bare ids from other harnesses); Chatroom groups
 * them for the picker and the backend matches them to a price, so both read them the same way.
 */

const families: Array<[RegExp, { slug: string; name: string }]> = [
  [/\b(?:claude|anthropic)\b/i, { slug: "anthropic", name: "Anthropic" }],
  [/\b(?:gpt|o1|o3|o4|codex|chatgpt|openai)\b/i, { slug: "openai", name: "OpenAI" }],
  [/\b(?:gemini|gemma|google)\b/i, { slug: "google", name: "Google" }],
  [/\bgrok\b/i, { slug: "xai", name: "xAI" }],
  [/\bllama\b/i, { slug: "meta", name: "Meta" }],
  [/\b(?:mistral|codestral|devstral|magistral)\b/i, { slug: "mistral", name: "Mistral" }],
  [/\bdeepseek\b/i, { slug: "deepseek", name: "DeepSeek" }],
  [/\b(?:qwen|qwq)\b/i, { slug: "alibaba", name: "Alibaba" }],
  [/\bkimi\b/i, { slug: "moonshotai", name: "Moonshot AI" }],
  [/\bglm\b/i, { slug: "zai", name: "Z.ai" }],
  [/\bminimax\b/i, { slug: "minimax", name: "MiniMax" }],
  [/\bnemotron\b/i, { slug: "nvidia", name: "NVIDIA" }],
  [/\bseed\b/i, { slug: "bytedance", name: "ByteDance" }],
  [/\bphi\b/i, { slug: "microsoft", name: "Microsoft" }],
  [/\bgranite\b/i, { slug: "ibm", name: "IBM" }],
  [/\bsonar\b/i, { slug: "perplexity", name: "Perplexity" }],
  [/\bmimo\b/i, { slug: "xiaomi", name: "Xiaomi" }],
  [/\bernie\b/i, { slug: "baidu", name: "Baidu" }],
  [/\bhunyuan\b/i, { slug: "tencent", name: "Tencent" }],
];

/** The lab whose family name appears in `text`, after splitting `llama3`-style version suffixes. */
function familyOf(text: string) {
  // Separators and version digits are common in model ids (e.g. llama3 or qwen3).
  const normalized = text.replace(/([a-z]{2,})(?=\d)/gi, "$1 ").replace(/_/g, " ");
  return families.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

/**
 * Infer the lab from the model ID and name. The routing prefix (`provider/model`) is only a last
 * resort, for aliases such as `claude-agent/haiku` whose provider is named after the lab.
 */
export function inferModelAuthor(value: string, name: string) {
  const modelId = value.split("/").pop() ?? value;
  const modelName = name.split("/").pop() ?? name;
  const prefix = value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
  for (const candidate of [modelId, modelName, prefix]) {
    const author = familyOf(candidate);
    if (author) return author;
  }
  return null;
}

/**
 * The same model offered by several providers shares one key: the last ID segment, lowercased,
 * without a `~` alias marker or `-YYYYMMDD` date, with `.` read as `-` (`claude-sonnet-4.6` and
 * `claude-sonnet-4-6` match).
 */
export function modelKey(value: string) {
  const id = value.split("/").pop() ?? value;
  return id
    .toLowerCase()
    .replace(/^~/, "")
    .replace(/[-_]\d{8}$/, "")
    .replaceAll(".", "-");
}

/**
 * A model's display name as a comparable key: `Claude Haiku 5.5` and `Haiku 5.5` both read
 * `haiku-5-5`, since aliases such as OpenCode's Claude Agent (`claude-agent/haiku`) drop the
 * Claude brand from the name and carry no version in the ID.
 */
export function nameKey(name: string) {
  return name
    .toLowerCase()
    .replace(/^claude\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The selected choice of the agent's `model` config option, when it advertises one. */
export function selectedAcpModel(config: AcpConfig | null | undefined) {
  const option = config?.options.find(
    (candidate) => candidate.category === "model" && candidate.type === "select",
  );
  if (option?.type !== "select") return undefined;
  const choice = option.choices.find((candidate) => candidate.value === option.currentValue);
  return {
    id: option.currentValue,
    name: choice?.name ?? option.currentValue,
    ...(choice?.description ? { description: choice.description } : {}),
  };
}
