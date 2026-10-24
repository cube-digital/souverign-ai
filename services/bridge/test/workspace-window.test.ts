import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatEngine } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { RelayMemberChange } from "@sa/protocol";
import { expect, it, vi } from "vitest";
import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { PgKeyStore } from "../src/agents/pg-keystore.js";
import { decrypt, encrypt } from "../src/agents/secrets.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { windowGuard } from "../src/workspace/custodian.js";
import { ensureWorkspace } from "../src/workspace/seed.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

it("seals the history epoch, never older live ones, to a late device and refuses any other window", {
  timeout: 20_000,
}, async () => {
  await cryptoReady();
  const http = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')", []);
  const relay = new FakeRelay();
  const calls: RelayMemberChange[] = [];
  const relayAdmin = {
    setMember: async (c: RelayMemberChange) => {
      calls.push(c);
      if (c.op === "add") relay.addMember(c.chat_id, c.device_id);
    },
  };
  const ws = await ensureWorkspace({
    db,
    relayAdmin,
    relayInternalUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    ticketFor: async () => "t",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: { onAgentAdded: async () => {}, onAgentRemoved: async () => {} },
    log: () => {},
    linkFactory: (deviceId: string) => relay.link(deviceId),
  });
  try {
    const [room] = await db.query<{ id: string; hus: string }>(
      "select id, history_until_seq as hus from sa.chats where seed_key = 'ops'",
      [],
    );
    const chat = room?.id as string;
    const hus = Number(room?.hus);
    const [mira] = await db.query<{ device_id: string }>(
      "select device_id from sa.seed_devices where user_id = 'mira'",
      [],
    );
    const epochsHeld = async (deviceId: string) =>
      (
        await db.query<{ epoch: number }>(
          "select epoch from sa.agent_chat_keys where device_id = $1 and chat_id = $2 order by epoch",
          [deviceId, chat],
        )
      ).map((r) => Number(r.epoch));

    // Seeding ended with a rotation: members read epoch 2; the custodian holds history + current.
    const [agent] = await db.query<{ device_id: string; public_key: string; enc: string }>(
      `select ad.device_id, dv.public_key, ad.enc_secret_key as enc from sa.agents a
       join sa.agent_devices ad on ad.agent_id = a.id join sa.devices dv on dv.id = ad.device_id
       where a.roster_id = 'ops'`,
      [],
    );
    const device = {
      deviceId: agent?.device_id as string,
      keys: { publicKey: agent?.public_key as string, secretKey: decrypt(agent?.enc as string) },
    };
    const engine = new ChatEngine({
      link: relay.link(device.deviceId),
      store: new PgKeyStore(db, device, { encrypt, decrypt }),
      device,
    });
    await engine.start([chat]);
    await vi.waitFor(async () => expect(await epochsHeld(device.deviceId)).toEqual([1, 2]));
    expect(await epochsHeld(mira?.device_id as string)).toEqual([1, 2]);

    // A person's new device gets the window and the history epoch, then a fresh epoch 3, never 2.
    const keys = newDeviceKeys();
    const anaDevice = deviceIdFor(keys.publicKey);
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user','ana',$2)",
      [anaDevice, keys.publicKey],
    );
    await ws.hooks.onDeviceRegistered("ana", anaDevice);
    const toAna = relay.log.filter(
      (s) => s.env.kind === "key" && s.env.to_device === anaDevice && s.env.chat_id === chat,
    );
    expect(toAna.map((s) => s.env.epoch)).toEqual([1, 3]);
    expect(await epochsHeld(mira?.device_id as string)).toEqual([1, 3]);

    // The guard passes a window only for a person member device in a seed room, at its own seq.
    await db.query(
      "insert into sa.chats (id, title, kind, created_by) values ('plainchat','P','group','ana')",
      [],
    );
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('plainchat','user','ana','owner')",
      [],
    );
    const guarded = windowGuard(db, relayAdmin);
    const add = (chat_id: string, device_id: string, history_until_seq: number) =>
      guarded.setMember({ chat_id, device_id, op: "add", history_until_seq });
    const before = calls.length;
    await expect(add(chat, device.deviceId, hus)).rejects.toThrow("history_window_refused");
    await expect(add(chat, mira?.device_id as string, hus)).rejects.toThrow(
      "history_window_refused",
    );
    await expect(add("plainchat", anaDevice, 1)).rejects.toThrow("history_window_refused");
    await expect(add(chat, anaDevice, hus + 50)).rejects.toThrow("history_window_refused");
    expect(calls.length).toBe(before);
    await add(chat, anaDevice, hus);
    expect(calls.length).toBe(before + 1);
  } finally {
    ws.close();
    await db.close();
    http.close();
  }
});
