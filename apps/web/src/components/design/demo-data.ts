/**
 * Static fixtures for the `/design` reference. Nothing here reflects real workspace data, and no
 * screen in the reference calls Convex, Gateway, or a Worker.
 */

export type DemoProject = {
  id: string;
  name: string;
  initial: string;
  /** Branches available on the selected Worker's checkout; the first is checked out. */
  branches: string[];
};

export type DemoSession = {
  id: string;
  projectId: string;
  title: string;
  group: "Today" | "Yesterday" | "Older";
  updated: string;
  /** Prompt shown when the session is reopened; reopened sessions render their finished run. */
  prompt: string;
};

export type DemoWorkspace = {
  id: string;
  name: string;
  initial: string;
  /** Owners manage configuration and credentials; members use what owners configured. */
  role: "Owner" | "Member";
};

export const demoWorkspaces: DemoWorkspace[] = [
  { id: "alkalines", name: "alkalines", initial: "A", role: "Owner" },
  { id: "radium-lab", name: "radium-lab", initial: "R", role: "Member" },
];

export const demoUser = { name: "Arthur", email: "arthur@example.com", initials: "AR" };

export const demoProjects: DemoProject[] = [
  {
    id: "radium",
    name: "alkalines-radium",
    initial: "A",
    branches: ["feat/agentic-design-system", "dev", "main"],
  },
  { id: "radium-docs", name: "radium-docs", initial: "D", branches: ["main", "draft/acp"] },
  { id: "gateway-bench", name: "gateway-bench", initial: "G", branches: ["main"] },
  { id: "worker-relay", name: "worker-relay", initial: "W", branches: ["main", "feat/quic"] },
  { id: "radium-mobile", name: "radium-mobile", initial: "M", branches: ["main", "expo-54"] },
  { id: "watch-face", name: "watch-face", initial: "F", branches: ["main"] },
  { id: "homelab", name: "homelab", initial: "H", branches: ["main", "k3s"] },
  { id: "dotfiles", name: "dotfiles", initial: "T", branches: ["main"] },
  { id: "website", name: "alkalines.dev", initial: "S", branches: ["main", "redesign"] },
];

/** Initial for a Project tile; unknown Projects get a neutral placeholder. */
export function projectInitial(projectId: string) {
  return demoProjects.find((project) => project.id === projectId)?.initial ?? "?";
}

export const demoSessions: DemoSession[] = [
  {
    id: "s-motion",
    projectId: "radium",
    title: "Align reveal transitions with motion tokens",
    group: "Today",
    updated: "12m",
    prompt:
      "Run the edit-engine unit tests on my dev Worker and align the reveal transition with our motion tokens.",
  },
  {
    id: "s-gateway",
    projectId: "radium",
    title: "Gateway fallback when an upstream account is rate limited",
    group: "Today",
    updated: "2h",
    prompt: "Add a fallback upstream when the primary Anthropic account returns 429.",
  },
  {
    id: "s-worker",
    projectId: "radium",
    title: "Worker enrollment flow and machine identity rotation",
    group: "Yesterday",
    updated: "1d",
    prompt: "Walk through Worker enrollment and propose identity rotation.",
  },
  {
    id: "s-bash",
    projectId: "radium",
    title: "Integrate Bash tool into Chatroom and Worker",
    group: "Older",
    updated: "6d",
    prompt: "Wire the Bash tool from Chatroom through to the Worker.",
  },
  {
    id: "s-agents",
    projectId: "radium",
    title: "Review AGENTS.md formatting and completion ID mapping",
    group: "Older",
    updated: "9d",
    prompt: "Review AGENTS.md formatting and the completion ID mapping.",
  },
  {
    id: "s-telemetry",
    projectId: "radium",
    title: "Owner-only telemetry that filters private chats",
    group: "Older",
    updated: "2w",
    prompt: "Make Gateway telemetry owner-only and filter other users' private chats.",
  },
];

export type DemoModelProvider = { id: string; name: string; logo: string };

export type DemoModel = {
  id: string;
  name: string;
  /** The lab that made the model; its logo leads the picker row. */
  author: { name: string; slug: string };
  /** Configured upstreams that can serve the model; the first is the default. */
  providers: DemoModelProvider[];
  /** Reasoning levels in the provider's vocabulary; empty when the model cannot reason. */
  efforts: string[];
  /** Whether the model also accepts an explicit reasoning token budget. */
  reasoningBudget: boolean;
};

const anthropicMain = { id: "anthropic-main", name: "Anthropic · main", logo: "anthropic" };
const anthropicTeam = { id: "anthropic-team", name: "Anthropic · team", logo: "anthropic" };
const openrouter = { id: "openrouter", name: "OpenRouter", logo: "openrouter" };

export const demoModels: DemoModel[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    author: { name: "Anthropic", slug: "anthropic" },
    providers: [anthropicMain, anthropicTeam, openrouter],
    efforts: ["none", "low", "medium", "high"],
    reasoningBudget: true,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    author: { name: "Anthropic", slug: "anthropic" },
    providers: [anthropicMain, openrouter],
    efforts: ["none", "low", "medium", "high"],
    reasoningBudget: true,
  },
  {
    id: "gpt-5-5",
    name: "GPT-5.5",
    author: { name: "OpenAI", slug: "openai" },
    providers: [{ id: "openai", name: "OpenAI · default", logo: "openai" }, openrouter],
    efforts: ["minimal", "low", "medium", "high"],
    reasoningBudget: false,
  },
  {
    id: "qwen3-coder-32b",
    name: "Qwen3 Coder 32B",
    author: { name: "Alibaba", slug: "alibaba" },
    providers: [{ id: "llama-box", name: "llama-box", logo: "llama" }],
    efforts: [],
    reasoningBudget: false,
  },
];

export type DemoProvider = {
  id: string;
  name: string;
  credential: "API key" | "Account" | "Endpoint";
  account: string;
};

export const connectedProviders: DemoProvider[] = [
  { id: "anthropic-main", name: "Anthropic", credential: "API key", account: "main" },
  { id: "anthropic-team", name: "Anthropic", credential: "API key", account: "team" },
  { id: "openai", name: "OpenAI", credential: "Account", account: "default" },
  { id: "llama-box", name: "OpenAI-compatible", credential: "Endpoint", account: "llama-box" },
];

export const availableProviders = [
  { id: "openrouter", name: "OpenRouter", description: "Hundreds of models behind one API key" },
  { id: "google", name: "Google", description: "Gemini models via API key" },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    description: "Claude and open models in your AWS account",
  },
];

/**
 * An agent harness the Session can drive. `radium` is the built-in agent; the others are external
 * harnesses spoken to over ACP (Agent Client Protocol) on the Worker that has them installed.
 * ACP support is planned; these entries only shape the interface.
 */
export type DemoAgent = {
  id: string;
  name: string;
  /** models.dev logo slug; the built-in agent uses the Radium mark instead. */
  logo?: string;
  protocol: "built-in" | "acp";
};

export const demoAgents: DemoAgent[] = [
  { id: "radium", name: "Radium", protocol: "built-in" },
  { id: "claude-code", name: "Claude Code", logo: "anthropic", protocol: "acp" },
  { id: "codex", name: "Codex", logo: "openai", protocol: "acp" },
  { id: "gemini-cli", name: "Gemini CLI", logo: "google", protocol: "acp" },
  { id: "opencode", name: "OpenCode", logo: "opencode", protocol: "acp" },
];

/** A connected machine. Workers have no profiles: each connects once and runs as one OS user. */
export type DemoWorker = {
  id: string;
  name: string;
  username: string;
  online: boolean;
  /** ACP agents installed on this machine, by `DemoAgent.id`. The built-in agent is always there. */
  acpAgents: string[];
};

export const demoWorkers: DemoWorker[] = [
  {
    id: "w-dev",
    name: "radium-dev-01",
    username: "arthu",
    online: true,
    acpAgents: ["claude-code", "codex", "opencode"],
  },
  { id: "w-ci", name: "ci-runner", username: "runner", online: true, acpAgents: ["gemini-cli"] },
  {
    id: "w-gpu",
    name: "gpu-box",
    username: "arthu",
    online: true,
    acpAgents: ["claude-code", "opencode"],
  },
  { id: "w-nas", name: "homelab-nas", username: "admin", online: true, acpAgents: [] },
  { id: "w-pi", name: "pi-garage", username: "pi", online: true, acpAgents: ["opencode"] },
  { id: "w-vps", name: "fsn1-vps", username: "deploy", online: true, acpAgents: ["codex"] },
  { id: "w-mac", name: "studio", username: "arthur", online: false, acpAgents: [] },
  { id: "w-old", name: "thinkpad-x220", username: "arthu", online: false, acpAgents: [] },
];
