import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderHermesConfig } from "../src/agents/hermes.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

describe("Hermes profile tool exposure", () => {
  it("keeps bridge MCP tools direct: tool search (deferred tool_call with JSON-string calls) is off", () => {
    const cfg = parse(renderHermesConfig({ agentId: "agent-sales-0001", port: 8705 }));
    // Hermes normalizes "off" (and a YAML 1.1 false) to off; anything else defers MCP tools.
    expect(["off", false]).toContain(cfg.tools?.tool_search?.enabled);
    expect(cfg.mcp_servers.bridge.url).toMatch(/\/mcp$/);
  });
});
