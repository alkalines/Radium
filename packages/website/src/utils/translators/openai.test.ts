import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamCompletion } from "./openai";

test("settles streaming billing once when aborted after provider dispatch", async () => {
  let resolveDispatch!: () => void;
  const providerDispatched = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  const requestController = new AbortController();
  let billingMutationCalls = 0;
  let resolveBilling!: () => void;
  const billingMutation = new Promise<void>((resolve) => {
    resolveBilling = resolve;
  });

  const model = {
    specificationVersion: "v4" as const,
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unused");
    },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      const stream = new ReadableStream({
        start(controller) {
          const abort = () => controller.error(abortSignal?.reason);
          abortSignal?.addEventListener("abort", abort, { once: true });
        },
      });
      resolveDispatch();
      return { stream };
    },
  };
  const provider = {
    connector: () => model,
    info: { modelId: "test-model" },
  } as any;

  const output = await StreamCompletion(
    {
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: true,
    },
    provider,
    async () => {
      billingMutationCalls += 1;
      resolveBilling();
    },
    undefined,
    requestController.signal,
  );

  const reader = output.getReader();
  await providerDispatched;
  requestController.abort();
  await reader.cancel();
  await billingMutation;

  assert.equal(billingMutationCalls, 1);
});
