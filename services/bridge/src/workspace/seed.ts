import { randomBytes } from "node:crypto";
import type { ChatEngine, StoredDevice } from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import { ROSTER, type RosterId, SEED_CHANNELS } from "@sa/protocol";
import { decrypt, encrypt } from "../agents/secrets.js";
import type { Db } from "../db.js";
import { waitForRelay } from "../relay-ready.js";
import { Custodian, type HeldEngine, openHeldEngine, type WorkspaceDeps } from "./custodian.js";
import { SEED_HISTORY, SEED_USERS, type SeedUserId } from "./seed-data.js";

export type { WorkspaceDeps } from "./custodian.js";

export type Workspace = {
  grant(chatId: string, userId: string): Promise<void>;
  hooks: {
    onDeviceRegistered(userId: string, deviceId: string): Promise<void>;
    onMemberAdded(chatId: string, userId: string): Promise<void>;
  };
  close(): void;
};

export const NOOP_WORKSPACE: Workspace = {
  grant: async () => {},
  hooks: { onDeviceRegistered: async () => {}, onMemberAdded: async () => {} },
  close: () => {},
};

const KEY_WAIT_MS = 15_000;
const newId = () => randomBytes(9).toString("base64url");

type KeyRow = { device_id: string; public_key: string; enc_secret_key: string };
const toDevice = (r: KeyRow): StoredDevice => ({
  deviceId: r.device_id,
  keys: { publicKey: r.public_key, secretKey: decrypt(r.enc_secret_key) },
});

async function ensureSeedUsers(db: Db): Promise<Map<SeedUserId, StoredDevice>> {
  const out = new Map<SeedUserId, StoredDevice>();
  for (const u of SEED_USERS) {
    await db.query(
      `insert into sa.users (id, display_name, pin_hash, kind) values ($1, $2, 'disabled', 'seed')
       on conflict (id) do update set display_name = excluded.display_name,
         pin_hash = 'disabled', kind = 'seed'`,
      [u.id, u.name],
    );
    const select = () =>
      db.query<KeyRow>(
        `select sd.device_id, dv.public_key, sd.enc_secret_key from sa.seed_devices sd
         join sa.devices dv on dv.id = sd.device_id where sd.user_id = $1`,
        [u.id],
      );
    let [row] = await select();
    if (!row) {
      const keys = newDeviceKeys();
      const deviceId = deviceIdFor(keys.publicKey);
      await db.query(
        "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'user', $2, $3)",
        [deviceId, u.id, keys.publicKey],
      );
      await db.query(
        "insert into sa.seed_devices (device_id, user_id, enc_secret_key) values ($1, $2, $3)",
        [deviceId, u.id, encrypt(keys.secretKey)],
      );
      [row] = await select();
    }
    if (!row) throw new Error("seed device missing");
    out.set(u.id, toDevice(row));
  }
  return out;
}

type HeldAgent = { agentId: string; device: StoredDevice };

async function ensureRosterAgents(db: Db): Promise<Map<RosterId, HeldAgent>> {
  const out = new Map<RosterId, HeldAgent>();
  for (const r of ROSTER) {
    await db.query(
      `insert into sa.agents (id, owner_user_id, name, template, soul, scope, roster_id)
       values ($1, null, $2, $3, '', 'workspace', $4) on conflict (roster_id) do nothing`,
      [newId(), r.name, r.template, r.id],
    );
    const [agent] = await db.query<{ id: string }>(
      "select id from sa.agents where roster_id = $1",
      [r.id],
    );
    if (!agent) throw new Error("roster agent missing");
    const select = () =>
      db.query<KeyRow>(
        `select ad.device_id, dv.public_key, ad.enc_secret_key from sa.agent_devices ad
         join sa.devices dv on dv.id = ad.device_id where ad.agent_id = $1`,
        [agent.id],
      );
    let [row] = await select();
    if (!row) {
      const keys = newDeviceKeys();
      const deviceId = deviceIdFor(keys.publicKey);
      await db.query(
        "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, 'agent', $2, $3)",
        [deviceId, agent.id, keys.publicKey],
      );
      await db.query(
        "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ($1, $2, $3)",
        [deviceId, agent.id, encrypt(keys.secretKey)],
      );
      [row] = await select();
    }
    if (!row) throw new Error("agent device missing");
    out.set(r.id, { agentId: agent.id, device: toDevice(row) });
  }
  return out;
}

async function waitForKey(engine: ChatEngine, chatId: string, epoch: number): Promise<void> {
  const deadline = Date.now() + KEY_WAIT_MS;
  while ((await engine.latestEpoch(chatId)) < epoch) {
    if (Date.now() > deadline) throw new Error("chat key not received");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Removes a seed room left half-made by an earlier failed start (no history window yet). */
async function dropUnfinished(db: Db, seedKey: string): Promise<void> {
  const rows = await db.query<{ id: string }>(
    "select id from sa.chats where seed_key = $1 and history_until_seq is null",
    [seedKey],
  );
  for (const { id } of rows) {
    await db.query("delete from sa.chat_members where chat_id = $1", [id]);
    await db.query("delete from sa.agent_chat_keys where chat_id = $1", [id]);
    await db.query("delete from sa.agent_cursors where chat_id = $1", [id]);
    await db.query("delete from sa.chats where id = $1", [id]);
  }
}

type SeedCtx = {
  deps: WorkspaceDeps;
  mira: HeldEngine;
  seeds: Map<SeedUserId, StoredDevice>;
  agents: Map<RosterId, HeldAgent>;
  custodian: Custodian;
};

async function seedRoom(ctx: SeedCtx, channel: (typeof SEED_CHANNELS)[number]): Promise<void> {
  const { deps, mira, seeds, agents, custodian } = ctx;
  const { db, relayAdmin } = deps;
  const chatId = newId();
  const roomAgents = ROSTER.filter((r) => r.channels.includes(channel.key)).map((r) => {
    const a = agents.get(r.id);
    if (!a) throw new Error("roster agent missing");
    return [r.id, a] as const;
  });

  await db.query(
    `insert into sa.chats (id, title, kind, created_by, topic, seed_key)
     values ($1, $2, 'room', 'mira', $3, $4)`,
    [chatId, channel.title, channel.topic, channel.key],
  );
  await db.query(
    `insert into sa.chat_members (chat_id, member_type, member_id, role)
     select $1, 'user', id, case when id = 'mira' then 'owner' else 'member' end
     from sa.users where kind = 'person' or id = any($2::text[])`,
    [chatId, SEED_USERS.map((u) => u.id)],
  );
  for (const [, a] of roomAgents) {
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ($1, 'agent', $2, 'member')",
      [chatId, a.agentId],
    );
  }

  // Seed colleagues and agents join before the first message, so they read it as live traffic;
  // none of them gets a history window (D-12).
  const others = [
    ...[...seeds].filter(([id]) => id !== "mira").map(([, d]) => d),
    ...roomAgents.map(([, a]) => a.device),
  ];
  for (const d of [mira.deviceId, ...others.map((o) => o.deviceId)]) {
    await relayAdmin.setMember({ chat_id: chatId, device_id: d, op: "add" });
  }
  await mira.engine.start([chatId]);
  const [claim] = await db.query<{ key_epoch: number }>(
    "update sa.chats set key_epoch = greatest(key_epoch + 1, $2) where id = $1 returning key_epoch",
    [chatId, (await mira.engine.latestEpoch(chatId)) + 1],
  );
  const epoch = await mira.engine.createEpoch(
    chatId,
    others.map((d) => ({ device_id: d.deviceId, public_key: d.keys.publicKey })),
    Number(claim?.key_epoch),
  );
  await mira.engine.sendSystem(chatId, "Mira created this channel");

  const authors = new Map<string, HeldEngine>([["mira", mira]]);
  const temporary: HeldEngine[] = [];
  const ids: string[] = [];
  let lastSeq = 0;
  try {
    const now = Date.now();
    for (const m of SEED_HISTORY[channel.key]) {
      const isAgent = !seeds.has(m.author as SeedUserId);
      let author = authors.get(m.author);
      if (!author) {
        const device = isAgent
          ? roomAgents.find(([id]) => id === m.author)?.[1].device
          : seeds.get(m.author as SeedUserId);
        if (!device) throw new Error("seed author is not a member");
        author = await openHeldEngine(deps, device);
        temporary.push(author);
        authors.set(m.author, author);
        await author.engine.start([chatId]);
        await waitForKey(author.engine, chatId, epoch);
      }
      const replyTo = m.replyTo === undefined ? undefined : ids[m.replyTo];
      if (m.replyTo !== undefined && !replyTo) throw new Error("seed reply without root");
      await author.engine.sendText(
        chatId,
        m.text,
        // D-12: seeded agent posts carry no fabricated receipts
        isAgent ? { seeded: true } : undefined,
        { ts: now - m.minutesAgo * 60_000, ...(replyTo ? { replyTo } : {}) },
      );
      const sent = author.lastSent(chatId);
      if (!sent) throw new Error("seed message not sent");
      ids.push(sent.id);
      lastSeq = Math.max(lastSeq, sent.seq);
    }
  } finally {
    for (const t of temporary) t.close();
  }

  await db.query("update sa.chats set history_until_seq = $2 where id = $1", [chatId, lastSeq]);
  deps.log("seed room created", { chat: chatId, seed_key: channel.key, messages: ids.length });

  const persons = await db.query<{ member_id: string }>(
    `select m.member_id from sa.chat_members m join sa.users u on u.id = m.member_id
     where m.chat_id = $1 and m.member_type = 'user' and u.kind = 'person'`,
    [chatId],
  );
  for (const p of persons) await custodian.grant(chatId, p.member_id);
  // The window is closed: everything after it is on a fresh epoch the custodian never holds.
  await custodian.rotate(chatId);
}

/**
 * D-12 seeded workspace. Every step is idempotent: a later start creates and sends nothing,
 * apart from adding and granting persons created since.
 */
export async function ensureWorkspace(deps: WorkspaceDeps): Promise<Workspace> {
  const { db, log } = deps;
  if (!(await waitForRelay(deps.relayInternalUrl))) {
    log("workspace seed skipped", { reason: "relay_unavailable" });
    return NOOP_WORKSPACE;
  }
  await cryptoReady();
  const seeds = await ensureSeedUsers(db);
  const agents = await ensureRosterAgents(db);
  const miraDevice = seeds.get("mira");
  if (!miraDevice) throw new Error("seed device missing");
  const mira = await openHeldEngine(deps, miraDevice, { custodian: true });
  const custodian = new Custodian(db, deps.relayAdmin, mira, log);

  try {
    const done = await db.query<{ id: string; seed_key: string }>(
      "select id, seed_key from sa.chats where seed_key is not null and history_until_seq is not null",
    );
    await mira.engine.start(done.map((r) => r.id));
    for (const channel of SEED_CHANNELS) {
      if (done.some((r) => r.seed_key === channel.key)) continue;
      await dropUnfinished(db, channel.key);
      await seedRoom({ deps, mira, seeds, agents, custodian }, channel);
    }

    // Persons created after seeding (`make seed`) join every seed room and get its history.
    const rooms = await db.query<{ id: string }>(
      "select id from sa.chats where seed_key is not null and history_until_seq is not null",
    );
    for (const room of rooms) {
      const added = await db.query<{ member_id: string }>(
        `insert into sa.chat_members (chat_id, member_type, member_id, role)
         select $1, 'user', u.id, 'member' from sa.users u
         where u.kind = 'person' and not exists (
           select 1 from sa.chat_members m
           where m.chat_id = $1 and m.member_type = 'user' and m.member_id = u.id)
         returning member_id`,
        [room.id],
      );
      if (added.length === 0) continue;
      for (const a of added) await custodian.grant(room.id, a.member_id);
      // Joining still issues a new chat key (D-12), as when a member adds a person in the web.
      await custodian.rotate(room.id);
      log("seed room members added", { chat: room.id, added: added.length });
    }
  } catch (e) {
    log("workspace seed failed", { error: (e as Error).message });
  }
  return custodian;
}
