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

const AGENT = "agent-scribe-000005";

it("chat_digest works only in the requester's DM and only over chats the requester shares with the agent", async () => {
  const db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["bob", "Bob"],
  ] as const) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1,$2,'x')", [
      id,
      name,
    ]);
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user',$2,'pk')",
      [`dev-${id}`, id],
    );
  }
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana','Chief','scribe')",
    [AGENT],
  );
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ('dev-agent','agent',$1,'pk')",
    [AGENT],
  );
  await db.query(
    "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ('dev-agent',$1,'k')",
    [AGENT],
  );
  const chats: [string, string, string, string[]][] = [
    ["dm-ana", "Ana DM", "dm", ["ana"]],
    ["dm-bob", "Bob DM", "dm", ["bob"]],
    ["g-shared", "Shared", "group", ["ana", "bob"]],
    ["g-bob", "Bob only", "group", ["bob"]],
  ];
  for (const [id, title, kind, users] of chats) {
    await db.query("insert into sa.chats (id, title, kind, created_by) values ($1,$2,$3,'ana')", [
      id,
      title,
      kind,
    ]);
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,'agent',$2,'member')",
      [id, AGENT],
    );
    for (const u of users) {
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1,'user',$2,'member')",
        [id, u],
      );
    }
  }
  let seq = 0;
  const now = Date.now();
  for (const [chat, sender, text] of [
    ["dm-ana", "dev-ana", "dm talk"],
    ["g-shared", "dev-ana", "shared talk"],
    ["g-bob", "dev-bob", "bob private talk"],
  ] as const) {
    seq += 1;
    await db.query(
      "insert into sa.messages_plain (device_id, chat_id, id, seq, sender_device, epoch, body, ts) values ('dev-agent',$1,$2,$3,$4,1,$5::jsonb,$6)",
      [chat, `m${seq}`, seq, sender, JSON.stringify({ type: "text", text }), now - 60_000],
    );
  }

  const toolLog = new ToolLog();
  const app = buildMcpApp({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken(AGENT)}` } },
    }),
  );
  const digest = async (chat: string, requester: string) => {
    toolLog.begin(AGENT, chat, { requesterUserId: requester });
    const r = await client.callTool({ name: "chat_digest", arguments: {} });
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
  };

  expect(await digest("g-shared", "ana")).toEqual({ error: "digest_only_in_dm" });
  expect(await digest("dm-bob", "ana")).toEqual({ error: "digest_only_in_dm" });
  expect(await digest("dm-ana", "ana")).toEqual([
    {
      chat_title: "Shared",
      messages: [{ sender: "Ana", text: "shared talk", ts: expect.anything() }],
    },
  ]);

  await client.close();
  await app.close();
  await db.close();
});
