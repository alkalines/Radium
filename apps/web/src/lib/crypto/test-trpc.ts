import { spyOn } from "bun:test";
import * as trpcClientModule from "@/lib/trpc-client";

/** One recorded call: the procedure path (`e2ee.chatKeys`) and its input. */
export type FakeCall = { path: string; input: unknown };

/**
 * Replaces the browser's tRPC client for the current test: `client.<router>.<procedure>.query(input)`
 * and `.mutate(input)` are served from `handlers`, keyed by the dotted procedure path. A procedure
 * without a handler fails the test with its name. Returns the calls made, in order. Undone by
 * `mock.restore()`; installing again replaces the handlers.
 */
export function installFakeTrpc(
  // Each handler annotates its own input; the helper cannot know it, so `never` accepts any.
  handlers: Record<string, (input: never) => unknown>,
): FakeCall[] {
  const calls: FakeCall[] = [];
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get(_, key) {
        if (key === "query" || key === "mutate") {
          return async (input?: unknown) => {
            const name = path.join(".");
            calls.push({ path: name, input });
            const handler = handlers[name];
            if (!handler) throw new Error(`Unexpected tRPC call ${name}`);
            // The caller's handler declares the input shape this call is meant to carry.
            return handler(input as never);
          };
        }
        return node([...path, String(key)]);
      },
    });
  spyOn(trpcClientModule, "trpcClient").mockReturnValue(node([]) as never);
  return calls;
}
