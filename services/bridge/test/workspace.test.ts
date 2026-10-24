import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatEngine, type ChatMessage } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import { ROSTER, SEED_CHANNELS } from "@sa/protocol";
import type { RelayMemberChange } from "@sa/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// The in-memory relay is shared with the client package's own tests.
import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { PgKeyStore } from "../src/agents/pg-keystore.js";
import { decrypt, encrypt } from "../src/agents/secrets.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { ensureWorkspace } from "../src/workspace/seed.js";

// Interface under test (the contract the implementation must expose):
//   ensureWorkspace(deps: PluginContext & { linkFactory?: (deviceId) => RelayLink }):
//     Promise<{ grant(chatId, userId): Promise<void>;
//               hooks: { onDeviceRegistered(userId, deviceId); onMemberAdded(chatId, userId) };
//               close(): void | Promise<void> }>
// `linkFactory` is the same test seam AgentHost has; without it the real relay websocket is used.

process.env.BRIDGE_MASTER_KEY = "test-master-key";

let db: Db;
let relay: FakeRelay;
let relayHttp: Server;
let relayUrl: string;
let adminCalls: RelayMemberChange[];
const closers: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
  await cryptoReady();
  relayHttp = createServer((req, res) => {
    res.statusCode = req.url === "/relay/healthz" ? 200 : 404;
    res.end("ok");
  });
  await new Promise<void>((r) => relayHttp.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(relayHttp.address() as AddressInfo).port}`;
  return () => relayHttp.close();
});

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')");
  relay = new FakeRelay();
  adminCalls = [];
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await db.close();
});

async function run() {
  const ws = await ensureWorkspace({
    db,
    relayAdmin: {
      setMember: async (c: RelayMemberChange) => {
        adminCalls.push(c);
        if (c.op === "add") relay.addMember(c.chat_id, c.device_id);
      },
    },
    relayInternalUrl: relayUrl,
    adminToken: "t",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: {
      onAgentAdded: async () => {},
      onAgentRemoved: async () => {},
    },
    log: () => {},
    linkFactory: (deviceId: string) => relay.link(deviceId),
  } as never);
  closers.push(() => ws.close());
  return ws;
}

const chatId = async (seedKey: string) =>
  (await db.query<{ id: string }>("select id from sa.chats where seed_key = $1", [seedKey]))[0]
    ?.id as string;

async function registerAnaDevice() {
  const keys = newDeviceKeys();
  const id = deviceIdFor(keys.publicKey);
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user','ana',$2)",
    [id, keys.publicKey],
  );
  return { id, keys };
}

const agentDeviceIds = async () =>
  (await db.query<{ device_id: string }>("select device_id from sa.agent_devices")).map(
    (r) => r.device_id,
  );

async function snapshot() {
  const count = async (t: string) =>
    Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`))[0]?.n);
  return {
    users: await count("sa.users"),
    chats: await count("sa.chats"),
    members: await count("sa.chat_members"),
    agents: await count("sa.agents"),
    devices: await count("sa.devices"),
    agentDevices: await count("sa.agent_devices"),
    seedDevices: await count("sa.seed_devices"),
    relayEnvelopes: relay.log.length,
    adminCalls: adminCalls.length,
  };
}

describe("seeded workspace", () => {
  it("first start creates four rooms with history, seed colleagues and six agents; a second start changes nothing", async () => {
    await run();
    const first = await snapshot();

    const rooms = await db.query<{
      seed_key: string;
      title: string;
      topic: string;
      id: string;
      hus: string;
      created_by: string;
    }>(
      "select id, seed_key, title, topic, history_until_seq as hus, created_by from sa.chats where seed_key is not null order by seed_key",
    );
    expect(rooms.map((r) => [r.seed_key, r.title, r.topic])).toEqual(
      [...SEED_CHANNELS]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((c) => [c.key, c.title, c.topic]),
    );
    expect(rooms.map((r) => r.created_by)).toEqual(["mira", "mira", "mira", "mira"]);

    const seedUsers = await db.query<{ id: string; display_name: string; pin_hash: string }>(
      "select id, display_name, pin_hash from sa.users where kind = 'seed' order by id",
    );
    expect(seedUsers).toEqual([
      { id: "lea", display_name: "Lea Moreau", pin_hash: "disabled" },
      { id: "mira", display_name: "Mira Novak", pin_hash: "disabled" },
      { id: "tom", display_name: "Tom Weber", pin_hash: "disabled" },
    ]);
    expect(first.seedDevices).toBe(3);

    const agents = await db.query<{
      roster_id: string;
      scope: string;
      owner_user_id: string | null;
    }>(
      "select roster_id, scope, owner_user_id from sa.agents where scope = 'workspace' order by roster_id",
    );
    expect(agents).toEqual(
      ROSTER.map((r) => ({ roster_id: r.id, scope: "workspace", owner_user_id: null })).sort(
        (a, b) => a.roster_id.localeCompare(b.roster_id),
      ),
    );

    for (const room of rooms) {
      const members = await db.query<{ member_type: string; member_id: string; role: string }>(
        "select member_type, member_id, role from sa.chat_members where chat_id = $1 and removed_at is null",
        [room.id],
      );
      const users = members
        .filter((m) => m.member_type === "user")
        .map((m) => m.member_id)
        .sort();
      expect(users).toEqual(["ana", "lea", "mira", "tom"]);
      expect(members.find((m) => m.member_id === "mira")?.role).toBe("owner");
      const rosterIds = (
        await db.query<{ roster_id: string }>(
          `select a.roster_id from sa.chat_members m join sa.agents a on a.id = m.member_id
           where m.chat_id = $1 and m.member_type = 'agent' and m.removed_at is null order by a.roster_id`,
          [room.id],
        )
      ).map((r) => r.roster_id);
      const key = room.seed_key;
      expect(rosterIds).toEqual(
        ROSTER.filter((r) => (r.channels as string[]).includes(key))
          .map((r) => r.id)
          .sort(),
      );
      const msgs = relay.log.filter((s) => s.env.chat_id === room.id && s.env.kind === "msg");
      // 8-12 story messages plus the "created this channel" line
      expect(msgs.length).toBeGreaterThanOrEqual(9);
      expect(msgs.length).toBeLessThanOrEqual(13);
      expect(Number(room.hus)).toBe(msgs.at(-1)?.seq);
    }

    // a second start (a restart of the bridge) creates and sends nothing
    await closers.pop()?.();
    await run();
    expect(await snapshot()).toEqual(first);
  });

  it("back-dates seeded messages and marks agent ones seeded, with no receipts", async () => {
    await run();
    const ops = await chatId("ops");
    const envs = relay.log.filter((s) => s.env.chat_id === ops && s.env.kind === "msg");
    const old = envs.filter((s) => s.env.ts < Date.now() - 60_000);
    // everything but the live "Mira created this channel" line is in the past
    expect(old.length).toBe(envs.length - 1);

    const [row] = await db.query<{ device_id: string; public_key: string; enc_secret_key: string }>(
      `select ad.device_id, dv.public_key, ad.enc_secret_key from sa.agents a
       join sa.agent_devices ad on ad.agent_id = a.id join sa.devices dv on dv.id = ad.device_id
       where a.roster_id = 'ops'`,
    );
    const device = {
      deviceId: row?.device_id as string,
      keys: {
        publicKey: row?.public_key as string,
        secretKey: decrypt(row?.enc_secret_key as string),
      },
    };
    const engine = new ChatEngine({
      link: relay.link(device.deviceId),
      store: new PgKeyStore(db, device, { encrypt, decrypt }),
      device,
    });
    const seen: ChatMessage[] = [];
    engine.onMessage((m) => seen.push(m));
    await engine.start([ops]);
    await vi.waitFor(() => expect(seen.filter((m) => m.status === "ok").length).toBe(envs.length));

    const byAgent = seen.filter((m) => m.senderDevice === device.deviceId);
    const bodies = byAgent.map((m) => m.body as { type: string; text: string; meta?: unknown });
    expect(byAgent.length).toBeGreaterThan(0);
    expect(bodies.map((b) => b.type)).toEqual(bodies.map(() => "text"));
    expect(bodies.map((b) => b.meta)).toEqual(bodies.map(() => ({ seeded: true })));
    expect(bodies.every((b) => b.text.length > 0)).toBe(true);
  });

  it("gives a person's new device the seeded history window and every room key", async () => {
    const ws = await run();
    const dev = await registerAnaDevice();
    await ws.hooks.onDeviceRegistered("ana", dev.id);

    const rooms = await db.query<{ id: string; hus: string }>(
      "select id, history_until_seq as hus from sa.chats where seed_key is not null order by id",
    );
    const adds = adminCalls.filter((c) => c.device_id === dev.id);
    expect(adds.map((c) => [c.chat_id, c.op, c.history_until_seq]).sort()).toEqual(
      rooms.map((r) => [r.id, "add", Number(r.hus)]).sort(),
    );

    const [mira] = await db.query<{ device_id: string }>(
      "select device_id from sa.seed_devices where user_id = 'mira'",
    );
    const held = await db.query<{ chat_id: string; epoch: number }>(
      `select chat_id, epoch from sa.agent_chat_keys where device_id = $1
       and chat_id in (select id from sa.chats where seed_key is not null)`,
      [mira?.device_id],
    );
    const sent = relay.log
      .filter((s) => s.env.kind === "key" && s.env.to_device === dev.id)
      .map((s) => ({ chat_id: s.env.chat_id, epoch: s.env.epoch, from: s.env.sender_device }));
    const order = (a: { chat_id: string; epoch: number }, b: { chat_id: string; epoch: number }) =>
      a.chat_id.localeCompare(b.chat_id) || a.epoch - b.epoch;
    expect(sent.map((s) => s.from)).toEqual(sent.map(() => mira?.device_id));
    expect(sent.map(({ chat_id, epoch }) => ({ chat_id, epoch })).sort(order)).toEqual(
      held.map((h) => ({ chat_id: h.chat_id, epoch: Number(h.epoch) })).sort(order),
    );
    expect(held.length).toBeGreaterThanOrEqual(4);
  });

  it("never gives agent devices, non-members or non-seed chats a history window (D-12)", async () => {
    const ws = await run();
    const dev = await registerAnaDevice();
    await ws.hooks.onDeviceRegistered("ana", dev.id);

    const agents = await agentDeviceIds();
    const toAgents = adminCalls.filter((c) => agents.includes(c.device_id));
    expect(toAgents.length).toBeGreaterThan(0);
    expect(toAgents.map((c) => c.history_until_seq)).toEqual(toAgents.map(() => undefined));
    expect(
      adminCalls.filter((c) => c.history_until_seq !== undefined && agents.includes(c.device_id)),
    ).toEqual([]);

    // a plain chat Ana is in, and a person with a device who is not in any seed room
    await db.query("insert into sa.users (id, display_name, pin_hash) values ('eve','Eve','x')");
    const eve = newDeviceKeys();
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user','eve',$2)",
      [deviceIdFor(eve.publicKey), eve.publicKey],
    );
    await db.query(
      "insert into sa.chats (id, title, kind, created_by) values ('plain','P','group','ana')",
    );
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('plain','user','ana','owner')",
    );
    const ops = await chatId("ops");
    const [opsAgent] = await db.query<{ id: string }>(
      "select id from sa.agents where roster_id = 'ops'",
    );

    const before = { admin: adminCalls.length, relay: relay.log.length };
    await ws.grant("plain", "ana"); // not a seed room
    await ws.grant(ops, "eve"); // not a member
    await ws.grant(ops, opsAgent?.id as string); // an agent, not a person
    expect({ admin: adminCalls.length, relay: relay.log.length }).toEqual(before);
  });
});
