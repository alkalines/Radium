import type { Runtime } from "../src/runtime";

/**
 * A signed-in user without the OPAQUE round trips (each costs a 2 GiB Argon2id derivation): a
 * classic password account, as accounts created before encryption have, signed in through
 * Better Auth's own endpoint. Returns its id and session cookie.
 */
export async function classicUser(runtime: Runtime, email: string) {
  const password = "a long enough password";
  const context = await runtime.auth.$context;
  const created = await context.internalAdapter.createUser(
    { email, name: email },
    { method: "admin" },
  );
  await context.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await context.password.hash(password),
  });
  const { headers } = await runtime.auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  return {
    id: created.id,
    headers: new Headers({ cookie: headers.getSetCookie()[0]!.split(";")[0]! }),
  };
}
