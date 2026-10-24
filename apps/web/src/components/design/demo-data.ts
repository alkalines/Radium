/**
 * Static fixtures for the `/design` reference. Nothing here reflects real workspace data, and no
 * screen in the reference calls Convex, Gateway, or a Worker.
 */

export type DemoProject = { id: string; name: string; initial: string };

export type DemoSession = {
  id: string;
  projectId: string;
  title: string;
  group: "Today" | "Yesterday" | "Older";
  updated: string;
  /** Prompt shown when the session is reopened; reopened sessions render their finished run. */
  prompt: string;
};

export const workspaceName = "alkalines-radium";

export const demoProjects: DemoProject[] = [
  { id: "radium", name: "alkalines-radium", initial: "A" },
];

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

export const demoModels = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "qwen3-coder-32b", label: "Qwen3 Coder 32B" },
] as const;

export const demoEfforts = ["Low", "Medium", "High"] as const;

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

export type DemoWorker = {
  id: string;
  name: string;
  host: string;
  kind: "Local" | "Remote";
  online: boolean;
};

export const demoWorkers: DemoWorker[] = [
  { id: "w-dev", name: "radium-dev-01", host: "arthu-cachyos", kind: "Local", online: true },
  { id: "w-ci", name: "ci-runner", host: "hetzner-fsn1", kind: "Remote", online: true },
  { id: "w-mac", name: "studio", host: "mac-studio.lan", kind: "Remote", online: false },
];
