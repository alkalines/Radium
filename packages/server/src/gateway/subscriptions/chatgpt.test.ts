import * as LoginWithChatGPT from "@opencoredev/loginwithchatgpt-server";
import { createChatGPTHandler } from "@opencoredev/loginwithchatgpt-server";
import { OPENAI_CODEX_SLUG } from "contracts/provider_slugs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime, TEST_SITE_URL, type TestRuntime } from "../../../test/runtime";
import { classicUser } from "../../../test/users";
import { workspaceMembers, workspaces } from "../../workspaces/schema";
import { workspaceCredentials, workspaceProviders } from "../schema";
import { CHATGPT_SUBSCRIPTION_PATH } from "./chatgpt";

// `/api/subscription/chatgpt-subscription/*` through the Hono app: session and owned-workspace
// boundaries, then the binding behavior ported from `src/subscriptions/chatgpt.test.ts`. The
// Login with ChatGPT library runs for real unless a test replaces its handler (it would call
// OpenAI for device login).

const library = vi.hoisted(() => ({ override: undefined as undefined | Record<string, unknown> }));

vi.mock("@opencoredev/loginwithchatgpt-server", async (importOriginal) => {
  const actual = await importOriginal<typeof LoginWithChatGPT>();
  return {
    ...actual,
    createChatGPTHandler: vi.fn((options: LoginWithChatGPT.CreateChatGPTHandlerOptions) =>
      library.override
        ? { ...actual.createChatGPTHandler(options), ...library.override }
        : actual.createChatGPTHandler(options),
    ),
  };
});

let test: TestRuntime;
let owner: { id: string; headers: Headers };
let member: { id: string; headers: Headers };
let workspace = "";
let archived = "";

const COOKIE = "lwc_chatgpt_subscription=session-cookie.signature";

function request(path: string, init: { method?: string; headers?: Headers; cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `${headers.get("cookie")}; ${init.cookie}`);
  return test.app.request(`${CHATGPT_SUBSCRIPTION_PATH}${path}`, {
    method: init.method ?? "GET",
    headers,
  });
}

async function codexCredentials() {
  return await test.runtime.drivers.db
    .select()
    .from(workspaceCredentials)
    .where(
      and(
        eq(workspaceCredentials.workspace, workspace),
        eq(workspaceCredentials.provider, OPENAI_CODEX_SLUG),
      ),
    );
}

beforeAll(async () => {
  test = await createTestRuntime({ env: { LWC_SECRET: "test-lwc-secret-of-enough-length" } });
  owner = await classicUser(test.runtime, "chatgpt-owner@example.test");
  member = await classicUser(test.runtime, "chatgpt-member@example.test");
  const { db } = test.runtime.drivers;
  [workspace, archived] = await Promise.all(
    [null, new Date()].map(async (archivedAt) => {
      const [row] = await db
        .insert(workspaces)
        .values({ ownerId: owner.id, name: "ChatGPT", archivedAt })
        .returning();
      await db.insert(workspaceMembers).values({ workspace: row!.id, userId: member.id, role: "member" });
      return row!.id;
    }),
  ) as [string, string];
  await db.insert(workspaceProviders).values({
    workspace,
    provider: OPENAI_CODEX_SLUG,
    enabled: true,
    active: true,
    snapshot: {
      slug: OPENAI_CODEX_SLUG,
      name: "ChatGPT",
      npm: "@opencoredev/loginwithchatgpt-ai",
      env: [],
      credential_type: "oauth",
      oauth_flow: "chatgpt-device",
      models: [],
    },
  });
});

beforeEach(() => {
  library.override = undefined;
  vi.mocked(createChatGPTHandler).mockClear();
});

afterAll(async () => {
  await test?.close();
});

describe("ChatGPT subscription routes", () => {
  it("refuses requests without a session, a workspace the caller owns, or an active workspace", async () => {
    const outsider = await classicUser(test.runtime, "chatgpt-outsider@example.test");
    const cases = [
      request(`/session?workspace=${workspace}`),
      request("/session", { headers: owner.headers }),
      request(`/session?workspace=${workspace}`, { headers: member.headers }),
      request(`/session?workspace=${workspace}`, { headers: outsider.headers }),
      request(`/session?workspace=${archived}`, { headers: owner.headers }),
    ];
    for (const response of await Promise.all(cases)) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    // Refused before the library ever saw the request.
    expect(createChatGPTHandler).not.toHaveBeenCalled();
  });

  it("serves the library's session state to the owner", async () => {
    const response = await request(`/session?workspace=${workspace}`, { headers: owner.headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "unauthenticated" });
    expect(createChatGPTHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: CHATGPT_SUBSCRIPTION_PATH,
        secret: "test-lwc-secret-of-enough-length",
        cookieName: "lwc_chatgpt_subscription",
        allowedOrigins: [TEST_SITE_URL],
      }),
    );
  });

  it("binds the session cookie after an authenticated status, and unbinds it on logout", async () => {
    library.override = {
      handler: vi.fn(async () =>
        Response.json({
          status: "authenticated",
          user: { accountId: "account-1", email: "chatgpt@example.test", plan: "plus" },
        }),
      ),
    };
    const status = await request(`/status?workspace=${workspace}`, {
      headers: owner.headers,
      cookie: COOKIE,
    });
    expect(status.status).toBe(200);
    expect(await codexCredentials()).toMatchObject([
      { account: "account-1", preview: { account: "chatgpt@example.test" } },
    ]);

    library.override = { handler: vi.fn(async () => Response.json({ status: "unauthenticated" })) };
    const logout = await request(`/logout?workspace=${workspace}`, {
      method: "POST",
      headers: owner.headers,
      cookie: COOKIE,
    });
    expect(logout.status).toBe(200);
    expect(await codexCredentials()).toEqual([]);
  });

  it("drops an authenticated session's cookie on a new login so it never replaces that account", async () => {
    for (const [status, forwardsCookie] of [
      ["authenticated", false],
      ["pending", true],
    ] as const) {
      const handler = vi.fn(async (_request: Request) => Response.json({ status: "pending", userCode: "ABCD" }));
      library.override = { handler, getSession: vi.fn(async () => ({ status })) };
      await request(`/login?workspace=${workspace}`, {
        method: "POST",
        headers: owner.headers,
        cookie: COOKIE,
      });
      const forwarded = handler.mock.calls[0]![0];
      expect(forwarded.headers.has("cookie")).toBe(forwardsCookie);
    }
    expect(await codexCredentials()).toEqual([]);
  });

  it("answers 503 when the subscription is not configured", async () => {
    const unconfigured = await createTestRuntime();
    try {
      const user = await classicUser(unconfigured.runtime, "chatgpt-unconfigured@example.test");
      const [row] = await unconfigured.runtime.drivers.db
        .insert(workspaces)
        .values({ ownerId: user.id, name: "Off" })
        .returning();
      const response = await unconfigured.app.request(
        `${CHATGPT_SUBSCRIPTION_PATH}/session?workspace=${row!.id}`,
        { headers: user.headers },
      );
      expect(response.status).toBe(503);
    } finally {
      await unconfigured.close();
    }
  });
});
