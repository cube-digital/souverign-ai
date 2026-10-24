import type { KeyStore, StoredDevice } from "@sa/client";
import { type IDBPDatabase, openDB } from "idb";

const DEVICE_KEY = "device";

/** KeyStore over IndexedDB, one database per user so switching users never mixes keys. */
export class IdbKeyStore implements KeyStore {
  private db: Promise<IDBPDatabase>;

  constructor(userId: string) {
    this.db = openDB(`sa-keys-${userId}`, 1, {
      upgrade(db) {
        db.createObjectStore("device");
        db.createObjectStore("chatKeys");
        db.createObjectStore("cursors");
      },
    });
  }

  async getDevice(): Promise<StoredDevice | null> {
    return ((await (await this.db).get("device", DEVICE_KEY)) as StoredDevice | undefined) ?? null;
  }
  async putDevice(d: StoredDevice): Promise<void> {
    await (await this.db).put("device", d, DEVICE_KEY);
  }
  async getChatKey(chatId: string, epoch: number): Promise<string | null> {
    return (
      ((await (await this.db).get("chatKeys", `${chatId}:${epoch}`)) as string | undefined) ?? null
    );
  }
  async putChatKey(chatId: string, epoch: number, key: string): Promise<void> {
    await (await this.db).put("chatKeys", key, `${chatId}:${epoch}`);
  }
  async latestEpoch(chatId: string): Promise<number> {
    const keys = await (await this.db).getAllKeys(
      "chatKeys",
      IDBKeyRange.bound(`${chatId}:`, `${chatId}:￿`),
    );
    let latest = 0;
    for (const k of keys) latest = Math.max(latest, Number(String(k).slice(chatId.length + 1)));
    return latest;
  }
  async getCursor(chatId: string): Promise<number> {
    return ((await (await this.db).get("cursors", chatId)) as number | undefined) ?? 0;
  }
  async putCursor(chatId: string, seq: number): Promise<void> {
    await (await this.db).put("cursors", seq, chatId);
  }
}
