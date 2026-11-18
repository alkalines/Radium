// Dependencies are evaluated here, before the spy: @noble/curves probes the RNG once while its curve
// modules load (to decide on scalar blinding) and tolerates any result. In Convex that probe reads the
// deploy-time seeded generator and is discarded. The test below covers this package's own modules.
import "@noble/curves/ed25519.js";
import "@panva/hpke-noble";
import "@scure/bip39";
import "@scure/bip39/wordlists/english.js";
import "hpke";
import { describe, expect, it, vi } from "vitest";

describe("radium-crypto entry point", () => {
  it("uses no randomness while its own modules are imported", async () => {
    vi.resetModules();
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    try {
      // Dynamic on purpose: the module graph must be evaluated after the spy is installed.
      await import("./index");
      expect(getRandomValues).not.toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
    }
  });

});
