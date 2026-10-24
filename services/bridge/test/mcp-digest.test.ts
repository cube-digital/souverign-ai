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
  chats.push(["room", "Room", "room", ["ana"]]);
  const joined = new Date(Date.now() - 3_600_000).toISOString();
  for (const [id, title, kind, users] of chats) {
    await db.query("insert into sa.chats (id, title, kind, created_by) values ($1,$2,$3,'ana')", [
      id,
      title,
      kind,
    ]);
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ($1,'agent',$2,'member',$3)",
      [id, AGENT, joined],
    );
    for (const u of users) {
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ($1,'user',$2,'member',$3)",
        [id, u, joined],
      );
    }
  }
  await db.query("update sa.chats set seed_key = 'room', history_until_seq = 10 where id = 'room'");
  const now = Date.now();
  const pre = now - 7_200_000;
  for (const [chat, sender, text, seq, ts] of [
    ["dm-ana", "dev-ana", "dm talk", 1, now - 60_000],
    ["g-shared", "dev-ana", "shared talk", 2, now - 60_000],
    ["g-shared", "dev-ana", "talk before the requester joined", 3, pre],
    ["g-bob", "dev-bob", "bob private talk", 4, now - 60_000],
    ["room", "dev-ana", "seeded history", 5, pre],
    ["room", "dev-ana", "gap before join", 20, pre],
  ] as const) {
    await db.query(
      "insert into sa.messages_plain (device_id, chat_id, id, seq, sender_device, epoch, body, ts) values ('dev-agent',$1,$2,$3,$4,1,$5::jsonb,$6)",
      [chat, `m${seq}`, seq, sender, JSON.stringify({ type: "text", text }), ts],
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
  const result = await digest("dm-ana", "ana");
  expect(result).toHaveLength(2);
  expect(result).toEqual(
    expect.arrayContaining([
      {
        chat_title: "Shared",
        messages: [{ sender: "Ana", text: "shared talk", ts: expect.anything() }],
      },
      {
        chat_title: "Room",
        messages: [{ sender: "Ana", text: "seeded history", ts: expect.anything() }],
      },
    ]),
  );

  await client.close();
  await app.close();
  await db.close();
});
