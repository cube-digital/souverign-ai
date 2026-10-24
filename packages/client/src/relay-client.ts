import { fromB64, toB64 } from "@sa/crypto";
import type { ClientOp, Envelope, RelayOp } from "@sa/protocol";
import type { RelayLink } from "./link.js";

export type RelayStatus = "connecting" | "ready" | "offline";

type Pending = { resolve: (v: RelayOp) => void; reject: (e: Error) => void; timer: unknown };

const TIMEOUT_MS = 10_000;

export class RelayClient implements RelayLink {
  status: RelayStatus = "offline";
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private deliverCbs = new Set<(seq: number, env: Envelope) => void>();
  private reconnectCbs = new Set<() => void>();
  private statusCbs = new Set<(s: RelayStatus) => void>();
  private backoff = 500;
  private everReady = false;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly Ws: typeof WebSocket;

  constructor(private opts: { url: string; deviceId: string; WebSocketImpl?: typeof WebSocket }) {
    this.Ws = opts.WebSocketImpl ?? WebSocket;
  }

  onStatus(cb: (s: RelayStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }
  onDeliver(cb: (seq: number, env: Envelope) => void): () => void {
    this.deliverCbs.add(cb);
    return () => this.deliverCbs.delete(cb);
  }

  private setStatus(s: RelayStatus): void {
    this.status = s;
    for (const cb of this.statusCbs) cb(s);
  }

  connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      let first = true;
      const open = () => {
        this.setStatus("connecting");
        const ws = new this.Ws(this.opts.url);
        this.ws = ws;
        ws.onopen = () =>
          // TODO(sp2): real ticket (T3/T5)
          this.raw({ op: "hello", device_id: this.opts.deviceId, ticket: "unsigned-placeholder" });
        ws.onmessage = (ev: MessageEvent) => {
          let msg: RelayOp;
          try {
            msg = JSON.parse(String(ev.data)) as RelayOp;
          } catch {
            return;
          }
          if (msg.op === "ready") {
            this.backoff = 500;
            this.setStatus("ready");
            this.everReady = true;
            if (first) {
              first = false;
              resolve();
            }
            // Fires on every ready (including the first) so syncs requested earlier are not lost.
            for (const cb of this.reconnectCbs) cb();
            return;
          }
          this.handle(msg);
        };
        ws.onclose = () => {
          if (this.ws !== ws) return;
          this.setStatus("offline");
          this.failAll(new Error("offline"));
          if (this.closed) return;
          const delay = this.backoff;
          this.backoff = Math.min(this.backoff * 2, 8000);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.closed) open();
          }, delay);
        };
        ws.onerror = () => {
          if (first && !this.everReady && this.closed) reject(new Error("connect_failed"));
        };
      };
      open();
    });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
  }

  private raw(op: ClientOp): void {
    this.ws?.send(JSON.stringify(op));
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer as number);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private handle(msg: RelayOp): void {
    switch (msg.op) {
      case "deliver":
        for (const cb of this.deliverCbs) cb(msg.seq, msg.env);
        return;
      case "synced":
        if (msg.more) this.sync(msg.chat_id, msg.seq);
        return;
      case "ack":
      case "blob_ok":
      case "blob":
        this.settle(msg.id, msg);
        return;
      case "error":
        if (msg.ref) this.settle(msg.ref, msg);
        return;
    }
  }

  private settle(id: string, msg: RelayOp): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer as number);
    this.pending.delete(id);
    if (msg.op === "error") p.reject(new Error(msg.code));
    else p.resolve(msg);
  }

  private request(id: string, op: ClientOp): Promise<RelayOp> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(new Error("offline"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.raw(op);
    });
  }

  async send(env: Envelope): Promise<number> {
    const r = await this.request(env.id, { op: "send", env });
    if (r.op !== "ack") throw new Error("bad_response");
    return r.seq;
  }

  sync(chatId: string, since: number): void {
    if (this.ws?.readyState === 1) this.raw({ op: "sync", chat_id: chatId, since });
  }

  async putBlob(id: string, chatId: string, data: Uint8Array): Promise<void> {
    await this.request(id, { op: "blob_put", id, chat_id: chatId, data: toB64(data) });
  }

  async getBlob(id: string): Promise<Uint8Array> {
    const r = await this.request(id, { op: "blob_get", id });
    if (r.op !== "blob") throw new Error("bad_response");
    return fromB64(r.data);
  }
}
