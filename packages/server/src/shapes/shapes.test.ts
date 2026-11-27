import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acpChat, acpUsers, acpWorkspace } from "../../test/acp";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { workerIssuerEnv } from "../../test/workers";
import { chats } from "../chatroom/schema";
import { workspaceMembers, workspaces } from "../workspaces/schema";

// The shape proxy's authorization and the exact shape it asks Electric for. Electric itself
// connects to one fixed database, while each test file runs on its own clone, so Electric is
// stood in for by a server that records the forwarded request; the live sync is checked against
// a real Electric in the browser (task 14, Phase 4 results).

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
let electric: ReturnType<typeof Bun.serve>;
let forwarded: URL[] = [];
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";

beforeAll(async () => {
  electric = Bun.serve({
    port: 0,
    fetch(request) {
      forwarded.push(new URL(request.url));
      return Response.json([], { headers: { "electric-handle": "h-1", "electric-offset": "0_0" } });
    },
  });
  test = await createTestRuntime({
    env: {
      ...(await workerIssuerEnv()).env,
      ELECTRIC_URL: `http://127.0.0.1:${electric.port}`,
      ELECTRIC_SECRET: "electric-secret",
    },
  });
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `shapes-${role}@example.test`);
  }
  const [row] = await test.runtime.drivers.db
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Shapes" })
    .returning();
  workspace = row!.id;
  await test.runtime.drivers.db.insert(workspaceMembers).values({ workspace, userId: users.member.id, role: "member" });
});

afterAll(async () => {
  await test?.close();
  electric?.stop(true);
});

/** Requests `collection` as `role` and returns the status and the request Electric received. */
async function shape(role: Role | null, collection: string, query = "") {
  forwarded = [];
  const headers = role ? users[role].headers : new Headers();
  const response = await test.app.request(`/api/shapes/${collection}?offset=-1${query}`, { headers });
  return { status: response.status, response, upstream: forwarded[0] };
}

describe("shape proxy", () => {
  it("sets the table, columns and where itself and forwards only protocol parameters", async () => {
    const { status, response, upstream } = await shape(
      "member",
      "notifications",
      "&table=user&where=true&params[1]=x&subset__where=1%3D1&columns=password&handle=h-1&live=true",
    );
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream!.pathname).toBe("/v1/shape");
    const query = Object.fromEntries(upstream!.searchParams);
    expect(query).toEqual({
      offset: "-1",
      handle: "h-1",
      live: "true",
      table: "notifications",
      columns: expect.not.stringContaining("password"),
      where: "user_id = $1",
      "params[1]": users.member.id,
      secret: "electric-secret",
    });
  });

  it("checks workspace access, hides owner-only columns and folders from members", async () => {
    const owner = await shape("owner", "workspaceSettings", `&workspace=${workspace}`);
    const member = await shape("member", "workspaceSettings", `&workspace=${workspace}`);
    expect(owner.upstream!.searchParams.get("columns")).toContain("routing");
    expect(member.upstream!.searchParams.get("columns")).not.toMatch(/routing|limits|telemetry/);
    expect(member.upstream!.searchParams.get("params[1]")).toBe(workspace);

    expect((await shape("outsider", "workspaceSettings", `&workspace=${workspace}`)).status).toBe(404);
    expect((await shape("outsider", "projects", `&workspace=${workspace}`)).upstream).toBeUndefined();
    expect((await shape("member", "projects", `&workspace=${workspace}`)).status).toBe(200);
    expect((await shape("member", "projectFolders", `&workspace=${workspace}`)).status).toBe(404);
    expect((await shape("owner", "projectFolders", `&workspace=${workspace}`)).status).toBe(200);
  });

  it("keeps an ACP session of a personal chat to its creator, the owner included", async () => {
    const acp = await acpUsers(test.runtime, "shapes-acp");
    const fixture = await acpWorkspace(test.runtime, acp);
    const { chat } = await acpChat(test.runtime, acp, fixture, "member");
    const request = (role: keyof typeof acp) =>
      test.app.request(`/api/shapes/acpSession?offset=-1&chat=${chat}`, { headers: acp[role].headers });
    forwarded = [];
    expect((await request("member")).status).toBe(200);
    expect(forwarded[0]!.searchParams.get("where")).toBe("chat = $1");
    expect(forwarded[0]!.searchParams.get("params[1]")).toBe(chat);
    expect((await request("owner")).status).toBe(404);
    expect((await request("other")).status).toBe(404);

    // A plain chat has no ACP session shape; unknown collections and no session are refused.
    const [plain] = await test.runtime.drivers.db
      .insert(chats)
      .values({ workspace, userId: users.member.id, scope: "personal" })
      .returning();
    expect((await shape("member", "acpSession", `&chat=${plain!.id}`)).status).toBe(404);
    expect((await shape(null, "notifications")).status).toBe(401);
    expect((await shape("member", "user")).status).toBe(404);
  });
});

describe("without Electric", () => {
  it("answers 404", async () => {
    const plain = await createTestRuntime();
    try {
      const user = await classicUser(plain.runtime, "shapes-plain@example.test");
      expect((await plain.app.request("/api/shapes/notifications", { headers: user.headers })).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
