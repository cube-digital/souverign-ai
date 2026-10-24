import { ChatEngine, RelayClient, type RelayLink, type StoredDevice } from "@sa/client";
import { randomId, sealKey } from "@sa/crypto";
import type { DevicePublic } from "@sa/protocol";
import { PgKeyStore } from "../agents/pg-keystore.js";
import { decrypt, encrypt } from "../agents/secrets.js";
import type { Db } from "../db.js";
import type { Log, PluginContext } from "../plugin-api.js";
import type { RelayAdmin } from "../relay-admin.js";

export type WorkspaceDeps = PluginContext & {
  /** Test seam (as in AgentHost): replaces the relay websocket. */
  linkFactory?: (deviceId: string) => RelayLink;
};

/** A bridge-held device (seed colleague or agent) with its engine on a `PgKeyStore`. */
export type HeldEngine = {
  deviceId: string;
  engine: ChatEngine;
  /** id and seq of the last "msg" envelope this device sent in the chat */
  lastSent(chatId: string): { id: string; seq: number } | undefined;
  /** Seals one epoch key this device holds to `device`; false when it holds none. */
  sealEpoch(chatId: string, epoch: number, device: DevicePublic): Promise<boolean>;
  /** Stops all deliveries to the engine and closes the socket. */
  close(): void;
};

/**
 * Wraps a link so the engine can be shut off (an in-memory link has no close) and so the seeder
 * learns the id and seq of every message it posts.
 */
function heldLink(base: RelayLink) {
  let closed = false;
  const offs: Array<() => void> = [];
  const sent = new Map<string, { id: string; seq: number }>();
  const link: RelayLink = {
    async send(env) {
      if (closed) throw new Error("closed");
      const seq = await base.send(env);
      if (env.kind === "msg") sent.set(env.chat_id, { id: env.id, seq });
      return seq;
    },
    sync: (chatId, since) => {
      if (!closed) base.sync(chatId, since);
    },
    putBlob: (id, chatId, data) => base.putBlob(id, chatId, data),
    getBlob: (id) => base.getBlob(id),
    signal: (env) => {
      if (!closed) base.signal(env);
    },
    onSignal(cb) {
      const off = base.onSignal((env) => {
        if (!closed) cb(env);
      });
      offs.push(off);
      return off;
    },
    onDeliver(cb) {
      const off = base.onDeliver((seq, env) => {
        if (!closed) cb(seq, env);
      });
      offs.push(off);
      return off;
    },
    onReconnect(cb) {
      const off =
        base.onReconnect?.(() => {
          if (!closed) cb();
        }) ?? (() => {});
      offs.push(off);
      return off;
    },
  };
  const shut = () => {
    closed = true;
    for (const off of offs.splice(0)) off();
  };
  return { link, sent, shut };
}

/** Key trust as everywhere else: the sender device belongs to an active human member of the chat. */
export const humanMemberDevice =
  (db: Db) =>
  async (chatId: string, senderDevice: string): Promise<boolean> =>
    (
      await db.query(
        `select 1 from sa.devices d
         join sa.chat_members m on m.member_type = 'user' and m.member_id = d.owner_id
         where d.owner_type = 'user' and d.id = $1 and m.chat_id = $2 and m.removed_at is null`,
        [senderDevice, chatId],
      )
    ).length > 0;

/**
 * The epoch every seed room's history is posted on (`history_until_epoch`): a seed room is always a
 * fresh chat whose first and only epoch claim during seeding returns 1 (seedRoom asserts this).
 * Late joiners are sealed only epochs up to this one.
 */
export const SEED_HISTORY_EPOCH = 1;

/**
 * The custodian's key store keeps the history epochs and only the newest live epoch (the one it
 * last issued or received); older live epochs are dropped, so it never holds traffic keys between
 * the window and the current key.
 */
class CustodianKeyStore extends PgKeyStore {
  constructor(
    private pg: Db,
    private own: StoredDevice,
  ) {
    super(pg, own, { encrypt, decrypt });
  }
  override async putChatKey(chatId: string, epoch: number, key: string): Promise<void> {
    if (epoch <= SEED_HISTORY_EPOCH) return super.putChatKey(chatId, epoch, key);
    if ((await this.latestEpoch(chatId)) > epoch) return;
    await super.putChatKey(chatId, epoch, key);
    await this.pg.query(
      `delete from sa.agent_chat_keys
       where device_id = $1 and chat_id = $2 and epoch > $3 and epoch < $4`,
      [this.own.deviceId, chatId, SEED_HISTORY_EPOCH, epoch],
    );
  }
}

export async function openHeldEngine(
  deps: WorkspaceDeps,
  device: StoredDevice,
  { custodian = false }: { custodian?: boolean } = {},
): Promise<HeldEngine> {
  let base: RelayLink;
  let closeSocket = () => {};
  if (deps.linkFactory) {
    base = deps.linkFactory(device.deviceId);
  } else {
    const url = `${deps.relayInternalUrl.replace(/^http/, "ws").replace(/\/$/, "")}/relay/ws`;
    const client = new RelayClient({
      url,
      deviceId: device.deviceId,
      getTicket: () => deps.ticketFor(device.deviceId),
    });
    base = client;
    closeSocket = () => client.close();
    await Promise.race([client.connect(), new Promise((r) => setTimeout(r, 10_000))]).catch(
      () => {},
    );
  }
  const held = heldLink(base);
  const store = custodian
    ? new CustodianKeyStore(deps.db, device)
    : new PgKeyStore(deps.db, device, { encrypt, decrypt });
  const engine = new ChatEngine({
    link: held.link,
    store,
    device,
    isTrustedKeySender: humanMemberDevice(deps.db),
  });
  return {
    deviceId: device.deviceId,
    engine,
    lastSent: (chatId) => held.sent.get(chatId),
    async sealEpoch(chatId, epoch, to) {
      const key = await store.getChatKey(chatId, epoch);
      if (!key) return false;
      await held.link.send({
        v: 1,
        id: randomId(),
        chat_id: chatId,
        sender_device: device.deviceId,
        to_device: to.device_id,
        epoch,
        kind: "key",
        nonce: "",
        ciphertext: sealKey(key, to.public_key),
        ts: Date.now(),
      });
      return true;
    },
    close: () => {
      held.shut();
      closeSocket();
    },
  };
}

/**
 * D-12 guard: a relay add carries `history_until_seq` only for a person's device (never an agent
 * or seed colleague device) that is an active member of a seed room, and only with that room's
 * own window. Anything else is refused before it reaches the relay.
 */
const guarded = new WeakSet<RelayAdmin>();

/**
 * Wraps a RelayAdmin once (wrapping an already guarded one returns it unchanged), so the bridge
 * can guard its raw relay admin at startup and the custodian can rely on it either way.
 */
export function windowGuard(db: Db, relayAdmin: RelayAdmin): RelayAdmin {
  if (guarded.has(relayAdmin)) return relayAdmin;
  const wrapped: RelayAdmin = {
    async setMember(change) {
      if (change.history_until_seq !== undefined) {
        const ok = await db.query(
          `select 1 from sa.devices d
           join sa.users u on u.id = d.owner_id and u.kind = 'person'
           join sa.chat_members m on m.member_type = 'user' and m.member_id = u.id
             and m.removed_at is null
           join sa.chats c on c.id = m.chat_id and c.seed_key is not null
             and c.history_until_seq = $3
           where d.id = $1 and d.owner_type = 'user' and m.chat_id = $2 and $4 = 'add'
             and not exists (select 1 from sa.agent_devices ad where ad.device_id = d.id)
             and not exists (select 1 from sa.seed_devices sd where sd.device_id = d.id)`,
          [change.device_id, change.chat_id, change.history_until_seq, change.op],
        );
        if (ok.length === 0) throw new Error("history_window_refused");
      }
      await relayAdmin.setMember(change);
    },
  };
  guarded.add(wrapped);
  return wrapped;
}

/**
 * D-12 key custodian: Mira's device, started on every seed room. It gives a person's devices the
 * room's history window and the history epoch keys (never later ones), then rotates the room to a
 * fresh epoch for every current member device, so the person reads live traffic from now on.
 * Nothing is ever granted to agent devices, seed colleagues, non-members or non-seed chats.
 */
export class Custodian {
  private relayAdmin: RelayAdmin;

  constructor(
    private db: Db,
    relayAdmin: RelayAdmin,
    private mira: HeldEngine,
    private log: Log,
  ) {
    this.relayAdmin = windowGuard(db, relayAdmin);
  }

  /** Issues a fresh chat key to every active member device but the custodian's own. */
  async rotate(chatId: string): Promise<number> {
    const [claim] = await this.db.query<{ key_epoch: number }>(
      "update sa.chats set key_epoch = greatest(key_epoch + 1, $2) where id = $1 returning key_epoch",
      [chatId, (await this.mira.engine.latestEpoch(chatId)) + 1],
    );
    const devices = await this.db.query<{ device_id: string; public_key: string }>(
      `select d.id as device_id, d.public_key from sa.chat_members m
       join sa.devices d on d.owner_id = m.member_id
         and d.owner_type = (case when m.member_type = 'agent' then 'agent' else 'user' end)
       where m.chat_id = $1 and m.removed_at is null and d.id <> $2`,
      [chatId, this.mira.deviceId],
    );
    const epoch = await this.mira.engine.createEpoch(chatId, devices, Number(claim?.key_epoch));
    this.log("seed room key rotated", { chat: chatId, epoch, devices: devices.length });
    return epoch;
  }

  /** Grants every device of `userId` in a seed room, then rotates; a no-op for non-persons. */
  async grant(chatId: string, userId: string): Promise<void> {
    if ((await this.grantDevices(chatId, userId, null)) > 0) await this.rotate(chatId);
  }

  readonly hooks = {
    onDeviceRegistered: async (userId: string, deviceId: string): Promise<void> => {
      for (const chatId of await this.seedRooms(userId)) {
        try {
          if ((await this.grantDevices(chatId, userId, deviceId)) > 0) await this.rotate(chatId);
        } catch (e) {
          this.log("seed room grant failed", { chat: chatId, error: (e as Error).message });
        }
      }
    },
    onMemberAdded: async (chatId: string, userId: string): Promise<void> => {
      try {
        await this.grant(chatId, userId);
      } catch (e) {
        this.log("seed room grant failed", { chat: chatId, error: (e as Error).message });
      }
    },
  };

  /**
   * Boot pass (idempotent): re-grants every active person device of every seed room, so a failed
   * grant is retried, and rotates a room when it granted anything or its live key is still the
   * history epoch (a closing rotation that never happened).
   */
  async reconcile(): Promise<void> {
    for (const chatId of await this.seedRooms(null)) {
      try {
        const granted = await this.grantDevices(chatId, null, null);
        const stale = (await this.mira.engine.latestEpoch(chatId)) <= SEED_HISTORY_EPOCH;
        if (granted > 0 || stale) await this.rotate(chatId);
      } catch (e) {
        this.log("seed room reconcile failed", { chat: chatId, error: (e as Error).message });
      }
    }
  }

  /** Seed rooms with a history window, optionally only those the person is an active member of. */
  private async seedRooms(userId: string | null): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `select c.id from sa.chats c
       where c.seed_key is not null and c.history_until_seq is not null
         and ($1::text is null or exists (select 1 from sa.chat_members m
           where m.chat_id = c.id and m.member_type = 'user' and m.member_id = $1
             and m.removed_at is null))
       order by c.id`,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  /** Window + history epochs to person devices (all person members when userId is null). */
  private async grantDevices(
    chatId: string,
    userId: string | null,
    onlyDevice: string | null,
  ): Promise<number> {
    const [chat] = await this.db.query<{ hus: string | number }>(
      `select history_until_seq as hus from sa.chats
       where id = $1 and seed_key is not null and history_until_seq is not null`,
      [chatId],
    );
    if (!chat) return 0;
    // Person devices of an active person member only (seed colleagues and agents are excluded).
    const devices = await this.db.query<{ device_id: string; public_key: string }>(
      `select d.id as device_id, d.public_key from sa.devices d
       join sa.users u on u.id = d.owner_id and u.kind = 'person'
       join sa.chat_members m on m.chat_id = $1 and m.member_type = 'user'
         and m.member_id = u.id and m.removed_at is null
       where d.owner_type = 'user' and ($2::text is null or d.owner_id = $2)
         and ($3::text is null or d.id = $3)
         and not exists (select 1 from sa.agent_devices ad where ad.device_id = d.id)
         and not exists (select 1 from sa.seed_devices sd where sd.device_id = d.id)
       order by d.id`,
      [chatId, userId, onlyDevice],
    );
    const historyUntilSeq = Number(chat.hus);
    let granted = 0;
    for (const d of devices) {
      try {
        await this.relayAdmin.setMember({
          chat_id: chatId,
          device_id: d.device_id,
          op: "add",
          history_until_seq: historyUntilSeq,
        });
        let keys = 0;
        for (let epoch = 1; epoch <= SEED_HISTORY_EPOCH; epoch++) {
          if (await this.mira.sealEpoch(chatId, epoch, d)) keys++;
        }
        granted++;
        this.log("seed room granted", { chat: chatId, device: d.device_id, keys });
      } catch (e) {
        this.log("seed room grant failed", {
          chat: chatId,
          device: d.device_id,
          error: (e as Error).message,
        });
      }
    }
    return granted;
  }

  close(): void {
    this.mira.close();
  }
}
