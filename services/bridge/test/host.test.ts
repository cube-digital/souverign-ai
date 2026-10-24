import { ChatEngine, MemoryKeyStore } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { DevicePublic, MessageBody } from "@sa/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// The in-memory relay is shared with the client package's own tests.
import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { EchoRuntime } from "../src/agents/echo.js";
import { AgentHost } from "../src/agents/host.js";
import type { AgentRuntime, ChatMessage, RuntimeAgent } from "../src/agents/runtime.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { migrate } from "../src/migrate.js";

const ADMIN_TOKEN = "test-relay-admin-token";
process.env.RELAY_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.BRIDGE_MASTER_KEY = "test-master-key";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const DOWN = "I can't answer right now (the local model is not available).";

type Seen = { senderDevice: string; status: string; body: MessageBody | null };

let db: Db;
let relay: FakeRelay;
let host: AgentHost;
let toolLog: ToolLog;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await cryptoReady();
});

async function setup(runtime: AgentRuntime) {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)", [
    "ana",
    "Ana",
    hashPin("123456"),
  ]);
  relay = new FakeRelay();
  toolLog = new ToolLog();
  host = new AgentHost({
    db,
    runtime,
    relayInternalUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    toolLog,
    // test seam: the host talks to the in-memory relay instead of a websocket
    linkFactory: (deviceId: string) => relay.link(deviceId),
  });
  app = buildApp({
    db,
    relayAdmin: {
      setMember: async (c) => {
        if (c.op === "add") relay.addMember(c.chat_id, c.device_id);
      },
    },
    agentHost: host,
  });
}

/** Ana with a real device, a chat she owns, and a started engine that records what she sees. */
async function anaInChat() {
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { user_id: "ana", pin: "123456" },
  });
  const token = login.json().token as string;
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  await app.inject({
    method: "POST",
    url: "/api/devices",
    headers: auth(token),
    payload: { device_id: deviceId, public_key: keys.publicKey },
  });
  const chat = (
    await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(token),
      payload: { title: "Ops room", member_user_ids: [] },
    })
  ).json();
  const store = new MemoryKeyStore();
  const device = { deviceId, keys };
  await store.putDevice(device);
  const engine = new ChatEngine({ link: relay.link(deviceId), store, device });
  const seen: Seen[] = [];
  engine.onMessage((m) => seen.push(m as Seen));
  await engine.start([chat.id]);
  const pub: DevicePublic = { device_id: deviceId, public_key: keys.publicKey };
  return { token, chatId: chat.id as string, engine, seen, pub, deviceId };
}

async function addAgent(
  ana: Awaited<ReturnType<typeof anaInChat>>,
  name: string,
  template = "general",
) {
  const agent = (
    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(ana.token),
      payload: { name, template, soul: "" },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/api/chats/${ana.chatId}/agents`,
    headers: auth(ana.token),
    payload: { agent_id: agent.id },
  });
  return agent as { id: string; device_id: string };
}

const textOf = (m: Seen) => (m.body as { text: string }).text;
const metaOf = (m: Seen) =>
  (m.body as { meta?: { tools?: string[]; ms?: number; trace?: unknown[] } }).meta;
const from = (seen: Seen[], deviceId: string) =>
  seen.filter((m) => m.senderDevice === deviceId && m.status === "ok");

afterEach(async () => {
  await host.stopAll();
  await db.close();
});

describe("agent host", () => {
  beforeEach(async () => {
    await setup(new EchoRuntime());
  });

  it("replies only when addressed by name, at most once per 3 seconds", async () => {
    const ana = await anaInChat();
    const agent = await addAgent(ana, "Scout");
    await ana.engine.createEpoch(ana.chatId, [
      ana.pub,
      {
        device_id: agent.device_id,
        public_key:
          (
            await db.query<{ public_key: string }>(
              "select public_key from sa.devices where id = $1",
              [agent.device_id],
            )
          )[0]?.public_key ?? "",
      },
    ]);

    await ana.engine.sendText(ana.chatId, "hello team");
    await ana.engine.sendText(ana.chatId, "@scouting around the corner");
    await ana.engine.sendText(ana.chatId, "@scout ping one");
    await expect.poll(() => from(ana.seen, agent.device_id).length, { timeout: 5000 }).toBe(1);
    await ana.engine.sendText(ana.chatId, "@SCOUT ping two");
    await new Promise((r) => setTimeout(r, 500));

    const replies = from(ana.seen, agent.device_id);
    expect(replies).toHaveLength(1);
    expect(textOf(replies[0] as Seen).endsWith("| @scout ping one")).toBe(true);
    expect(metaOf(replies[0] as Seen)?.tools).toEqual([]);
    expect(metaOf(replies[0] as Seen)?.trace?.[0]).toEqual({
      kind: "thinking",
      text: expect.stringMatching(/^echo: looked at 2 messages$/),
    });
  });

  it("never shows the agent messages from before it was invited", async () => {
    const ana = await anaInChat();
    await ana.engine.createEpoch(ana.chatId, [ana.pub]);
    await ana.engine.sendText(ana.chatId, "PRE-INVITE-SENTINEL");
    const agent = await addAgent(ana, "Scout");
    const [agentRow] = await db.query<{ public_key: string }>(
      "select public_key from sa.devices where id = $1",
      [agent.device_id],
    );
    await ana.engine.createEpoch(ana.chatId, [
      ana.pub,
      { device_id: agent.device_id, public_key: agentRow?.public_key ?? "" },
    ]);
    await ana.engine.sendText(ana.chatId, "POST-INVITE-SENTINEL");
    await ana.engine.sendText(ana.chatId, "@Scout what do you see?");

    await expect.poll(() => from(ana.seen, agent.device_id).length, { timeout: 5000 }).toBe(1);
    const reply = textOf(from(ana.seen, agent.device_id)[0] as Seen);
    expect(reply).toContain("POST-INVITE-SENTINEL");
    expect(reply).not.toContain("PRE-INVITE-SENTINEL");
  });
});

describe("agent host replies", () => {
  it("carries tools, time and reasoning trace, and reports a failing runtime in the chat", async () => {
    const runtime: AgentRuntime = {
      ensureStarted: async () => {},
      stop: async () => {},
      stopAll: async () => {},
      chat: async (agent: RuntimeAgent, _chatId: string, _m: ChatMessage[]) => {
        if (agent.name === "Broken") throw new Error("connect ECONNREFUSED");
        toolLog.record(agent.id, {
          name: "cluster_health",
          args: { node: "a" },
          result: "ok",
          ms: 12,
        });
        toolLog.record(agent.id, { name: "raft_status", args: "{}", result: "leader", ms: 7 });
        return { content: "all green", reasoning: "r".repeat(5000) };
      },
    };
    await setup(runtime);
    const ana = await anaInChat();
    const good = await addAgent(ana, "Scout", "devops");
    const bad = await addAgent(ana, "Broken");
    const pubOf = async (id: string) =>
      (
        await db.query<{ public_key: string }>("select public_key from sa.devices where id = $1", [
          id,
        ])
      )[0]?.public_key ?? "";
    await ana.engine.createEpoch(ana.chatId, [
      ana.pub,
      { device_id: good.device_id, public_key: await pubOf(good.device_id) },
      { device_id: bad.device_id, public_key: await pubOf(bad.device_id) },
    ]);

    await ana.engine.sendText(ana.chatId, "@Scout how is the cluster?");
    await ana.engine.sendText(ana.chatId, "@Broken are you there?");
    await expect.poll(() => from(ana.seen, good.device_id).length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => from(ana.seen, bad.device_id).length, { timeout: 5000 }).toBe(1);

    const ok = from(ana.seen, good.device_id)[0] as Seen;
    expect(textOf(ok)).toBe("all green");
    expect(metaOf(ok)?.tools).toEqual(["cluster_health", "raft_status"]);
    expect(Number.isInteger(metaOf(ok)?.ms)).toBe(true);
    expect(metaOf(ok)?.trace).toEqual([
      { kind: "thinking", text: "r".repeat(4000) },
      { kind: "tool", name: "cluster_health", args: '{"node":"a"}', result: "ok", ms: 12 },
      { kind: "tool", name: "raft_status", args: "{}", result: "leader", ms: 7 },
    ]);

    const failed = from(ana.seen, bad.device_id)[0] as Seen;
    expect(textOf(failed)).toBe(DOWN);
    expect(metaOf(failed)?.tools).toEqual([]);
    expect(Number.isInteger(metaOf(failed)?.ms)).toBe(true);
    const [row] = await db.query<{ status: string }>("select status from sa.agents where id = $1", [
      bad.id,
    ]);
    expect(row?.status).toBe("error");
  });
});

describe("agent host live activity", () => {
  it("announces thinking, a growing draft, the final reply and done, in that order", async () => {
    await setup(new EchoRuntime());
    const ana = await anaInChat();
    const agent = await addAgent(ana, "Scout");
    const [agentRow] = await db.query<{ public_key: string }>(
      "select public_key from sa.devices where id = $1",
      [agent.device_id],
    );
    await ana.engine.createEpoch(ana.chatId, [
      ana.pub,
      { device_id: agent.device_id, public_key: agentRow?.public_key ?? "" },
    ]);
    type Step = { kind: string; draft?: string | undefined; text?: string };
    const timeline: Step[] = [];
    ana.engine.onActivity((a) => {
      if (a.senderDevice === agent.device_id)
        timeline.push({ kind: a.body.phase, draft: a.body.draft });
    });
    ana.engine.onMessage((m) => {
      if (m.senderDevice === agent.device_id && m.status === "ok")
        timeline.push({ kind: "message", text: (m.body as { text: string }).text });
    });

    await ana.engine.sendText(ana.chatId, "@Scout please summarise the room status for me");
    await expect.poll(() => timeline.some((s) => s.kind === "done"), { timeout: 8000 }).toBe(true);

    const kinds = timeline.map((s) => s.kind);
    expect(kinds[0]).toBe("thinking");
    expect(kinds.slice(-2)).toEqual(["message", "done"]);
    expect(kinds.slice(1, -2).length).toBeGreaterThanOrEqual(1);
    expect(new Set(kinds.slice(1, -2))).toEqual(new Set(["writing"]));
    const drafts = timeline.filter((s) => s.kind === "writing").map((s) => s.draft ?? "");
    const finalText = timeline[timeline.length - 2]?.text ?? "";
    const first = drafts[0] ?? "";
    const last = drafts[drafts.length - 1] ?? "";
    expect(first.length).toBeGreaterThan(0);
    expect(last.length).toBeGreaterThan(first.length);
    expect(last.startsWith(first)).toBe(true);
    expect(finalText.startsWith(last)).toBe(true);
  }, 15000);

  it("starts an agent's runtime when it is added to a chat, before any question", async () => {
    const started: string[] = [];
    const echo = new EchoRuntime();
    await setup({
      ensureStarted: async (agent: RuntimeAgent) => {
        started.push(agent.id);
      },
      stop: async () => {},
      stopAll: async () => {},
      chat: (a, c, m) => echo.chat(a, c, m),
      chatStream: (a, c, m, d) => echo.chatStream(a, c, m, d),
    } as AgentRuntime);
    const ana = await anaInChat();
    expect(started).toEqual([]);

    const agent = await addAgent(ana, "Scout");

    await expect.poll(() => started, { timeout: 5000 }).toEqual([agent.id]);
  }, 15000);
});
