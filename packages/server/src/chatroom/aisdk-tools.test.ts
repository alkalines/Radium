import { expect, test } from "vitest";
import {
  normalizeMcpUrl,
  requireExaApiKey,
  requireMcpName,
  toolNamePrefix,
  uniqueToolName,
} from "./aisdk-tools";

test("MCP configuration normalizes HTTP URLs and names without accepting other protocols", () => {
  expect(normalizeMcpUrl(" https://example.invalid/mcp ")).toBe("https://example.invalid/mcp");
  expect(normalizeMcpUrl("http://localhost:3000/mcp")).toBe("http://localhost:3000/mcp");
  expect(() => normalizeMcpUrl("relative/path")).toThrow("valid absolute URL");
  expect(() => normalizeMcpUrl("file:///etc/passwd")).toThrow("http or https");
  expect(requireMcpName("  Search  ")).toBe("Search");
  expect(() => requireMcpName("  ")).toThrow("Server name is required");
});

test("Exa keys trim input and tool names avoid built-in and MCP collisions", () => {
  expect(requireExaApiKey("  test-key  ")).toBe("test-key");
  expect(() => requireExaApiKey(" \n ")).toThrow("An Exa API key is required");
  expect(toolNamePrefix("Web Search!")).toBe("web_search");
  expect(toolNamePrefix("!!!")).toBe("mcp");
  expect(uniqueToolName({ web_search: true, web_search_2: true }, "web_search")).toBe(
    "web_search_3",
  );
});
