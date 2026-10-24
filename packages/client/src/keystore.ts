import type { DeviceKeys } from "@sa/crypto";

export type StoredDevice = { deviceId: string; keys: DeviceKeys };

export interface KeyStore {
  getDevice(): Promise<StoredDevice | null>;
  putDevice(d: StoredDevice): Promise<void>;
  getChatKey(chatId: string, epoch: number): Promise<string | null>;
  putChatKey(chatId: string, epoch: number, key: string): Promise<void>;
  latestEpoch(chatId: string): Promise<number>;
  getCursor(chatId: string): Promise<number>;
  putCursor(chatId: string, seq: number): Promise<void>;
}

export class MemoryKeyStore implements KeyStore {
  private device: StoredDevice | null = null;
  private keys = new Map<string, string>();
  private latest = new Map<string, number>();
  private cursors = new Map<string, number>();

  async getDevice(): Promise<StoredDevice | null> {
    return this.device;
  }
  async putDevice(d: StoredDevice): Promise<void> {
    this.device = d;
  }
  async getChatKey(chatId: string, epoch: number): Promise<string | null> {
    return this.keys.get(`${chatId}|${epoch}`) ?? null;
  }
  async putChatKey(chatId: string, epoch: number, key: string): Promise<void> {
    this.keys.set(`${chatId}|${epoch}`, key);
    if (epoch > (this.latest.get(chatId) ?? 0)) this.latest.set(chatId, epoch);
  }
  async latestEpoch(chatId: string): Promise<number> {
    return this.latest.get(chatId) ?? 0;
  }
  async getCursor(chatId: string): Promise<number> {
    return this.cursors.get(chatId) ?? 0;
  }
  async putCursor(chatId: string, seq: number): Promise<void> {
    this.cursors.set(chatId, seq);
  }
}
