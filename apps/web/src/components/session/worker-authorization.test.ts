import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Id } from "backend/convex/_generated/dataModel";
import type { ChatWorkerSelection } from "backend/src/worker/chat-config";
import { WORKER_GRANT_TTL_MS } from "backend/src/worker/task-contract";
import {
  forgetWorkerApproval,
  recordWorkerApproval,
  workerGrantAction,
  type WorkerAuthorizationTarget,
} from "./worker-authorization";

const target: WorkerAuthorizationTarget = {
  workspaceId: "ws" as Id<"workspaces">,
  chatId: "chat" as Id<"aisdk_chats">,
  workerId: "worker",
  directory: "/srv/project",
  e2eeId: null,
};
const now = 10 * WORKER_GRANT_TTL_MS;
const served = (grantAge?: number): ChatWorkerSelection => ({
  workerId: target.workerId,
  directory: target.directory,
  tools: ["read", "edit"],
  ...(grantAge === undefined
    ? {}
    : {
        grant: {
          tools: ["read"],
          issuedAt: now - grantAge,
          signature: new ArrayBuffer(64),
          signerKeyId: "key",
        },
      }),
});
const action = (selection: ChatWorkerSelection, at = target) =>
  workerGrantAction({ userId: "me", signerKeyId: "key", target: at, selection, now });

describe("Worker grant signing", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => void values.set(name, value),
        removeItem: (name: string) => void values.delete(name),
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("a server-chosen selection is never signed without the user", () => {
    expect(action(served())).toBe("confirm");
    expect(action(served(WORKER_GRANT_TTL_MS))).toBe("confirm");
    // Another device's fresh grant needs nothing from this one.
    expect(action(served(0))).toBe("none");
  });

  test("only the exact confirmed selection is re-signed, before expiry", () => {
    recordWorkerApproval("me", target, ["read", "edit"]);
    expect(action(served(0))).toBe("none");
    expect(action(served(WORKER_GRANT_TTL_MS / 2))).toBe("sign");
    expect(action(served())).toBe("sign");
    // Another Worker, directory or tool set than confirmed needs a new confirmation.
    expect(action(served(), { ...target, workerId: "other" })).toBe("confirm");
    expect(action(served(), { ...target, directory: "/" })).toBe("confirm");
    expect(action({ ...served(), tools: ["read", "bash"] })).toBe("confirm");
  });

  test("a new pick drops the approval, so its server-derived directory is confirmed again", () => {
    recordWorkerApproval("me", target, ["read", "edit"]);
    forgetWorkerApproval("me", target.workspaceId, target.chatId);
    // Neither the server reverting to the earlier selection nor a new directory is signed alone.
    expect(action(served())).toBe("confirm");
    expect(action(served(), { ...target, directory: "/elsewhere" })).toBe("confirm");
  });
});
