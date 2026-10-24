import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ url: "" }));
vi.mock("../src/agents/hermes.js", async (orig) => {
  const mod = await orig<typeof import("../src/agents/hermes.js")>();
  return { ...mod, llmTarget: () => ({ baseUrl: upstream.url, model: "org/test-model" }) };
});

import { setForceFirstTool } from "../src/agents/turn-policy.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";
process.env.RELAY_ADMIN_TOKEN = "t";

const SSE = ['data: {"a":1}\n\n', 'data: {"b":"é"}\n\n', "data: [DONE]\n\n"];
let server: Server;
let seen: { url?: string; body: unknown }[];
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", async () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end('{"data":[]}');
      }
      res.setHeader("content-type", "text/event-stream");
      for (const c of SSE) {
        res.write(c);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  seen = [];
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana',$1)", [
    hashPin("123456"),
  ]);
  for (const [id, tpl] of [
    ["ag-ops", "ops"],
    ["ag-gen", "general"],
    ["ag-off", "ops"],
  ])
    await db.query(
      "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana',$1,$2)",
      [id, tpl],
    );
  app = buildApp({ db, relayAdmin: { setMember: async () => {} } });
});

const tools = [{ type: "function", function: { name: "cluster_health", parameters: {} } }];
const user = { role: "user", content: "is it ok?" };
const call = (agent: string, body: unknown, remoteAddress = "127.0.0.1") =>
  app.inject({
    method: "POST",
    url: `/llm/${agent}/v1/chat/completions`,
    payload: body as object,
    remoteAddress,
  });

describe("llm proxy", () => {
  it("forces a tool on the first round only, and forwards every other request unchanged", async () => {
    setForceFirstTool("ag-off", false);
    const first = { model: "m", stream: true, tools, messages: [user] };
    const afterTool = {
      ...first,
      messages: [user, { role: "assistant", content: "" }, { role: "tool", content: "ok" }],
    };
    const noTools = { model: "m", stream: true, messages: [user] };

    await call("ag-ops", first);
    await call("ag-ops", afterTool);
    await call("ag-ops", noTools);
    await call("ag-gen", first);
    await call("ag-off", first);

    expect(seen.map((s) => s.body)).toEqual([
      { ...first, tool_choice: "required" },
      afterTool,
      noTools,
      first,
      first,
    ]);
  });

  it("serves loopback callers only and streams the upstream body through byte for byte", async () => {
    const body = { model: "m", stream: true, tools, messages: [user] };

    const remote = await call("ag-ops", body, "10.0.0.7");
    const unknown = await call("nobody", body);
    const ok = await call("ag-ops", body);
    const models = await app.inject({ method: "GET", url: "/llm/ag-ops/v1/models" });

    expect(remote.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(404);
    expect(seen.filter((s) => s.url?.includes("completions"))).toHaveLength(1);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/event-stream");
    expect(ok.body).toBe(SSE.join(""));
    expect(models.json()).toEqual({ data: [] });
  });
});
