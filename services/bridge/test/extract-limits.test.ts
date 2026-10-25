import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../src/agents/turn-hooks.js";
import { openDb } from "../src/db.js";
import { ExtractError, extract } from "../src/memory/extract.js";
import { ingestStored } from "../src/memory/ingest.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory } from "./fakes/memory-fake.js";

describe("extraction limits", () => {
  it("rejects a zip whose directory declares a huge uncompressed size before parsing", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "x");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = bytes.length - 22;
    while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    dv.setUint32(dv.getUint32(eocd + 16, true) + 24, 300 * 1024 * 1024, true);
    const err = await extract(bytes, "bomb.docx", "").catch((e: ExtractError) => e);
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe("too_large");
  });

  it("does not ingest or throw when extraction fails", async () => {
    const db = await openDb("pglite://memory");
    await migrate(db);
    const mem = new FakeMemory();
    const logs: unknown[] = [];
    const m = {
      chatId: "room1",
      id: "f2",
      senderDevice: "d",
      receivedAt: 1,
      body: {
        type: "file",
        name: "bad.docx",
        mime: "",
        size: 4,
        blob_id: "b",
        key: "k",
        nonce: "n",
      },
      loadFile: async () => new Uint8Array([1, 2, 3, 4]),
    } as unknown as StoredMessage;
    await expect(
      ingestStored(m, { db, memory: mem, log: (_msg, x) => logs.push(x) }),
    ).resolves.toBeUndefined();
    expect(mem.ingested).toEqual([]);
    expect(logs).toEqual([{ chat: "room1", message: "f2", code: "failed" }]);
    await db.close();
  });
});
