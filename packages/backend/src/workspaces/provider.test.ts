import { describe, expect, test } from "bun:test";

import type { ProviderSnapshot } from "./provider";
import {
  isWorkspaceProviderEnabled,
  workspaceProviderRecords,
  workspaceProviderView,
} from "../../convex/provider_records";

function provider(slug: string, api: string): ProviderSnapshot {
  return {
    slug,
    name: slug,
    npm: "@ai-sdk/openai-compatible",
    env: ["API_KEY"],
    api,
    models: [
      {
        model: `${slug}/model`,
        context: 8_192,
        max_output: 1_024,
        pricing: { input: "0", output: "0" },
        supported_parameters: ["max_tokens"],
        moderated: false,
      },
    ],
  };
}

function mockContext(rows: { workspace_configurations: unknown[]; providers: unknown[] }) {
  const db = {
    query(table: keyof typeof rows) {
      const tableRows = rows[table];
      return makeQuery(tableRows);
    },
  };

  return { db } as never;
}

function makeQuery(rows: unknown[]) {
  const query = {
    withIndex(
      _name: string,
      callback: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) {
      const expression = callback({
        eq: (field, value) => ({ field, value }),
      }) as { field: string; value: unknown };
      return makeQuery(
        rows.filter(
          (row) => (row as Record<string, unknown>)[expression.field] === expression.value,
        ),
      );
    },
    async take(limit: number) {
      return rows.slice(0, limit);
    },
  };

  return query;
}

describe("workspace provider resolution", () => {
  test("uses independent snapshots for two workspaces", async () => {
    const catalog = provider("shared", "https://catalog.example/v1");
    const aliceSnapshot = provider("shared", "http://alice.local/v1");
    const bobSnapshot = provider("shared", "http://bob.local/v1");
    const rows = {
      workspace_configurations: [
        {
          _id: "config_alice",
          _creationTime: 1,
          workspace: "workspace_alice",
          provider: "shared",
          enabled: true,
          active: true,
          snapshot: aliceSnapshot,
        },
        {
          _id: "config_bob",
          _creationTime: 2,
          workspace: "workspace_bob",
          provider: "shared",
          enabled: true,
          active: true,
          snapshot: bobSnapshot,
        },
      ],
      providers: [{ ...catalog, _id: "catalog_shared", _creationTime: 0, enabled: false }],
    };

    const alice = await workspaceProviderRecords(mockContext(rows), {
      _id: "workspace_alice",
      legacyBalance: "balance_alice",
    } as never);
    const bob = await workspaceProviderRecords(mockContext(rows), {
      _id: "workspace_bob",
      legacyBalance: "balance_bob",
    } as never);

    expect(alice[0]?.provider.api).toBe("http://alice.local/v1");
    expect(bob[0]?.provider.api).toBe("http://bob.local/v1");
    expect(workspaceProviderView(alice[0]!)._id).toBe("config_alice");
    expect(workspaceProviderView(alice[0]!).enabled).toBe(true);
  });

  test("a tombstone blocks legacy fallback after explicit deletion", async () => {
    const rows = {
      workspace_configurations: [
        {
          _id: "config_deleted",
          _creationTime: 1,
          workspace: "workspace_legacy",
          provider: "shared",
          enabled: false,
          active: false,
          deletedAt: 10,
        },
      ],
      providers: [{ ...provider("shared", "https://catalog.example/v1"), enabled: true }],
    };

    const records = await workspaceProviderRecords(mockContext(rows), {
      _id: "workspace_legacy",
      legacyBalance: "balance_legacy",
    } as never);

    expect(records).toEqual([]);
  });

  test("a disabled local configuration suppresses legacy providers", async () => {
    const rows = {
      workspace_configurations: [
        {
          _id: "config_disabled",
          _creationTime: 1,
          workspace: "workspace_legacy",
          provider: "shared",
          enabled: false,
          active: false,
          snapshot: provider("shared", "http://workspace.local/v1"),
        },
      ],
      providers: [
        { ...provider("shared", "https://catalog.example/v1"), enabled: true },
        { ...provider("other", "https://other.example/v1"), enabled: true },
      ],
    };

    const records = await workspaceProviderRecords(mockContext(rows), {
      _id: "workspace_legacy",
      legacyBalance: "balance_legacy",
    } as never);

    expect(records).toHaveLength(1);
    expect(records[0]?.provider.api).toBe("http://workspace.local/v1");
    expect(isWorkspaceProviderEnabled(records[0]!)).toBe(false);
  });

  test("legacy fallback is used only before local configuration starts", async () => {
    const rows = {
      workspace_configurations: [],
      providers: [{ ...provider("shared", "https://catalog.example/v1"), enabled: true }],
    };

    const records = await workspaceProviderRecords(mockContext(rows), {
      _id: "workspace_legacy",
      legacyBalance: "balance_legacy",
    } as never);

    expect(records).toHaveLength(1);
    expect(isWorkspaceProviderEnabled(records[0]!)).toBe(true);
    expect(records[0]?.provider.api).toBe("https://catalog.example/v1");
  });
});
