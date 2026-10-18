import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authErrorMessage, authOptions, validateCredentials } from "../src/lib/auth.ts";

describe("mobile credential feedback", () => {
  it("requires a name and valid email for registration", () => {
    assert.equal(validateCredentials("you@example.com", "password", "   "), "Enter your name.");
    assert.equal(
      validateCredentials("invalid", "password", "Alex"),
      "Enter a valid email address.",
    );
    assert.equal(validateCredentials(" you@example.com ", "password", "Alex"), null);
  });

  it("matches default Better Auth registration password bounds", () => {
    assert.notEqual(validateCredentials("you@example.com", "x".repeat(7), "Alex"), null);
    assert.equal(validateCredentials("you@example.com", "x".repeat(8), "Alex"), null);
    assert.equal(validateCredentials("you@example.com", "x".repeat(128), "Alex"), null);
    assert.notEqual(validateCredentials("you@example.com", "x".repeat(129), "Alex"), null);
  });

  it("does not apply new-password rules to existing credentials or trim passwords", () => {
    assert.equal(validateCredentials("you@example.com", "short"), null);
    assert.equal(validateCredentials("you@example.com", "        ", "Alex"), null);
    assert.equal(validateCredentials("you@example.com", ""), "Enter your password.");
  });

  it("keeps unknown server details out of feedback", () => {
    assert.equal(authErrorMessage("PRIVATE_DATABASE_FAILURE"), authErrorMessage());
    assert.match(authErrorMessage("INVALID_EMAIL_OR_PASSWORD"), /incorrect/);
  });

  it("does not advertise recovery before server email delivery exists", () => {
    assert.equal(authOptions.passwordReset, false);
  });
});
