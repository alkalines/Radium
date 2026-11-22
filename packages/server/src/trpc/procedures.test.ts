import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { WORKER_AUDIENCE, workerIssuer } from "../worker/auth";
import { workerKeys, workers } from "../worker/schema";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { ownedWorkspaceProcedure, router, workerProcedure, workspaceProcedure } from "./init";

// Authorization boundaries of the base procedures: owner, member, outsider, archived workspace,
// and Worker tokens that are valid, revoked, re-scoped or expired.

const probe = router({
  workspace: workspaceProcedure.query(({ ctx }) => ctx.access.role),
  owned: ownedWorkspaceProcedure.query(({ ctx }) => ctx.access.workspace.id),
  worker: workerProcedure.query(({ ctx }) => ctx.worker),
});

const issuerKeys = await generateKeyPair("ES256", { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), kid: "issuer-1", alg: "ES256" };

let test: TestRuntime;
const ids = {
  owner: "",
  member: "",
  outsider: "",
  workspace: "",
  archived: "",
  worker: "",
  key: "",
};

function caller(headers: Headers) {
  return probe.createCaller({ runtime: test.runtime, headers });
}

async function workerToken(claims: Record<string, unknown>, expiresIn = "5m") {
  return await new SignJWT({
    kind: "worker",
    workspaceId: ids.workspace,
    keyId: ids.key,
    identityEpoch: 0,
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "issuer-1" })
    .setIssuer(workerIssuer("http://localhost:3100"))
    .setAudience(WORKER_AUDIENCE)
    .setSubject(ids.worker)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(issuerKeys.privateKey);
}

const headers: Record<"owner" | "member" | "outsider", Headers> = {
  owner: new Headers(),
  member: new Headers(),
  outsider: new Headers(),
};

beforeAll(async () => {
  test = await createTestRuntime({
    env: { WORKER_AUTH_JWKS: JSON.stringify({ keys: [issuerJwk] }) },
  });
  const { db } = test.runtime.drivers;

  for (const role of ["owner", "member", "outsider"] as const) {
    const signedIn = await classicUser(test.runtime, `${role}@example.test`);
    ids[role] = signedIn.id;
    headers[role] = signedIn.headers;
  }

  const [workspace] = await db
    .insert(workspaces)
    .values({ ownerId: ids.owner, name: "Team" })
    .returning();
  const [archived] = await db
    .insert(workspaces)
    .values({ ownerId: ids.owner, name: "Old", archivedAt: new Date() })
    .returning();
  ids.workspace = workspace!.id;
  ids.archived = archived!.id;
  await db.insert(workspaceMembers).values([
    { workspace: ids.workspace, userId: ids.member, role: "member" },
    { workspace: ids.archived, userId: ids.member, role: "member" },
  ]);

  const [worker] = await db
    .insert(workers)
    .values({
      workspace: ids.workspace,
      name: "laptop",
      capabilities: [],
      status: "active",
      identityEpoch: 0,
    })
    .returning();
  const [key] = await db
    .insert(workerKeys)
    .values({ worker: worker!.id, algorithm: "ES256", material: "{}", thumbprint: "thumb" })
    .returning();
  ids.worker = worker!.id;
  ids.key = key!.id;
});

afterAll(async () => {
  await test?.close();
});

describe("workspaceProcedure", () => {
  it("admits the owner and a direct member with their role", async () => {
    expect(await caller(headers.owner).workspace({ workspace: ids.workspace })).toBe("owner");
    expect(await caller(headers.member).workspace({ workspace: ids.workspace })).toBe("member");
  });

  it("answers outsiders, archived and unknown workspaces with the same NOT_FOUND", async () => {
    for (const [who, workspace] of [
      ["outsider", ids.workspace],
      ["member", ids.archived],
      ["owner", ids.archived],
      ["owner", "no-such-workspace"],
    ] as const) {
      await expect(caller(headers[who]).workspace({ workspace })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("requires a session", async () => {
    await expect(
      caller(new Headers()).workspace({ workspace: ids.workspace }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("ownedWorkspaceProcedure", () => {
  it("admits only the owner", async () => {
    expect(await caller(headers.owner).owned({ workspace: ids.workspace })).toBe(ids.workspace);
    await expect(caller(headers.member).owned({ workspace: ids.workspace })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("workerProcedure", () => {
  const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

  it("resolves a valid token to the Worker's current scope", async () => {
    expect(await caller(bearer(await workerToken({}))).worker()).toEqual({
      workerId: ids.worker,
      keyId: ids.key,
      workspaceId: ids.workspace,
      identityEpoch: 0,
    });
  });

  it("refuses tokens for another workspace, a stale epoch or past expiry", async () => {
    const otherWorkspace = await workerToken({ workspaceId: ids.archived });
    const staleEpoch = await workerToken({ identityEpoch: 1 });
    const expired = await workerToken({}, "-1m");
    for (const token of [otherWorkspace, staleEpoch, expired, "not-a-jwt"]) {
      await expect(caller(bearer(token)).worker()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("refuses a still-valid token once the Worker is revoked", async () => {
    const token = await workerToken({});
    await test.runtime.drivers.db
      .update(workers)
      .set({ status: "revoked", identityEpoch: 1 })
      .where(eq(workers.id, ids.worker));
    await expect(caller(bearer(token)).worker()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
