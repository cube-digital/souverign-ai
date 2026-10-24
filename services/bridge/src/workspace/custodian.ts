import { ChatEngine, RelayClient, type RelayLink, type StoredDevice } from "@sa/client";
import { TICKET_TTL_MS } from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
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
 * The custodian's key store keeps a seed room's keys only while the room is being seeded (no
 * history window yet). Every epoch created after the window (the closing rotation, later member
 * rotations) is never stored, so the custodian cannot seal post-window keys to a late joiner.
 */
class CustodianKeyStore extends PgKeyStore {
  constructor(
    private pg: Db,
    device: StoredDevice,
  ) {
    super(pg, device, { encrypt, decrypt });
  }
  override async putChatKey(chatId: string, epoch: number, key: string): Promise<void> {
    const open = await this.pg.query(
      "select 1 from sa.chats where id = $1 and seed_key is not null and history_until_seq is null",
      [chatId],
    );
    if (open.length > 0) await super.putChatKey(chatId, epoch, key);
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
      getTicket: async () => signTicket(deps.adminToken, device.deviceId, TICKET_TTL_MS).ticket,
    });
    base = client;
    closeSocket = () => client.close();
    await Promise.race([client.connect(), new Promise((r) => setTimeout(r, 10_000))]).catch(
      () => {},
    );
  }
  const held = heldLink(base);
  const engine = new ChatEngine({
    link: held.link,
    store: custodian
      ? new CustodianKeyStore(deps.db, device)
      : new PgKeyStore(deps.db, device, { encrypt, decrypt }),
    device,
    isTrustedKeySender: humanMemberDevice(deps.db),
  });
  return {
    deviceId: device.deviceId,
    engine,
    lastSent: (chatId) => held.sent.get(chatId),
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
export function windowGuard(db: Db, relayAdmin: RelayAdmin): RelayAdmin {
  return {
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
}

/**
 * D-12 key custodian: Mira's device, started on every seed room, seals the room's epoch keys to
 * the devices of persons who are active members of a seed room, with the room's history window.
 * It holds only the epochs up to the window (see CustodianKeyStore), so that is all it can seal.
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

  /**
   * Issues a fresh chat key to every active member device but the custodian's own, which never
   * keeps it. Ends seeding (post-seed traffic is on a new epoch) and follows a bridge-side join.
   */
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

  /** Grants every device of `userId` in a seed room; a no-op unless the user is a person member. */
  async grant(chatId: string, userId: string): Promise<void> {
    await this.grantDevices(chatId, userId, null);
  }

  readonly hooks = {
    onDeviceRegistered: async (userId: string, deviceId: string): Promise<void> => {
      const rooms = await this.db.query<{ chat_id: string }>(
        `select m.chat_id from sa.chat_members m join sa.chats c on c.id = m.chat_id
         where m.member_type = 'user' and m.member_id = $1 and m.removed_at is null
           and c.seed_key is not null and c.history_until_seq is not null`,
        [userId],
      );
      for (const r of rooms) await this.grantDevices(r.chat_id, userId, deviceId);
    },
    onMemberAdded: (chatId: string, userId: string): Promise<void> => this.grant(chatId, userId),
  };

  private async grantDevices(chatId: string, userId: string, onlyDevice: string | null) {
    const [chat] = await this.db.query<{ hus: string | number }>(
      `select history_until_seq as hus from sa.chats
       where id = $1 and seed_key is not null and history_until_seq is not null`,
      [chatId],
    );
    if (!chat) return;
    // Person devices of an active person member only (seed colleagues and agents are excluded).
    const devices = await this.db.query<{ device_id: string; public_key: string }>(
      `select d.id as device_id, d.public_key from sa.devices d
       join sa.users u on u.id = d.owner_id and u.kind = 'person'
       join sa.chat_members m on m.chat_id = $1 and m.member_type = 'user'
         and m.member_id = u.id and m.removed_at is null
       where d.owner_type = 'user' and d.owner_id = $2 and ($3::text is null or d.id = $3)
         and not exists (select 1 from sa.agent_devices ad where ad.device_id = d.id)
         and not exists (select 1 from sa.seed_devices sd where sd.device_id = d.id)`,
      [chatId, userId, onlyDevice],
    );
    const historyUntilSeq = Number(chat.hus);
    for (const d of devices) {
      try {
        await this.relayAdmin.setMember({
          chat_id: chatId,
          device_id: d.device_id,
          op: "add",
          history_until_seq: historyUntilSeq,
        });
        const keys = await this.mira.engine.shareEpochs(chatId, d);
        this.log("seed room granted", { chat: chatId, device: d.device_id, keys });
      } catch (e) {
        this.log("seed room grant failed", {
          chat: chatId,
          device: d.device_id,
          error: (e as Error).name,
        });
      }
    }
  }

  close(): void {
    this.mira.close();
  }
}
