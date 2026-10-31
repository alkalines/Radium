/**
 * Catalogue identity of the model answering a Chatroom request. `name` and `author` are absent
 * when the slug has no global `models` record (for example a provider-only mapping).
 */
export type ChatModelIdentity = {
  slug: string;
  name?: string;
  author?: string;
};

/**
 * Radium orientation shared by every Chatroom request. It describes the environment and the few
 * harness rules every model needs (permission boundaries, tool use); it sets no style or
 * conduct, because Chatroom is general-purpose and those belong in opt-in rule packs. Keep it
 * invariant so providers can cache it as a prompt prefix.
 */
const RADIUM_ORIENTATION = `You are running inside Radium, a self-hosted workspace where people talk with AI models.

# Radium
- Chatroom: this conversation. The user picks the model and the tools available to it. Replies render as Markdown, including KaTeX math between \`$$\` delimiters, CJK text, and Mermaid diagrams in \`mermaid\` code fences.
- Gateway: routes your requests to the providers and accounts configured for the workspace.
- Worker: a machine the user may connect. Tools named \`worker_*\` read, edit, and create files and run commands on it; changes can require the user's approval.

# Rules
- Paths outside the selected Worker directory are out of scope. Radium asks the user for permission before a tool reaches them; you do not need to ask yourself, and a denial means the user declined.
- Files or changes you did not make may be the user's work. Investigate before deleting or overwriting them.
- Read and change files with the \`worker_*\` file tools; use \`worker_bash\` for everything else, including command-line tools.
- Run independent tool calls in parallel.`;

/**
 * Build the Chatroom system prompt for one request: the invariant Radium orientation, then the
 * model's own identity. Pure and deterministic, so identical inputs keep the same cacheable text.
 */
export function chatSystemPrompt(model: ChatModelIdentity): string {
  const identity = [
    "# Model",
    `- Name: ${model.name ?? model.slug}`,
    ...(model.author ? [`- Author: ${model.author}`] : []),
    `- Slug: ${model.slug}`,
  ].join("\n");

  // Sections still to come, ordered from most to least stable so the cacheable prefix stays long:
  // - Rule packs: opt-in conduct rules in the style of Oh-My-Pi (e.g. `ts-no-tiny-functions`),
  //   enabled per workspace or chat. Insert after RADIUM_ORIENTATION; its `# Rules` are the
  //   always-on permission boundaries and stay there.
  // - Project instructions: the Project's AGENTS.md read through the Worker, when a Project and
  //   Worker are selected. Insert after rule packs.
  // - Code Mode: the `execute` tool's catalog (see docs/research/OpenCode_Code_Mode.md), which
  //   changes with the enabled tools. Insert after project instructions; the `execute` tool
  //   description itself stays invariant.
  return [RADIUM_ORIENTATION, identity].join("\n\n");
}
