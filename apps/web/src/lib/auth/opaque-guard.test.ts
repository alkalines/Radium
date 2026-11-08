import { describe, expect, test } from "bun:test";

import { checkChallengeResponse, KEY_STRETCHING_REJECTED } from "./opaque-guard";

const base = "https://convex.example/api/auth";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OPAQUE key-stretching guard", () => {
  test("passes the pinned profile through", async () => {
    const response = json({ keyStretching: "rfc-recommended", loginResponse: "x", stateId: "s" });
    expect(
      await checkChallengeResponse(`${base}/sign-in/opaque/challenge`, response),
    ).toBeUndefined();
  });

  test("rejects weaker, abusive or missing profiles on every challenge", async () => {
    const custom = { "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 } };
    const huge = { "argon2id-custom": { iterations: 1e9, memory: 2 ** 31, parallelism: 1 } };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/sign-up/opaque/challenge", { keyStretching: custom }],
      ["/sign-in/opaque/challenge", { keyStretching: huge }],
      ["/sign-in/opaque/challenge", { keyStretching: "memory-constrained" }],
      ["/opaque/password-proof/challenge", {}],
      ["/reset/opaque/challenge", { keyStretching: "rfc-draft-recommended" }],
      [
        "/opaque/change-password/challenge",
        { keyStretching: "rfc-recommended", loginKeyStretching: huge },
      ],
    ];

    for (const [path, body] of cases) {
      const replaced = await checkChallengeResponse(`${base}${path}`, json(body));
      expect(replaced?.ok).toBe(false);
      expect(await replaced?.json()).toMatchObject({ code: KEY_STRETCHING_REJECTED });
    }
  });

  test("leaves other endpoints and error responses alone", async () => {
    const other = json({ keyStretching: "memory-constrained" });
    expect(await checkChallengeResponse(`${base}/sign-in/opaque/complete`, other)).toBeUndefined();

    const failed = json({ code: "INVALID_STATE" }, 400);
    expect(await checkChallengeResponse(`${base}/reset/opaque/challenge`, failed)).toBeUndefined();
  });
});
