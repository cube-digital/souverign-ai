import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredMessage } from "../src/agents/turn-hooks.js";
import { type Db, openDb } from "../src/db.js";
import { ingestStored } from "../src/memory/ingest.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory } from "./fakes/memory-fake.js";

let db: Db;
beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana Pop','x')");
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ('dev-ana','user','ana','k')",
  );
});
afterEach(async () => {
  await db.close();
});

const logs: { msg: string; extra?: Record<string, unknown> | undefined }[] = [];
const log = (msg: string, extra?: Record<string, unknown>) => {
  logs.push({ msg, extra });
};
beforeEach(() => {
  logs.length = 0;
});

const base = {
  chatId: "room1",
  seq: 1,
  senderDevice: "dev-ana",
  ts: 1_000,
  receivedAt: 1_700_000_123_456,
};
const text = (id: string, body: Record<string, unknown> = {}, agent = "nora"): StoredMessage =>
  ({
    ...base,
    id,
    agentId: agent,
    deviceId: `dev-${agent}`,
    body: { type: "text", text: "We chose the Lisbon venue", ...body },
  }) as StoredMessage;

describe("ingestStored", () => {
  it("ingests a message once into chat:<id> with the receipt time, even when two agent devices store it", async () => {
    const mem = new FakeMemory();
    await ingestStored(text("m1", {}, "nora"), { db, memory: mem, log });
    await ingestStored(text("m1", {}, "max"), { db, memory: mem, log });

    expect(mem.ingested).toEqual([
      {
        namespace: "chat:room1",
        kind: "conversation",
        origin_chat_id: null,
        source: { type: "message", id: "m1", title: "Ana Pop", ts: 1_700_000_123_456 },
        text: "We chose the Lisbon venue",
      },
    ]);
  });

  it("does not ingest reactions, private-preview notices or approval stamps", async () => {
    const mem = new FakeMemory();
    const deps = { db, memory: mem, log };
    await ingestStored(
      { ...text("r1"), body: { type: "reaction", target: "m1", emoji: "x", op: "add" } } as never,
      deps,
    );
    await ingestStored(text("h1", { meta: { held: "ap1" } }), deps);
    await ingestStored(text("s1", { meta: { approval: { id: "ap1", status: "approved" } } }), deps);
    await ingestStored(text("ok1"), deps);

    expect(mem.ingested.map((r) => r.source.id)).toEqual(["ok1"]);
  });

  it("ingests a PDF file message as titled file parts", async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("Venue contract terms", { x: 50, y: 700, size: 14 });
    doc.addPage().drawText("Catering menu options", { x: 50, y: 700, size: 14 });
    const bytes = await doc.save();
    const mem = new FakeMemory();
    const m = {
      ...base,
      id: "f1",
      agentId: "nora",
      deviceId: "dev-nora",
      body: {
        type: "file",
        blob_id: "b1",
        name: "deal.pdf",
        mime: "application/pdf",
        size: bytes.length,
        key: "k",
        nonce: "n",
      },
      loadFile: async () => bytes,
    } as StoredMessage;

    await ingestStored(m, { db, memory: mem, log });

    expect(mem.ingested).toEqual([
      {
        namespace: "chat:room1",
        kind: "knowledge",
        origin_chat_id: null,
        source: { type: "file", id: "f1.p1", title: "deal.pdf · p. 1", ts: 1_700_000_123_456 },
        text: "Venue contract terms",
      },
      {
        namespace: "chat:room1",
        kind: "knowledge",
        origin_chat_id: null,
        source: { type: "file", id: "f1.p2", title: "deal.pdf · p. 2", ts: 1_700_000_123_456 },
        text: "Catering menu options",
      },
    ]);
  });

  it("is a no-op when memory is off, and swallows memory failures without logging text", async () => {
    await ingestStored(text("off1"), { db, memory: null, log });
    const claimed = await db.query("select 1 from sa.memory_ingested where message_id = 'off1'");
    expect(claimed).toEqual([]);

    const failing = {
      ingest: async () => {
        throw new Error("memory down");
      },
      recall: async () => [],
      deleteSource: async () => 0,
    };
    await expect(
      ingestStored(text("bad1", { text: "SECRET-BODY-TEXT" }), { db, memory: failing, log }),
    ).resolves.toBeUndefined();
    const kept = await db.query("select 1 from sa.memory_ingested where message_id = 'bad1'");
    expect(kept).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.extra).toMatchObject({ chat: "room1", message: "bad1" });
    expect(JSON.stringify(logs)).not.toContain("SECRET-BODY-TEXT");
  });
});
