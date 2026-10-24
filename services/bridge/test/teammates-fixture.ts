import { type ActivityEvent, ChatEngine, type ChatMessage, MemoryKeyStore } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { DevicePublic } from "@sa/protocol";
import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { AgentHost, type AgentHostOptions } from "../src/agents/host.js";
import type { AgentRuntime } from "../src/agents/runtime.js";
import { encrypt } from "../src/agents/secrets.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/auth.js";
import { type Db, openDb } from "../src/db.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { migrate } from "../src/migrate.js";

export const ADMIN_TOKEN = "test-relay-admin-token";
process.env.RELAY_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.BRIDGE_MASTER_KEY = "test-master-key";

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Person = {
  userId: string;
  token: string;
  deviceId: string;
  pub: DevicePublic;
  engine: ChatEngine;
  /** everything this person's engine decrypted, in arrival order */
  seen: ChatMessage[];
  acts: ActivityEvent[];
};

export type World = {
  db: Db;
  relay: FakeRelay;
  host: AgentHost;
  app: ReturnType<typeof buildApp>;
  toolLog: ToolLog;
  close: () => Promise<void>;
};

/** In-memory db + relay, a real AgentHost on a link factory, and the bridge app. */
export async function createWorld(
  runtime: AgentRuntime,
  userIds: string[] = ["ana", "bob"],
  hostOpts: Partial<AgentHostOptions> = {},
): Promise<World> {
  await cryptoReady();
  const db = await openDb("pglite://memory");
  await migrate(db);
  for (const id of userIds) {
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1, $2, $3)", [
      id,
      id.charAt(0).toUpperCase() + id.slice(1),
      hashPin("123456"),
    ]);
  }
  const relay = new FakeRelay();
  const toolLog = new ToolLog();
  const host = new AgentHost({
    db,
    runtime,
    relayInternalUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    toolLog,
    linkFactory: (deviceId: string) => relay.link(deviceId),
    ...hostOpts,
  });
  const app = buildApp({
    db,
    relayAdmin: {
      setMember: async (c) => {
        if (c.op === "add") relay.addMember(c.chat_id, c.device_id);
      },
    },
    agentHost: host,
  });
  return {
    db,
    relay,
    host,
    app,
    toolLog,
    close: async () => {
      await host.stopAll();
      await db.close();
    },
  };
}

/** A person with a registered device and a started engine that records what they see. */
export async function person(w: World, userId: string): Promise<Person> {
  const login = await w.app.inject({
    method: "POST",
    url: "/api/login",
    payload: { user_id: userId, pin: "123456" },
  });
  const token = login.json().token as string;
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  await w.app.inject({
    method: "POST",
    url: "/api/devices",
    headers: auth(token),
    payload: { device_id: deviceId, public_key: keys.publicKey },
  });
  const store = new MemoryKeyStore();
  const device = { deviceId, keys };
  await store.putDevice(device);
  const engine = new ChatEngine({ link: w.relay.link(deviceId), store, device });
  const p: Person = {
    userId,
    token,
    deviceId,
    pub: { device_id: deviceId, public_key: keys.publicKey },
    engine,
    seen: [],
    acts: [],
  };
  engine.onMessage((m) => p.seen.push(m));
  engine.onActivity((a) => p.acts.push(a));
  return p;
}

/** Creates a chat owned by `owner`, adds `others` as members and starts everyone's engine on it. */
export async function startChat(
  w: World,
  owner: Person,
  title: string,
  others: Person[] = [],
): Promise<string> {
  const chat = (
    await w.app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(owner.token),
      payload: { title, member_user_ids: [] },
    })
  ).json();
  for (const o of others) {
    await w.app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/members`,
      headers: auth(owner.token),
      payload: { user_id: o.userId },
    });
  }
  await owner.engine.start([chat.id]);
  for (const o of others) await o.engine.start([chat.id]);
  return chat.id as string;
}

export const agentPub = async (w: World, deviceId: string): Promise<DevicePublic> => {
  const [r] = await w.db.query<{ public_key: string }>(
    "select public_key from sa.devices where id = $1",
    [deviceId],
  );
  return { device_id: deviceId, public_key: r?.public_key ?? "" };
};

/** An agent owned by `owner`, added through the public API. */
export async function addPersonalAgent(
  w: World,
  owner: Person,
  chatId: string,
  name: string,
  template = "general",
): Promise<{ id: string; device_id: string }> {
  const agent = (
    await w.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: auth(owner.token),
      payload: { name, template, soul: "" },
    })
  ).json();
  const r = await w.app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/agents`,
    headers: auth(owner.token),
    payload: { agent_id: agent.id },
  });
  if (r.statusCode !== 200) throw new Error(`add agent failed: ${r.statusCode} ${r.body}`);
  return agent as { id: string; device_id: string };
}

/** Inserts a workspace agent row with its device (no owner), like the roster seeding does. */
export async function insertWorkspaceAgent(
  w: World,
  a: { id: string; name: string; rosterId: string; template: string },
): Promise<{ id: string; device_id: string }> {
  const keys = newDeviceKeys();
  const deviceId = deviceIdFor(keys.publicKey);
  await w.db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope, roster_id) values ($1, null, $2, $3, 'workspace', $4)",
    [a.id, a.name, a.template, a.rosterId],
  );
  await w.db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'agent', $2, $3)",
    [deviceId, a.id, keys.publicKey],
  );
  await w.db.query(
    "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ($1, $2, $3)",
    [deviceId, a.id, encrypt(keys.secretKey)],
  );
  return { id: a.id, device_id: deviceId };
}

/** Makes a workspace agent an active member of the chat on the relay and in the db; not awaited
 * to completion, because the join intro may wait for the chat key. */
export async function joinWorkspaceAgent(
  w: World,
  chatId: string,
  agent: { id: string; device_id: string },
): Promise<void> {
  await w.db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')",
    [chatId, agent.id],
  );
  w.relay.addMember(chatId, agent.device_id);
  void Promise.resolve(w.host.onAgentAdded(chatId, agent.id)).catch(() => {});
  await sleep(100);
}

/** One member mints the next chat key for people and agents. */
export async function rekey(
  w: World,
  chatId: string,
  minter: Person,
  people: Person[],
  agents: { device_id: string }[],
): Promise<void> {
  const pubs = [
    ...people.map((p) => p.pub),
    ...(await Promise.all(agents.map((a) => agentPub(w, a.device_id)))),
  ];
  // like the web: claim the next epoch from the bridge before minting the key
  const [claim] = await w.db.query<{ key_epoch: number }>(
    "update sa.chats set key_epoch = key_epoch + 1 where id = $1 returning key_epoch",
    [chatId],
  );
  await minter.engine.createEpoch(chatId, pubs, claim?.key_epoch);
}

type Text = { type: "text"; text: string; reply_to?: string; meta?: Record<string, any> };

/** Text messages a device posted (as seen by `viewer`), excluding the join intro. */
export const textsFrom = (viewer: Person, deviceId: string) =>
  viewer.seen.filter(
    (m) =>
      m.senderDevice === deviceId &&
      m.status === "ok" &&
      m.body?.type === "text" &&
      (m.body as Text).meta?.trigger !== "intro",
  );
export const textOf = (m: ChatMessage) => (m.body as Text).text;
export const metaOf = (m: ChatMessage) => (m.body as Text).meta;
export const replyToOf = (m: ChatMessage) => (m.body as Text).reply_to;

/** The message `sender` sent with this exact text. */
export const sentWith = (sender: Person, text: string): ChatMessage => {
  const m = sender.seen.find(
    (x) => x.senderDevice === sender.deviceId && x.body?.type === "text" && textOf(x) === text,
  );
  if (!m) throw new Error(`message not seen yet: ${text}`);
  return m;
};

/** Reactions a device sent on a target, in order, as "add 👀" strings. */
export const reactionLog = (viewer: Person, deviceId: string, target: string): string[] =>
  viewer.seen
    .filter(
      (m) =>
        m.senderDevice === deviceId &&
        m.body?.type === "reaction" &&
        (m.body as { target: string }).target === target,
    )
    .map((m) => {
      const b = m.body as { op: string; emoji: string };
      return `${b.op} ${b.emoji}`;
    });

/** Emojis still standing on a target from a device after applying add/remove in order. */
export const reactionsNet = (viewer: Person, deviceId: string, target: string): string[] =>
  [
    ...reactionLog(viewer, deviceId, target).reduce((s, entry) => {
      const [op, emoji] = entry.split(" ") as [string, string];
      if (op === "add") s.add(emoji);
      else s.delete(emoji);
      return s;
    }, new Set<string>()),
  ].sort();

export const activityOf = (viewer: Person, deviceId: string) =>
  viewer.acts.filter((a) => a.senderDevice === deviceId);

/** Like sentWith, but waits for the sender's own copy to be decrypted. */
export async function sent(sender: Person, text: string): Promise<ChatMessage> {
  for (let i = 0; i < 100; i++) {
    try {
      return sentWith(sender, text);
    } catch {
      await sleep(30);
    }
  }
  return sentWith(sender, text);
}
