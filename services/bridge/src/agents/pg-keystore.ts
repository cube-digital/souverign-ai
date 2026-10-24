import type { KeyStore, StoredDevice } from "@sa/client";
import type { Db } from "../db.js";

/** KeyStore for an agent device over `sa.agent_chat_keys` (keys encrypted) and `sa.agent_cursors`. */
export class PgKeyStore implements KeyStore {
  constructor(
    private db: Db,
    private device: StoredDevice,
    private seal: { encrypt(text: string): string; decrypt(blob: string): string },
  ) {}

  async getDevice(): Promise<StoredDevice | null> {
    return this.device;
  }
  async putDevice(d: StoredDevice): Promise<void> {
    this.device = d;
  }
  async getChatKey(chatId: string, epoch: number): Promise<string | null> {
    const [row] = await this.db.query<{ key_enc: string }>(
      "select key_enc from sa.agent_chat_keys where device_id = $1 and chat_id = $2 and epoch = $3",
      [this.device.deviceId, chatId, epoch],
    );
    return row ? this.seal.decrypt(row.key_enc) : null;
  }
  async putChatKey(chatId: string, epoch: number, key: string): Promise<void> {
    await this.db.query(
      `insert into sa.agent_chat_keys (device_id, chat_id, epoch, key_enc) values ($1, $2, $3, $4)
       on conflict (device_id, chat_id, epoch) do update set key_enc = excluded.key_enc`,
      [this.device.deviceId, chatId, epoch, this.seal.encrypt(key)],
    );
  }
  async latestEpoch(chatId: string): Promise<number> {
    const [row] = await this.db.query<{ epoch: number | null }>(
      "select max(epoch) as epoch from sa.agent_chat_keys where device_id = $1 and chat_id = $2",
      [this.device.deviceId, chatId],
    );
    return Number(row?.epoch ?? 0);
  }
  async getCursor(chatId: string): Promise<number> {
    const [row] = await this.db.query<{ seq: string | number }>(
      "select seq from sa.agent_cursors where device_id = $1 and chat_id = $2",
      [this.device.deviceId, chatId],
    );
    return Number(row?.seq ?? 0);
  }
  async putCursor(chatId: string, seq: number): Promise<void> {
    await this.db.query(
      `insert into sa.agent_cursors (device_id, chat_id, seq) values ($1, $2, $3)
       on conflict (device_id, chat_id) do update set seq = excluded.seq`,
      [this.device.deviceId, chatId, seq],
    );
  }
}
