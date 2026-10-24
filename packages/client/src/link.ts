import type { Envelope } from "@sa/protocol";

export interface RelayLink {
  send(env: Envelope): Promise<number>;
  sync(chatId: string, since: number): void;
  putBlob(id: string, chatId: string, data: Uint8Array): Promise<void>;
  getBlob(id: string): Promise<Uint8Array>;
  /** Ephemeral, fire-and-forget; dropped when offline. */
  signal(env: Envelope): void;
  onSignal(cb: (env: Envelope) => void): () => void;
  onDeliver(cb: (seq: number, env: Envelope) => void): () => void;
  /** Called after a reconnect so the engine can re-sync. Optional for in-memory links. */
  onReconnect?(cb: () => void): () => void;
}
