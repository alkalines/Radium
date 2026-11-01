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

/**
 * Infer the lab from the model ID and name. The routing prefix (`provider/model`) is only a last
 * resort, for aliases such as `claude-agent/haiku` whose provider is named after the lab.
 */
export function inferModelAuthor(value: string, name: string) {
  const modelId = value.split("/").pop() ?? value;
  const modelName = name.split("/").pop() ?? name;
  const prefix = value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
  // Separators and version digits are common in model ids (e.g. llama3 or qwen3).
  const normalize = (text: string) => text.replace(/([a-z]{2,})(?=\d)/gi, "$1 ").replace(/_/g, " ");
  for (const candidate of [modelId, modelName, prefix]) {
    const author = families.find(([pattern]) => pattern.test(normalize(candidate)))?.[1];
    if (author) return author;
  }
  return null;
}
