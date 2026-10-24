import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { hermesApiKey, mcpToken } from "../src/agents/secrets.js";
import { renderHermesConfig } from "../src/agents/hermes.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { buildMcpApp } from "../src/mcp/server.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

// Interface chosen by the test author (the brief leaves names open):
//   buildMcpApp({ db, rtSimUrl }) -> Fastify instance serving /mcp (src/mcp/server.ts)
//   renderHermesConfig({ agentId, port }) -> YAML string for the profile's config.yaml (src/agents/hermes.ts)

const CLUSTER = { nodes: [{ name: "node-3", state: "degraded", disk_pct: 91 }] };

let db: Db;
let rtSim: Server;
let rtSimHits: string[];
let app: ReturnType<typeof buildMcpApp>;
let mcpUrl: URL;

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')");
  for (const [id, name, template, port] of [
    ["agent-devops-0001", "Ops", "devops", 8701],
    ["agent-qa-00000002", "Tess", "qa", 8702],
  ] as const) {
    await db.query(
      "insert into sa.agents (id, owner_user_id, name, template, api_port) values ($1,'ana',$2,$3,$4)",
      [id, name, template, port],
    );
  }
  rtSimHits = [];
  rtSim = createServer((req, res) => {
    rtSimHits.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(CLUSTER));
  });
  await new Promise<void>((r) => rtSim.listen(0, "127.0.0.1", r));
  const rtSimUrl = `http://127.0.0.1:${(rtSim.address() as AddressInfo).port}`;
  app = buildMcpApp({ db, rtSimUrl });
  await app.listen({ port: 0, host: "127.0.0.1" });
  mcpUrl = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
});

afterEach(async () => {
  await app.close();
  await new Promise((r) => rtSim.close(r));
  await db.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("bridge MCP server", () => {
  it("serves each agent only its template's tools, per-agent auth, ops tools read rt-sim", async () => {
    const devops = await connect(mcpToken("agent-devops-0001"));
    const devopsTools = (await devops.listTools()).tools.map((t) => t.name).sort();
    expect(devopsTools).toEqual(
      [
        "chat_read",
        "cluster_health",
        "db_sync_status",
        "metric_trend",
        "raft_status",
        "recent_alerts",
        "user_last_seen",
      ].sort(),
    );

    const result = await devops.callTool({ name: "cluster_health", arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "")).toEqual(CLUSTER);
    expect(rtSimHits).toHaveLength(1);

    const qa = await connect(mcpToken("agent-qa-00000002"));
    const qaTools = (await qa.listTools()).tools.map((t) => t.name);
    expect(qaTools).not.toContain("cluster_health");
    await qa.callTool({ name: "cluster_health", arguments: {} }).catch(() => undefined);
    expect(rtSimHits).toHaveLength(1);

    const post = (authorization?: string) =>
      fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer agent-devops-0001.forged")).status).toBe(401);
    expect((await post(`Bearer ${mcpToken("agent-devops-0001")}`)).status).toBe(200);
  });
});

describe("Hermes profile rendering", () => {
  it("runs on the local LLM with built-in tools off and the bridge MCP server attached", () => {
    const cfg = parse(renderHermesConfig({ agentId: "agent-devops-0001", port: 8701 }));
    expect(cfg.model.base_url).toMatch(/^http:\/\/127\.0\.0\.1:8000/);
    expect(cfg.agent.disabled_toolsets).toContain("terminal");
    expect(cfg.gateway.standalone).toBe(true);
    expect(cfg.gateway.api_server.port).toBe(8701);
    expect(cfg.gateway.api_server.key).toBe(hermesApiKey("agent-devops-0001"));
    expect(cfg.mcp_servers.bridge.headers.Authorization).toBe(
      `Bearer ${mcpToken("agent-devops-0001")}`,
    );
  });
});
