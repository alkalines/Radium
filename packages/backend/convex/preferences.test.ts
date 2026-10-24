/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

type TestIdentity = {
  tokenIdentifier?: string;
  subject?: string;
};

type AuthContext = {
  auth: {
    getUserIdentity: () => Promise<TestIdentity | null>;
  };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const userId = identity.tokenIdentifier ?? identity.subject;
    if (!userId) return null;

    return { _id: userId, email: `${userId}@example.invalid`, name: userId };
  });

  return { getAuthUser, safeGetAuthUser: getAuthUser };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
}));

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  return convexTest({ schema, modules });
}

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({ tokenIdentifier: userId, subject: userId });
}

test("model pins and hides are per user, deduplicated, and mutually exclusive", async () => {
  const t = makeTest();
  const user = asUser(t, "user");
  const other = asUser(t, "other");

  await expect(t.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: [],
    hiddenModels: [],
  });
  await expect(
    t.mutation(api.preferences.setModelPinned, { model: "a/model", pinned: true }),
  ).rejects.toThrow("Not logged in.");

  await user.mutation(api.preferences.setModelPinned, { model: "a/model", pinned: true });
  await user.mutation(api.preferences.setModelPinned, { model: "b/model", pinned: true });
  await user.mutation(api.preferences.setModelPinned, { model: "a/model", pinned: true });
  await expect(user.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: ["a/model", "b/model"],
    hiddenModels: [],
  });

  // Hiding un-pins.
  await user.mutation(api.preferences.setModelHidden, { model: "a/model", hidden: true });
  await expect(user.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: ["b/model"],
    hiddenModels: ["a/model"],
  });

  // Pinning un-hides.
  await user.mutation(api.preferences.setModelPinned, { model: "a/model", pinned: true });
  await expect(user.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: ["b/model", "a/model"],
    hiddenModels: [],
  });

  await user.mutation(api.preferences.setModelPinned, { model: "b/model", pinned: false });
  await expect(user.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: ["a/model"],
    hiddenModels: [],
  });

  await expect(other.query(api.preferences.get, {})).resolves.toEqual({
    pinnedModels: [],
    hiddenModels: [],
  });
  await expect(
    user.mutation(api.preferences.setModelHidden, { model: "", hidden: true }),
  ).rejects.toThrow("Invalid model.");
  await expect(
    user.mutation(api.preferences.setModelHidden, { model: "x".repeat(201), hidden: true }),
  ).rejects.toThrow("Invalid model.");
});
