import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatEngine, type ChatMessage } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { RelayMemberChange } from "@sa/protocol";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { PgKeyStore } from "../src/agents/pg-keystore.js";
import { decrypt, encrypt } from "../src/agents/secrets.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { ensureWorkspace } from "../src/workspace/seed.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

let http: Server;
let relayUrl: string;
let db: Db;
let relay: FakeRelay;
const closers: Array<() => void> = [];

beforeAll(async () => {
  await cryptoReady();
  http = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return () => http.close();
});

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')", []);
  relay = new FakeRelay();
});

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await db.close();
});

async function start() {
  const ws = await ensureWorkspace({
    db,
    relayAdmin: {
      setMember: async (c: RelayMemberChange) => {
        if (c.op === "add") relay.addMember(c.chat_id, c.device_id);
      },
    },
    relayInternalUrl: relayUrl,
    ticketFor: async () => "t",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: { onAgentAdded: async () => {}, onAgentRemoved: async () => {} },
    log: () => {},
    linkFactory: (deviceId: string) => relay.link(deviceId),
  });
  closers.push(() => ws.close());
  return ws;
}

const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params))[0] as T;
const miraDevice = async () =>
  (await one<{ device_id: string }>("select device_id from sa.seed_devices where user_id = 'mira'"))
    .device_id;
const miraEpochs = async (chatId: string) =>
  (
    await db.query<{ epoch: number }>(
      "select epoch from sa.agent_chat_keys where device_id = $1 and chat_id = $2 order by epoch",
      [await miraDevice(), chatId],
    )
  ).map((r) => Number(r.epoch));
const room = (key: string) =>
  one<{ id: string }>("select id from sa.chats where seed_key = $1", [key]).then((r) => r?.id);

it("a later start finishes a room whose closing rotation failed", async () => {
  await start();
  const ops = (await room("ops")) as string;
  const sales = (await room("sales")) as string;
  // #ops: done, but its live key is still the history epoch (rotation lost after the window)
  await db.query(
    "delete from sa.agent_chat_keys where device_id = $1 and chat_id = $2 and epoch > 1",
    [await miraDevice(), ops],
  );
  // #sales: the rotation failed before the room was marked done
  await db.query("update sa.chats set history_until_seq = null where id = $1", [sales]);
  closers.pop()?.();
  const before = relay.log.length;

  await start();
  const rotated = relay.log
    .slice(before)
    .filter((s) => s.env.kind === "key" && s.env.chat_id === ops)
    .map((s) => s.env.epoch);
  expect(rotated.length).toBeGreaterThan(0);
  expect(new Set(rotated)).toEqual(new Set([3]));
  expect(await miraEpochs(ops)).toEqual([1, 3]);

  const reseeded = (await room("sales")) as string;
  expect(reseeded).not.toBe(sales);
  const done = await one<{ hus: string | null }>(
    "select history_until_seq as hus from sa.chats where id = $1",
    [reseeded],
  );
  expect(done.hus).not.toBeNull();
  expect(await miraEpochs(reseeded)).toEqual([1, 2]);
});

it("a person who registers after seeding reads live traffic right away", async () => {
  const ws = await start();
  const ops = (await room("ops")) as string;
  const keys = newDeviceKeys();
  const ana = { deviceId: deviceIdFor(keys.publicKey), keys };
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user','ana',$2)",
    [ana.deviceId, keys.publicKey],
  );
  await ws.hooks.onDeviceRegistered("ana", ana.deviceId);

  const anaEngine = new ChatEngine({
    link: relay.link(ana.deviceId),
    store: new PgKeyStore(db, ana, { encrypt, decrypt }),
    device: ana,
  });
  const seen: ChatMessage[] = [];
  anaEngine.onMessage((m) => seen.push(m));
  await anaEngine.start([ops]);

  // the ops agent posts on the room's current epoch, after Ana's grant
  const row = await one<{ device_id: string; public_key: string; enc: string }>(
    `select ad.device_id, dv.public_key, ad.enc_secret_key as enc from sa.agents a
     join sa.agent_devices ad on ad.agent_id = a.id join sa.devices dv on dv.id = ad.device_id
     where a.roster_id = 'ops'`,
  );
  const agent = {
    deviceId: row.device_id,
    keys: { publicKey: row.public_key, secretKey: decrypt(row.enc) },
  };
  const opsEngine = new ChatEngine({
    link: relay.link(agent.deviceId),
    store: new PgKeyStore(db, agent, { encrypt, decrypt }),
    device: agent,
  });
  await opsEngine.start([ops]);
  await vi.waitFor(async () => expect(await opsEngine.latestEpoch(ops)).toBe(3));
  await opsEngine.sendText(ops, "node-3 cleanup finished");

  await vi.waitFor(() =>
    expect(seen.find((m) => m.epoch === 3)).toMatchObject({
      status: "ok",
      body: { type: "text", text: "node-3 cleanup finished" },
    }),
  );
  expect(await anaEngine.latestEpoch(ops)).toBe(3);
});
