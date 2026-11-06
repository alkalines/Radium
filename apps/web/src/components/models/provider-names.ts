/**
 * Display names for provider IDs that agents report on their own (OpenCode routes models as
 * `provider/model` with models.dev provider IDs). Names follow models.dev, except where the
 * product name reads clearer (`opencode` is OpenCode Zen beside OpenCode Go); unknown IDs, such as
 * a user's custom providers, are title-cased (`claude-agent` → `Claude Agent`).
 */
const providerNames: Record<string, string> = {
  "302ai": "302.AI",
  aihubmix: "AIHubMix",
  alibaba: "Alibaba",
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  azure: "Azure",
  baseten: "Baseten",
  cerebras: "Cerebras",
  chutes: "Chutes",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  cohere: "Cohere",
  deepinfra: "Deep Infra",
  deepseek: "DeepSeek",
  "fireworks-ai": "Fireworks AI",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-vertex": "Vertex",
  "google-vertex-anthropic": "Vertex (Anthropic)",
  groq: "Groq",
  huggingface: "Hugging Face",
  inception: "Inception",
  lmstudio: "LM Studio",
  minimax: "MiniMax",
  mistral: "Mistral",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  "nano-gpt": "NanoGPT",
  nebius: "Nebius Token Factory",
  "novita-ai": "Novita AI",
  nvidia: "NVIDIA",
  ollama: "Ollama",
  "ollama-cloud": "Ollama Cloud",
  openai: "OpenAI",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  requesty: "Requesty",
  siliconflow: "SiliconFlow",
  togetherai: "Together AI",
  venice: "Venice AI",
  vercel: "Vercel AI Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi",
  zai: "Z.AI",
  "zai-coding-plan": "Z.AI Coding Plan",
  zenmux: "ZenMux",
  zhipuai: "Zhipu AI",
};

export function providerDisplayName(id: string) {
  return (
    providerNames[id] ??
    id
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ")
  );
}
