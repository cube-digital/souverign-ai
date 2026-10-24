import {
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  messageAad,
  newChatKey,
  openKey,
  randomId,
  sealKey,
} from "@sa/crypto";
import { type DevicePublic, type Envelope, MessageBody } from "@sa/protocol";
import type { KeyStore, StoredDevice } from "./keystore.js";
import type { RelayLink } from "./link.js";

export type ChatMessage = {
  id: string;
  chatId: string;
  seq: number;
  ts: number;
  senderDevice: string;
  epoch: number;
  status: "ok" | "pending" | "error";
  body: MessageBody | null;
};

type FileBody = Extract<MessageBody, { type: "file" }>;

export class ChatEngine {
  private link: RelayLink;
  private store: KeyStore;
  private device: StoredDevice;
  private chats: string[] = [];
  private seen = new Set<string>();
  private waiting = new Map<string, { seq: number; env: Envelope }[]>(); // `${chat}|${epoch}`
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private keyCbs = new Set<(chatId: string, epoch: number) => void>();
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: { link: RelayLink; store: KeyStore; device: StoredDevice }) {
    this.link = opts.link;
    this.store = opts.store;
    this.device = opts.device;
    this.link.onDeliver((seq, env) => {
      this.queue = this.queue.then(() => this.incoming(seq, env)).catch(() => {});
    });
    this.link.onReconnect?.(() => void this.syncAll());
  }

  onMessage(cb: (m: ChatMessage) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }
  onKey(cb: (chatId: string, epoch: number) => void): () => void {
    this.keyCbs.add(cb);
    return () => this.keyCbs.delete(cb);
  }

  async start(chatIds: string[]): Promise<void> {
    for (const c of chatIds) if (!this.chats.includes(c)) this.chats.push(c);
    await this.syncAll();
  }

  private async syncAll(): Promise<void> {
    for (const c of this.chats) this.link.sync(c, await this.store.getCursor(c));
  }

  async createEpoch(chatId: string, devices: DevicePublic[]): Promise<number> {
    const epoch = (await this.store.latestEpoch(chatId)) + 1;
    const key = newChatKey();
    await this.store.putChatKey(chatId, epoch, key);
    for (const d of devices) {
      await this.link.send({
        v: 1,
        id: randomId(),
        chat_id: chatId,
        sender_device: this.device.deviceId,
        to_device: d.device_id,
        epoch,
        kind: "key",
        nonce: "",
        ciphertext: sealKey(key, d.public_key),
        ts: Date.now(),
      });
    }
    return epoch;
  }

  sendText(chatId: string, text: string): Promise<void> {
    return this.sendBody(chatId, { type: "text", text });
  }

  sendSystem(chatId: string, text: string): Promise<void> {
    return this.sendBody(chatId, { type: "system", text });
  }

  async sendFile(
    chatId: string,
    file: { name: string; mime: string; bytes: Uint8Array },
  ): Promise<void> {
    await this.keyFor(chatId); // fail early with no_key
    const enc = encryptBytes(file.bytes);
    const blobId = randomId();
    await this.link.putBlob(blobId, chatId, enc.ciphertext);
    await this.sendBody(chatId, {
      type: "file",
      blob_id: blobId,
      name: file.name,
      mime: file.mime,
      size: file.bytes.length,
      key: enc.key,
      nonce: enc.nonce,
    });
  }

  async downloadFile(body: FileBody): Promise<Uint8Array> {
    const data = await this.link.getBlob(body.blob_id);
    return decryptBytes(body.key, body.nonce, data);
  }

  private async keyFor(chatId: string): Promise<{ epoch: number; key: string }> {
    const epoch = await this.store.latestEpoch(chatId);
    const key = epoch > 0 ? await this.store.getChatKey(chatId, epoch) : null;
    if (!key) throw new Error("no_key");
    return { epoch, key };
  }

  private async sendBody(chatId: string, body: MessageBody): Promise<void> {
    const { epoch, key } = await this.keyFor(chatId);
    const id = randomId();
    const { nonce, ciphertext } = encrypt(key, JSON.stringify(body), messageAad(chatId, epoch, id));
    await this.link.send({
      v: 1,
      id,
      chat_id: chatId,
      sender_device: this.device.deviceId,
      epoch,
      kind: "msg",
      nonce,
      ciphertext,
      ts: Date.now(),
    });
  }

  private emit(
    env: Envelope,
    seq: number,
    status: ChatMessage["status"],
    body: MessageBody | null,
  ) {
    const m: ChatMessage = {
      id: env.id,
      chatId: env.chat_id,
      seq,
      ts: env.ts,
      senderDevice: env.sender_device,
      epoch: env.epoch,
      status,
      body,
    };
    for (const cb of this.msgCbs) cb(m);
  }

  private async incoming(seq: number, env: Envelope): Promise<void> {
    try {
      if (env.kind === "key") await this.incomingKey(env);
      else await this.incomingMsg(seq, env);
    } finally {
      if (seq > (await this.store.getCursor(env.chat_id))) {
        await this.store.putCursor(env.chat_id, seq);
      }
    }
  }

  private async incomingKey(env: Envelope): Promise<void> {
    if (env.to_device !== this.device.deviceId) return;
    let key: string;
    try {
      key = openKey(env.ciphertext, this.device.keys);
    } catch {
      return;
    }
    await this.store.putChatKey(env.chat_id, env.epoch, key);
    for (const cb of this.keyCbs) cb(env.chat_id, env.epoch);
    const wk = `${env.chat_id}|${env.epoch}`;
    const waiting = this.waiting.get(wk) ?? [];
    this.waiting.delete(wk);
    for (const w of waiting) this.decryptAndEmit(w.seq, w.env, key);
  }

  private async incomingMsg(seq: number, env: Envelope): Promise<void> {
    if (this.seen.has(env.id)) return;
    this.seen.add(env.id);
    const key = await this.store.getChatKey(env.chat_id, env.epoch);
    if (!key) {
      const wk = `${env.chat_id}|${env.epoch}`;
      const list = this.waiting.get(wk) ?? [];
      list.push({ seq, env });
      this.waiting.set(wk, list);
      this.emit(env, seq, "pending", null);
      return;
    }
    this.decryptAndEmit(seq, env, key);
  }

  private decryptAndEmit(seq: number, env: Envelope, key: string): void {
    try {
      const plain = decrypt(
        key,
        env.nonce,
        env.ciphertext,
        messageAad(env.chat_id, env.epoch, env.id),
      );
      const body = MessageBody.parse(JSON.parse(plain));
      this.emit(env, seq, "ok", body);
    } catch {
      this.emit(env, seq, "error", null);
    }
  }
}
