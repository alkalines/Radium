import type { ProviderRouting, RoutingSettings } from "contracts/routing/settings";
import { DEFAULT_ROUTING_SETTINGS } from "contracts/routing/settings";
import type { ProviderSnapshot } from "contracts/workspaces/provider";
import { eq } from "drizzle-orm";
import { authors, models, workspaceCredentials, workspaceProviders } from "../src/gateway/schema";
import { putSecret, workspaceProviderSecretNamespace } from "../src/gateway/secrets";
import type { Runtime } from "../src/runtime";
import { updateWorkspaceSettings } from "../src/workspaces/settings";

/** The upstream base URL every fixture provider points at; tests stub `runtime.fetch`. */
export const UPSTREAM = "https://upstream.example.test/v1";

/** A global model (and its author) in the catalogue; returns its slug. */
export async function addModel(runtime: Runtime, slug: string) {
  const { db } = runtime.drivers;
  await db.insert(authors).values({ name: "Test", slug: "test" }).onConflictDoNothing();
  const [author] = await db.select().from(authors).where(eq(authors.slug, "test"));
  await db
    .insert(models)
    .values({
      name: slug,
      slug,
      launchDate: new Date(0),
      author: author!.id,
      type: "chat",
      description: `${slug} model`,
      reasoning: false,
      architecture: { input_modalities: ["text"], output_modalities: ["text"], tokenizer: "GPT" },
    })
    .onConflictDoNothing();
  return slug;
}

/** A provider offer of `model` with per-token prices. */
export function offer(model: string, extra: Partial<ProviderSnapshot["models"][number]> = {}) {
  return {
    model,
    context: 4096,
    max_output: 1024,
    pricing: { input: "0.000001", output: "0.000002" },
    supported_parameters: ["tools" as const],
    moderated: false,
    ...extra,
  };
}

/**
 * A configured provider of `workspace` (OpenAI-compatible at {@link UPSTREAM} unless overridden)
 * offering `models`, with `credentials` API keys stored like `providers.createCredential` does.
 * Returns the credential ids in creation order.
 */
export async function addProvider(
  runtime: Runtime,
  workspace: string,
  provider: {
    slug: string;
    models?: ProviderSnapshot["models"];
    snapshot?: Partial<ProviderSnapshot>;
    routing?: Partial<ProviderRouting>;
    credentials?: number;
  },
) {
  const { db } = runtime.drivers;
  await db.insert(workspaceProviders).values({
    workspace,
    provider: provider.slug,
    enabled: true,
    active: true,
    snapshot: {
      slug: provider.slug,
      name: provider.slug,
      npm: "@ai-sdk/openai-compatible",
      env: ["API_KEY"],
      api: UPSTREAM,
      models: provider.models ?? [],
      ...provider.snapshot,
    },
    routing: provider.routing
      ? {
          priority: 0,
          weight: 1,
          disableCooling: false,
          modelLevelCooling: false,
          errorRules: [],
          ...provider.routing,
        }
      : null,
  });
  const ids: string[] = [];
  for (let index = 0; index < (provider.credentials ?? 1); index++) {
    const id = crypto.randomUUID();
    await db.insert(workspaceCredentials).values({
      id,
      workspace,
      provider: provider.slug,
      preview: { API_KEY: `****${index}` },
      secretName: id,
    });
    await putSecret(
      db,
      runtime.secrets,
      { namespace: workspaceProviderSecretNamespace(workspace, provider.slug), name: id },
      JSON.stringify({ API_KEY: `${provider.slug}-key-${index}` }),
    );
    ids.push(id);
  }
  return ids;
}

/** Sets the workspace routing settings over the defaults. */
export async function setRouting(runtime: Runtime, workspace: string, change: Partial<RoutingSettings>) {
  await updateWorkspaceSettings(runtime.drivers.db, workspace, {
    routing: { ...DEFAULT_ROUTING_SETTINGS, ...change },
  });
}

/**
 * An OpenAI chat-completions SSE body (what `@ai-sdk/openai-compatible` reads upstream) with one
 * chunk per text piece, a finish reason and usage.
 */
export function upstreamStream(pieces: string[], usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id: "upstream-generation",
      object: "chat.completion.chunk",
      created: 1,
      model: "upstream-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  const body = [
    ...pieces.map((piece, index) => chunk(index === 0 ? { role: "assistant", content: piece } : { content: piece })),
    chunk({}, "stop", { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** An upstream error response in the OpenAI error shape. */
export function upstreamError(status: number, message = `Upstream ${status}`, code?: string) {
  return Response.json(
    { error: { message, type: code ?? "upstream_error", code: code ?? status } },
    { status },
  );
}
