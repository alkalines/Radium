/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import { register } from "worker-component/test";
import { api, components, internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";

const authMock = vi.hoisted(() => {
  const getAuthUser = async (ctx: QueryCtx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.kind === "worker") return null;
    return {
      _id: identity.subject,
      email: `${identity.subject}@example.invalid`,
      name: identity.subject,
    };
  };
  return {
    getAuthUser: async (ctx: QueryCtx) => {
      const user = await getAuthUser(ctx);
      if (!user) throw new Error("Not logged in");
      return user;
    },
    safeGetAuthUser: getAuthUser,
  };
});

vi.mock("./auth", () => ({ authComponent: authMock, createAuth: vi.fn() }));

const modules = import.meta.glob("./**/*.ts");
const BACKEND = "https://backend.example.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv("CONVEX_SITE_URL", BACKEND);
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Maintenance" }),
  );

  // Real identity persistence without the HTTP proof exchange (covered by workers.test.ts).
  const tokenHash = await tokenDigest("maintenance-worker".padEnd(43, "_"));
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicKey = await normalizeWorkerKey(await exportJWK(pair.publicKey));
  await t.run((ctx) =>
    ctx.runMutation(components.workerIdentity.enrollment.createEnrollment, {
      workspaceId: workspace,
      name: tokenHash,
      tokenHash,
      expiresAt: Date.now() + 60_000,
      capabilities: [],
    }),
  );
  const identity = await t.run((ctx) =>
    ctx.runMutation(components.workerIdentity.enrollment.completeEnrollment, {
      workspaceId: workspace,
      tokenHash,
      requestId: tokenHash,
      publicKey,
    }),
  );
  const machine = t.withIdentity({
    ...identity,
    subject: identity.workerId,
    kind: "worker",
    issuer: workerIssuer(BACKEND),
  });
  const owner = t.withIdentity({ subject: "owner" });

  // One expired proof context gives the cleanup cron something to delete.
  await t.run((ctx) =>
    ctx.db.insert("worker_auth_challenges", {
      kind: "token",
      workspace,
      workerId: identity.workerId,
      publicKey,
      expiresAt: Date.now() - 1,
    }),
  );

  return { t, owner, machine, workspace };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pin(f: Fixture) {
  return f.owner.mutation(api.preferences.setModelPinned, { model: "a/model", pinned: true });
}

function createProject(f: Fixture) {
  return f.owner.mutation(api.projects.create, { workspace: f.workspace, name: "Project" });
}

function heartbeat(f: Fixture) {
  return f.machine.mutation(api.workers.reportPresence, { tempDirectory: "/tmp/radium" });
}

async function expectMaintenance(call: Promise<unknown>) {
  const error = await call.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as ConvexError<{ code: string }>).data.code).toBe("MAINTENANCE");
}

describe("maintenance mode", () => {
  test("off: public, workspace and Worker mutations write", async () => {
    const f = await fixture();

    await pin(f);
    await createProject(f);
    await heartbeat(f);

    expect(await f.owner.query(api.preferences.get, {})).toMatchObject({
      pinnedModels: ["a/model"],
    });
    expect(await f.t.run((ctx) => ctx.db.query("projects").collect())).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("worker_presence").collect())).toHaveLength(1);
  });

  test("on: browser and Worker writes are refused with no effect; internal mutations run", async () => {
    const f = await fixture();
    vi.stubEnv("RADIUM_MAINTENANCE", "1");

    await expectMaintenance(pin(f));
    await expectMaintenance(createProject(f));
    await expectMaintenance(heartbeat(f));

    // Reads stay open.
    expect(await f.owner.query(api.preferences.get, {})).toEqual({
      pinnedModels: [],
      hiddenModels: [],
    });
    expect(await f.t.run((ctx) => ctx.db.query("projects").collect())).toHaveLength(0);
    expect(await f.t.run((ctx) => ctx.db.query("worker_presence").collect())).toHaveLength(0);

    expect(await f.t.mutation(internal.workers.pruneChallenges, {})).toBe(1);
  });

  test("drain: browser writes are refused while Workers keep writing", async () => {
    const f = await fixture();
    vi.stubEnv("RADIUM_MAINTENANCE", "drain");

    await expectMaintenance(pin(f));
    await expectMaintenance(createProject(f));
    await heartbeat(f);

    expect(await f.t.run((ctx) => ctx.db.query("worker_presence").collect())).toHaveLength(1);
  });

  test("an unrecognized value closes Worker writes too", async () => {
    const f = await fixture();
    vi.stubEnv("RADIUM_MAINTENANCE", "yes");

    await expectMaintenance(heartbeat(f));
  });
});
