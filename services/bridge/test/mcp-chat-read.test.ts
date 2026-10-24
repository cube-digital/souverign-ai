import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it } from "vitest";
import { mcpToken } from "../src/agents/secrets.js";
import { openDb } from "../src/db.js";
import { buildMcpApp } from "../src/mcp/server.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { migrate } from "../src/migrate.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

it("chat_read refuses any chat other than the current turn's chat", async () => {
  const db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')");
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template) values ('agent-qa-00000002','ana','Tess','qa')",
  );
  for (const c of ["c1", "c2"]) {
    await db.query(
      "insert into sa.chats (id, title, kind, created_by) values ($1,'T','group','ana')",
      [c],
    );
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,'agent','agent-qa-00000002','member')",
      [c],
    );
  }
  const toolLog = new ToolLog();
  toolLog.begin("agent-qa-00000002", "c1");
  const app = buildMcpApp({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken("agent-qa-00000002")}` } },
    }),
  );
  const read = async (chat_id: string) => {
    const r = await client.callTool({ name: "chat_read", arguments: { chat_id } });
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
  };
  expect(await read("c2")).toEqual({ error: "not_current_chat" });
  expect(await read("c1")).toEqual([]);
  await client.close();
  await app.close();
  await db.close();
});
