import { describe, expect, test } from "bun:test";
import { formatAgentCommandLine, parseAgentCommandLine } from "./agent-command-line";

describe("parseAgentCommandLine", () => {
  test("splits whitespace and keeps quoted and adjacent fragments", () => {
    expect(parseAgentCommandLine(`agent --name "two words" 'literal value' pre"fix"`)).toEqual([
      "agent",
      "--name",
      "two words",
      "literal value",
      "prefix",
    ]);
  });
  test("supports escaped whitespace, quotes and backslashes", () => {
    expect(parseAgentCommandLine(String.raw`agent two\ words \"quote\" "a\\b\"c" 'a\b'`)).toEqual([
      "agent",
      "two words",
      '"quote"',
      'a\\b"c',
      "a\\b",
    ]);
    expect(parseAgentCommandLine(String.raw`agent "a\qb"`)).toEqual(["agent", "a\\qb"]);
  });
  test("accepts empty input and preserves explicitly empty arguments", () => {
    expect(parseAgentCommandLine(" \t\n ")).toEqual([]);
    expect(parseAgentCommandLine(`agent '' ""`)).toEqual(["agent", "", ""]);
  });
  test("does not interpret shell expansions or operators", () => {
    expect(parseAgentCommandLine("agent $HOME | other")).toEqual(["agent", "$HOME", "|", "other"]);
  });
  test("joins escaped newlines", () => {
    expect(parseAgentCommandLine("agent first\\\nsecond")).toEqual(["agent", "firstsecond"]);
  });
  test("rejects unbalanced quotes and unfinished escapes", () => {
    expect(() => parseAgentCommandLine(`agent "unfinished`)).toThrow("unbalanced quote");
    expect(() => parseAgentCommandLine("agent 'unfinished")).toThrow("unbalanced quote");
    expect(() => parseAgentCommandLine("agent \\")).toThrow("unfinished escape");
  });
  test("round-trips stored arguments", () => {
    const argv = ["/path with spaces/agent", "", "it's", 'a"b', "a\\b", "$HOME", "line\nbreak"];
    expect(parseAgentCommandLine(formatAgentCommandLine(argv))).toEqual(argv);
  });
});
