import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope, RelayRecentRow } from "@sa/protocol";
import Database from "better-sqlite3";

export type RelayDb = ReturnType<typeof makeDb>;

export interface StoredEnvelope {
  seq: number;
  env: Envelope;
}

interface EnvelopeRow {
  seq: number;
  id: string;
  chat_id: string;
  sender_device: string;
  to_device: string | null;
  epoch: number;
  kind: "msg" | "key";
  nonce: string;
  ciphertext: string;
  ts: number;
}

function toStored(r: EnvelopeRow): StoredEnvelope {
  const env = {
    v: 1,
    id: r.id,
    chat_id: r.chat_id,
    sender_device: r.sender_device,
    ...(r.to_device ? { to_device: r.to_device } : {}),
    epoch: r.epoch,
    kind: r.kind,
    nonce: r.nonce,
    ciphertext: r.ciphertext,
    ts: r.ts,
  } as Envelope;
  return { seq: r.seq, env };
}

function makeDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db: Database.Database = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      seq integer primary key autoincrement,
      id text unique not null,
      chat_id text not null,
      sender_device text not null,
      to_device text,
      epoch integer not null,
      kind text not null,
      nonce text not null,
      ciphertext text not null,
      ts integer not null,
      received_at integer not null
    );
    CREATE INDEX IF NOT EXISTS envelopes_chat_seq ON envelopes(chat_id, seq);
    CREATE TABLE IF NOT EXISTS members (
      id integer primary key,
      chat_id text not null,
      device_id text not null,
      added_seq integer not null,
      removed_seq integer
    );
    CREATE INDEX IF NOT EXISTS members_chat ON members(chat_id, device_id);
    CREATE TABLE IF NOT EXISTS blobs (
      id text primary key,
      chat_id text not null,
      data blob not null,
      created_at integer not null
    );
  `);

  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM envelopes");
  const sqliteSeq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'envelopes'");
  const activeRow = db.prepare(
    "SELECT added_seq FROM members WHERE chat_id = ? AND device_id = ? AND removed_seq IS NULL",
  );
  const activeList = db.prepare(
    "SELECT device_id FROM members WHERE chat_id = ? AND removed_seq IS NULL",
  );
  const insertMember = db.prepare(
    "INSERT INTO members (chat_id, device_id, added_seq) VALUES (?, ?, ?)",
  );
  const removeMember = db.prepare(
    "UPDATE members SET removed_seq = ? WHERE chat_id = ? AND device_id = ? AND removed_seq IS NULL",
  );
  const byId = db.prepare("SELECT * FROM envelopes WHERE id = ?");
  const insertEnv = db.prepare(
    `INSERT INTO envelopes (id, chat_id, sender_device, to_device, epoch, kind, nonce, ciphertext, ts, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const syncQ = db.prepare(
    `SELECT * FROM envelopes WHERE chat_id = ? AND seq > ? AND (to_device IS NULL OR to_device = ?)
     ORDER BY seq LIMIT ?`,
  );
  const recentQ = db.prepare("SELECT * FROM envelopes ORDER BY seq DESC LIMIT ?");
  const putBlob = db.prepare(
    "INSERT OR IGNORE INTO blobs (id, chat_id, data, created_at) VALUES (?, ?, ?, ?)",
  );
  const getBlob = db.prepare("SELECT chat_id, data FROM blobs WHERE id = ?");

  const currentSeq = (): number => {
    // autoincrement never reuses seq numbers, so prefer the sequence counter
    const s = sqliteSeq.get() as { seq: number } | undefined;
    return s?.seq ?? (maxSeq.get() as { m: number }).m;
  };

  return {
    close: (): void => {
      db.close();
    },
    /** added_seq of the active membership, or undefined if not an active member */
    activeSince(chat: string, device: string): number | undefined {
      return (activeRow.get(chat, device) as { added_seq: number } | undefined)?.added_seq;
    },
    isActive(chat: string, device: string): boolean {
      return activeRow.get(chat, device) !== undefined;
    },
    activeDevices(chat: string): string[] {
      return (activeList.all(chat) as { device_id: string }[]).map((r) => r.device_id);
    },
    addMember(chat: string, device: string): void {
      db.transaction(() => {
        if (activeRow.get(chat, device)) return;
        insertMember.run(chat, device, currentSeq());
      })();
    },
    removeMember(chat: string, device: string): void {
      removeMember.run(currentSeq(), chat, device);
    },
    findEnvelope(id: string): StoredEnvelope | undefined {
      const r = byId.get(id) as EnvelopeRow | undefined;
      return r ? toStored(r) : undefined;
    },
    insertEnvelope(e: Envelope): number {
      const res = insertEnv.run(
        e.id,
        e.chat_id,
        e.sender_device,
        e.to_device ?? null,
        e.epoch,
        e.kind,
        e.nonce,
        e.ciphertext,
        e.ts,
        Date.now(),
      );
      return Number(res.lastInsertRowid);
    },
    sync(chat: string, device: string, afterSeq: number, limit: number): StoredEnvelope[] {
      return (syncQ.all(chat, afterSeq, device, limit) as EnvelopeRow[]).map(toStored);
    },
    hasMoreAfter(chat: string, device: string, afterSeq: number): boolean {
      return syncQ.all(chat, afterSeq, device, 1).length > 0;
    },
    recent(limit: number): RelayRecentRow[] {
      return (recentQ.all(limit) as EnvelopeRow[]).map((r) => ({
        seq: r.seq,
        ts: r.ts,
        kind: r.kind,
        chat_id: r.chat_id,
        sender_device: r.sender_device,
        to_device: r.to_device,
        size: r.ciphertext.length,
        ciphertext_prefix: r.ciphertext.slice(0, 48),
      }));
    },
    putBlob(id: string, chat: string, data: Buffer): "ok" | "conflict" {
      putBlob.run(id, chat, data, Date.now());
      const r = getBlob.get(id) as { chat_id: string } | undefined;
      return r?.chat_id === chat ? "ok" : "conflict";
    },
    getBlob(id: string): { chat_id: string; data: Buffer } | undefined {
      return getBlob.get(id) as { chat_id: string; data: Buffer } | undefined;
    },
  };
}
export const openDb: (path: string) => RelayDb = makeDb;
