import type { Envelope } from "@sa/protocol";
import type { RelayLink } from "../src/index.js";

type Stored = { seq: number; env: Envelope };

/**
 * In-memory relay for several devices. Mirrors the real relay's rules: one global seq order,
 * a device only sees envelopes stored after it was added to the chat, and "key" envelopes
 * go only to their addressee. Live delivery echoes to every member, sender included.
 */
export class FakeRelay {
  readonly log: Stored[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  private joined = new Map<string, number>(); // `${chat}|${device}` -> seq at join
  private listeners = new Map<string, Set<(seq: number, env: Envelope) => void>>();

  addMember(chatId: string, deviceId: string): void {
    this.joined.set(`${chatId}|${deviceId}`, this.log.length);
  }

  private visible(deviceId: string, s: Stored): boolean {
    const joinedAt = this.joined.get(`${s.env.chat_id}|${deviceId}`);
    if (joinedAt === undefined || s.seq <= joinedAt) return false;
    return s.env.kind === "msg" || s.env.to_device === deviceId;
  }

  private push(deviceId: string, s: Stored): void {
    queueMicrotask(() => {
      for (const cb of this.listeners.get(deviceId) ?? []) cb(s.seq, s.env);
    });
  }

  link(deviceId: string): RelayLink {
    return {
      send: async (env) => {
        if (!this.joined.has(`${env.chat_id}|${deviceId}`)) throw new Error("not_member");
        const s = { seq: this.log.length + 1, env };
        this.log.push(s);
        for (const dev of new Set([...this.joined.keys()].map((k) => k.split("|")[1] as string))) {
          if (this.visible(dev, s)) this.push(dev, s);
        }
        return s.seq;
      },
      sync: (chatId, since) => {
        for (const s of this.log) {
          if (s.env.chat_id === chatId && s.seq > since && this.visible(deviceId, s)) {
            this.push(deviceId, s);
          }
        }
      },
      putBlob: async (id, _chatId, data) => {
        this.blobs.set(id, data);
      },
      getBlob: async (id) => {
        const d = this.blobs.get(id);
        if (!d) throw new Error("not_found");
        return d;
      },
      onDeliver: (cb) => {
        const set = this.listeners.get(deviceId) ?? new Set();
        set.add(cb);
        this.listeners.set(deviceId, set);
        return () => set.delete(cb);
      },
    };
  }
}
