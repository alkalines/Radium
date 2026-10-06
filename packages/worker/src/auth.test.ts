import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJWK, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMachineTokenFetcher, recoverPendingIdentity, setupWorker } from "./auth.js";
import { readSetupCodeFromFile } from "./input.js";
import {
  parseSetupCode,
  postJson,
  WorkerProtocolError,
  type WorkerIdentity,
  type WorkerFetch,
  type WorkerSetup,
} from "./protocol.js";
import {
  createPendingState,
  readWorkerState,
  saveWorkerIdentity,
  type WorkerState,
} from "./state.js";

const directories: string[] = [];
const proofType = "radium-worker-proof+jwt";

beforeEach(() => {
  vi.stubEnv("RADIUM_WORKER_CREDENTIAL_STORE", "file");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Worker machine authentication", () => {
  it("validates the fixed setup-code format and network origins", () => {
    const now = 2_000_000_000_000;
    const setup = makeSetup(now);
    expect(parseSetupCode(encodeSetup(setup), now)).toEqual(setup);
    expect(() =>
      parseSetupCode(encodeSetup({ ...setup, backendUrl: "http://example.test" }), now),
    ).toThrow(WorkerProtocolError);
    expect(() =>
      parseSetupCode(encodeSetup({ ...setup, convexUrl: "https://example.test/path" }), now),
    ).toThrow(WorkerProtocolError);
    expect(() => parseSetupCode("radium-worker-v1.not-base64!", now)).toThrow(WorkerProtocolError);
  });

  it("persists the key before networking and enrolls only after trying recovery", async () => {
    const now = 2_000_000_000_000;
    const directory = await newStateDirectory();
    const setup = makeSetup(now);
    const code = encodeSetup(setup);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const challenges = new Map<string, string>();
    const responseAudience = setup.backendUrl;
    let stateBeforeNetwork: Awaited<ReturnType<typeof readWorkerState>> = null;
    let observedStateText = "";

    const fetchImpl: WorkerFetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      expect(init?.redirect).toBe("error");

      if (url.pathname.endsWith("/challenge")) {
        if (!stateBeforeNetwork) {
          stateBeforeNetwork = await readWorkerState(directory);
          observedStateText = await readFile(join(directory, "worker-state.json"), "utf8");
        }
        const id = `challenge-${challenges.size + 1}`;
        challenges.set(id, String(body.kind));
        return jsonResponse({
          challengeId: id,
          expiresAt: now + 60_000,
          audience: responseAudience,
        });
      }

      const challengeId = String(body.challengeId);
      const kind = challenges.get(challengeId);
      expect(kind).toBeDefined();
      await verifyProof(
        String(body.proof),
        stateBeforeNetwork as unknown as WorkerState,
        challengeId,
        responseAudience,
        now,
      );
      if (kind === "recover") return jsonResponse({ error: "WORKER_AUTH_DENIED" }, 401);
      expect(body.token).toBe(setup.token);
      return jsonResponse(identity);
    };

    const result = await setupWorker(directory, code, { fetchImpl, now: () => now });
    const saved = await readWorkerState(directory);
    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(join(directory, "worker-state.json"))).mode & 0o777;

    const observedPendingState = stateBeforeNetwork as unknown as WorkerState | null;
    expect(observedPendingState).not.toBeNull();
    expect(observedPendingState?.identity).toBeUndefined();
    expect(observedStateText).not.toContain(setup.token);
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(requests.map(({ body }) => body.kind ?? "complete")).toEqual([
      "recover",
      "complete",
      "enroll",
      "complete",
    ]);
    expect(requests[1]?.body).not.toHaveProperty("token");
    expect(requests[3]?.body.token).toBe(setup.token);
    expect(result).toEqual(identity);
    expect(saved?.identity).toEqual(identity);
    expect(JSON.stringify(saved)).not.toContain(setup.token);
  });

  it("recovers a lost enrollment response after the setup code expires", async () => {
    const initialNow = 2_000_000_000_000;
    const directory = await newStateDirectory();
    const setup = makeSetup(initialNow, initialNow + 10_000);
    let registeredIdentity: WorkerIdentity | undefined;
    let requestId: string | undefined;
    let publicKey: unknown;
    let now = initialNow;

    const firstFetch: WorkerFetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname.endsWith("/challenge")) {
        if (body.kind === "recover") requestId = String(body.requestId);
        publicKey = body.publicKey;
        const id = `first-${String(body.kind)}`;
        return jsonResponse({
          challengeId: id,
          expiresAt: now + 60_000,
          audience: setup.backendUrl,
        });
      }
      if (body.challengeId === "first-recover") {
        return jsonResponse({ error: "WORKER_AUTH_DENIED" }, 401);
      }
      registeredIdentity = identity;
      throw new TypeError("simulated lost completion response");
    };

    await expect(
      setupWorker(directory, encodeSetup(setup), { fetchImpl: firstFetch, now: () => now }),
    ).rejects.toThrow(WorkerProtocolError);
    const pending = await readWorkerState(directory);
    expect(pending?.identity).toBeUndefined();
    expect(pending?.requestId).toBe(requestId);
    expect(pending?.publicKey).toEqual(publicKey);

    now = setup.expiresAt + 1;
    const recoveryRequests: Array<Record<string, unknown>> = [];
    const restartFetch: WorkerFetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      recoveryRequests.push(body);
      if (url.pathname.endsWith("/challenge")) {
        expect(body.kind).toBe("recover");
        expect(body.requestId).toBe(requestId);
        expect(body.publicKey).toEqual(publicKey);
        return jsonResponse({
          challengeId: "restart-recover",
          expiresAt: now + 60_000,
          audience: setup.backendUrl,
        });
      }
      expect(body).not.toHaveProperty("token");
      return jsonResponse(registeredIdentity);
    };

    const recovered = await recoverPendingIdentity(directory, pending!, {
      fetchImpl: restartFetch,
      now: () => now,
    });
    expect(recoveryRequests).toHaveLength(2);
    expect(recovered.identity).toEqual(identity);
    expect(JSON.stringify(recovered)).not.toContain(setup.token);
  });

  it("deduplicates concurrent token refreshes and never returns an expired token", async () => {
    const initialNow = 2_000_000_000_000;
    const directory = await newStateDirectory();
    let now = initialNow;
    const pending = await createPendingState(directory, makeSetup(initialNow));
    const state = await saveWorkerIdentity(directory, pending, identity);
    let challengeCount = 0;
    let completeCount = 0;
    const fetchImpl: WorkerFetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname.endsWith("/challenge")) {
        challengeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse({
          challengeId: `token-challenge-${challengeCount}`,
          expiresAt: now + 60_000,
          audience: state.setup.backendUrl,
        });
      }
      completeCount += 1;
      const token = completeCount === 1 ? "machine-token" : "expired-machine-token";
      const expiresAt = completeCount === 1 ? now + 1_000 : now;
      expect(body).not.toHaveProperty("token");
      return jsonResponse({ token, expiresAt });
    };

    const fetchToken = createMachineTokenFetcher(state, { fetchImpl, now: () => now });
    const [first, concurrent] = await Promise.all([
      fetchToken({ forceRefreshToken: true }),
      fetchToken({ forceRefreshToken: true }),
    ]);
    expect(first).toBe("machine-token");
    expect(concurrent).toBe(first);
    expect(challengeCount).toBe(1);
    expect(completeCount).toBe(1);

    now += 1_001;
    expect(await fetchToken({ forceRefreshToken: false })).toBeNull();
    expect(challengeCount).toBe(2);
    expect(completeCount).toBe(2);
  });

  it("accepts only a protected setup file", async () => {
    const directory = await newStateDirectory();
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "setup-code");
    await writeFile(path, "radium-worker-v1.test", { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(readSetupCodeFromFile(path)).rejects.toThrow("mode 0600");
  });

  it("does not replace a completed identity", async () => {
    const now = 2_000_000_000_000;
    const directory = await newStateDirectory();
    const setup = makeSetup(now);
    const pending = await createPendingState(directory, setup);
    const completed = await saveWorkerIdentity(directory, pending, identity);
    const fetchImpl: WorkerFetch = async () => {
      throw new Error("network must not be reached");
    };

    await expect(
      setupWorker(directory, encodeSetup(setup), { fetchImpl, now: () => now }),
    ).rejects.toThrow("already has an identity");
    const after = await readWorkerState(directory);
    expect(after?.requestId).toBe(completed.requestId);
    expect(after?.privateKey).toEqual(completed.privateKey);
    expect(after?.identity).toEqual(identity);
  });

  it("bounds authentication response bodies", async () => {
    const fetchImpl: WorkerFetch = async () => new Response(new Uint8Array(32 * 1024 + 1));
    await expect(
      postJson("https://radium.example/api/worker/auth/challenge", {}, { fetchImpl }),
    ).rejects.toThrow("response is too large");
  });

});

async function verifyProof(
  proof: string,
  state: NonNullable<Awaited<ReturnType<typeof readWorkerState>>>,
  challengeId: string,
  audience: string,
  now: number,
): Promise<void> {
  const { payload, protectedHeader } = await jwtVerify(
    proof,
    await importJWK(state.publicKey, "ES256"),
    {
      algorithms: ["ES256"],
      audience,
      currentDate: new Date(now),
    },
  );
  expect(protectedHeader.typ).toBe(proofType);
  expect(payload).toMatchObject({ challengeId, aud: audience, iat: Math.floor(now / 1000) });
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
}

function makeSetup(now: number, expiresAt = now + 600_000): WorkerSetup {
  return {
    version: 1,
    backendUrl: "https://radium.example.convex.site",
    convexUrl: "https://radium.example.convex.cloud",
    enrollmentId: "opaque-enrollment-selector",
    token: Buffer.alloc(32, 7).toString("base64url"),
    expiresAt,
  };
}

function encodeSetup(setup: WorkerSetup): string {
  return `radium-worker-v1.${Buffer.from(JSON.stringify(setup), "utf8").toString("base64url")}`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function newStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "radium-worker-test-"));
  directories.push(directory);
  return join(directory, "state");
}

const identity: WorkerIdentity = {
  workerId: "worker-id",
  keyId: "key-id",
  workspaceId: "workspace-id",
  identityEpoch: 1,
};
