import type { Agent, KnowledgeItem, Lesson } from "@sa/protocol";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHostApi } from "../src/agents/api.js";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { plugin } from "../src/plugins/knowledge.js";
import { approvalsWorld } from "./approvals-fixture.js";
import { FakeMemory } from "./fakes/memory-fake.js";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setMemoryForTests(undefined);
  for (const c of closers.splice(0)) await c();
});

const as = (user: string) => ({ authorization: `Bearer tok-${user}` });

/** approvalsWorld (ana/bob/cy, personal `nora` of ana, workspace `max`, chat c1 with ana, bob,
 * nora, max) plus agent devices, an agent reply in each mailbox and one human message to max. */
async function setup() {
  const w = await approvalsWorld();
  const db: Db = w.db;
  for (const [dev, type, owner] of [
    ["dev-nora", "agent", "nora"],
    ["dev-max", "agent", "max"],
    ["dev-bob", "user", "bob"],
  ]) {
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1, $2, $3, 'pk')",
      [dev, type, owner],
    );
  }
  for (const [dev, agent] of [
    ["dev-nora", "nora"],
    ["dev-max", "max"],
  ]) {
    await db.query(
      "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ($1, $2, 'x')",
      [dev, agent],
    );
  }
  const msg = (device: string, id: string, sender: string, text: string, seq: number) =>
    db.query(
      "insert into sa.messages_plain (device_id, chat_id, id, seq, sender_device, epoch, body, ts) values ($1, 'c1', $2, $3, $4, 1, $5, 1000)",
      [device, id, seq, sender, JSON.stringify({ type: "text", text })],
    );
  await msg("dev-max", "max-reply", "dev-max", "Revenue grew 4 percent.", 1);
  await msg("dev-max", "bob-says", "dev-bob", "How did revenue do?", 2);
  await msg("dev-nora", "nora-reply", "dev-nora", "Your flight is at nine.", 1);

  const memory = new FakeMemory();
  const deleted: unknown[] = [];
  const realDelete = memory.deleteSource.bind(memory);
  memory.deleteSource = async (req) => {
    deleted.push(req);
    return realDelete(req);
  };
  setMemoryForTests(memory);

  const updated: string[] = [];
  const host: AgentHostApi = { ...w.host, onAgentUpdated: (id) => void updated.push(id) };
  const app = buildApp({
    db,
    relayAdmin: { setMember: async () => {} },
    agentHost: host,
    plugins: [plugin],
  });
  closers.push(() => app.close());
  await app.ready();

  const upload = (agent: string, user: string, name: string, mime: string, bytes: Uint8Array) =>
    app.inject({
      method: "POST",
      url: `/api/agents/${agent}/knowledge`,
      headers: {
        ...as(user),
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-file-type": mime,
      },
      payload: Buffer.from(bytes),
    });
  return { ...w, db, app, memory, deleted, updated, upload };
}

async function pdfOf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const t of pages) doc.addPage().drawText(t, { x: 50, y: 700, size: 14 });
  return doc.save();
}

const enc = (s: string) => new TextEncoder().encode(s);
const count = async (db: Db, table: string, where = "true") =>
  Number(
    (await db.query<{ n: string }>(`select count(*) as n from ${table} where ${where}`))[0]?.n,
  );

describe("T7 teaching API", () => {
  it("lets any person teach a workspace agent a TXT, ingesting one doc with no origin chat", async () => {
    const t = await setup();
    const text = "Quarterly budget is forty thousand.";
    const r = await t.upload("max", "bob", "budget.txt", "text/plain", enc(text));
    expect(r.statusCode).toBe(200);
    const item = r.json() as KnowledgeItem;
    expect(item).toMatchObject({
      agent_id: "max",
      kind: "document",
      title: "budget.txt",
      parts: 1,
      truncated: false,
      origin_chat_id: null,
      taught_by_user_id: "bob",
      taught_by_name: "Bob",
      preview: text,
    });
    expect(t.memory.ingested).toEqual([
      {
        namespace: "agent:max",
        kind: "knowledge",
        origin_chat_id: null,
        source: { type: "doc", id: item.id, title: "budget.txt", ts: expect.any(Number) },
        text,
      },
    ]);
  });

  it("ingests PDF pages as .p1/.p2 parts and deletes all parts and the row on delete", async () => {
    const t = await setup();
    const r = await t.upload(
      "max",
      "bob",
      "plan.pdf",
      "application/pdf",
      await pdfOf(["Alpha budget notes", "Beta launch plan"]),
    );
    expect(r.statusCode).toBe(200);
    const item = r.json() as KnowledgeItem;
    expect(item.parts).toBe(2);
    expect(t.memory.ingested.map((i) => [i.source.type, i.source.id, i.source.title])).toEqual([
      ["doc", `${item.id}.p1`, "plan.pdf · p. 1"],
      ["doc", `${item.id}.p2`, "plan.pdf · p. 2"],
    ]);

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/agents/max/knowledge/${item.id}`,
      headers: as("bob"),
    });
    expect(del.statusCode).toBeLessThan(300);
    expect(t.deleted).toEqual([
      { namespace: "agent:max", source_type: "doc", source_id: item.id, include_parts: true },
    ]);
    expect(await count(t.db, "sa.knowledge_items", `id = '${item.id}'`)).toBe(0);
    const hits = await t.memory.recall({
      scopes: [{ namespace: "agent:max", origin_chat_ids: null }],
      query: "alpha beta budget launch",
    });
    expect(hits).toEqual([]);
  });

  it("hides a personal agent from non-owners and lets only the owner teach it", async () => {
    const t = await setup();
    const list = await t.app.inject({
      method: "GET",
      url: "/api/agents/nora/knowledge",
      headers: as("bob"),
    });
    expect(list.statusCode).toBe(404);
    const denied = await t.upload("nora", "bob", "a.txt", "text/plain", enc("secret"));
    expect(denied.statusCode).toBe(404);
    expect(t.memory.ingested).toEqual([]);

    const ok = await t.upload("nora", "ana", "a.txt", "text/plain", enc("passport number"));
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as KnowledgeItem).taught_by_name).toBe("Ana");
    const own = await t.app.inject({
      method: "GET",
      url: "/api/agents/nora/knowledge",
      headers: as("ana"),
    });
    expect((own.json() as KnowledgeItem[]).map((i) => i.title)).toEqual(["a.txt"]);
  });

  it("refuses an unsupported type with 415 and an oversized upload with 413, storing nothing", async () => {
    const t = await setup();
    const png = await t.upload("max", "bob", "pic.png", "image/png", new Uint8Array([137, 80, 78]));
    expect(png.statusCode).toBe(415);
    const big = await t.upload(
      "max",
      "bob",
      "huge.txt",
      "text/plain",
      new Uint8Array(21 * 1024 * 1024).fill(97),
    );
    expect(big.statusCode).toBe(413);
    expect(t.memory.ingested).toEqual([]);
    expect(await count(t.db, "sa.knowledge_items")).toBe(0);
  });

  it("attaches corrections to the agent's own reply with the right origin chat", async () => {
    const t = await setup();
    const post = (user: string, agent: string, message_id: string, text: string) =>
      t.app.inject({
        method: "POST",
        url: `/api/agents/${agent}/corrections`,
        headers: as(user),
        payload: { chat_id: "c1", message_id, text },
      });

    const member = await post("bob", "max", "max-reply", "It grew 6 percent.");
    expect(member.statusCode).toBe(200);
    const item = member.json() as KnowledgeItem;
    expect(item).toMatchObject({
      kind: "correction",
      agent_id: "max",
      origin_chat_id: "c1",
      taught_by_user_id: "bob",
    });
    expect(t.memory.ingested[0]).toMatchObject({
      namespace: "agent:max",
      kind: "correction",
      origin_chat_id: "c1",
      source: { type: "correction", id: item.id, title: "Correction" },
      text: 'Correction to an earlier answer ("Revenue grew 4 percent."): It grew 6 percent.',
    });
    const [stored] = await t.db.query<{ target_message_id: string }>(
      "select target_message_id from sa.knowledge_items where id = $1",
      [item.id],
    );
    expect(stored?.target_message_id).toBe("max-reply");

    const owner = await post("ana", "nora", "nora-reply", "It is at ten.");
    expect(owner.statusCode).toBe(200);
    expect((owner.json() as KnowledgeItem).origin_chat_id).toBeNull();
    expect(t.memory.ingested[1]?.origin_chat_id).toBeNull();

    const human = await post("bob", "max", "bob-says", "No, it was 6.");
    expect(human.statusCode).toBe(404);
    expect(t.memory.ingested).toHaveLength(2);
  });

  it("keeps a note born in chat A out of the list of people who are not in A", async () => {
    const t = await setup();
    await t.db.query(
      `insert into sa.knowledge_items (id, agent_id, kind, title, parts, origin_chat_id)
       values ('note1', 'max', 'note', 'Budget remark', '[{"label":null,"text":"Only for c1"}]', 'c1')`,
    );
    const titles = async (user: string) =>
      (
        (
          await t.app.inject({
            method: "GET",
            url: "/api/agents/max/knowledge",
            headers: as(user),
          })
        ).json() as KnowledgeItem[]
      ).map((i) => i.title);
    expect(await titles("bob")).toEqual(["Budget remark"]);
    expect(await titles("cy")).toEqual([]);
    const detail = await t.app.inject({
      method: "GET",
      url: "/api/agents/max/knowledge/note1",
      headers: as("cy"),
    });
    expect(detail.statusCode).toBe(404);
  });

  it("restarts the agent gateway after a lesson is added", async () => {
    const t = await setup();
    const r = await t.app.inject({
      method: "POST",
      url: "/api/agents/max/lessons",
      headers: as("bob"),
      payload: { text: "Always quote the source." },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json() as Lesson).toMatchObject({
      agent_id: "max",
      text: "Always quote the source.",
      taught_by_user_id: "bob",
      taught_by_name: "Bob",
    });
    expect(t.updated).toEqual(["max"]);
  });

  it("refuses the 31st lesson with 409 too_many_lessons", async () => {
    const t = await setup();
    await t.db.query(
      "insert into sa.agent_lessons (id, agent_id, text) select 'l' || g, 'max', 'x' from generate_series(1, 30) g",
    );
    const r = await t.app.inject({
      method: "POST",
      url: "/api/agents/max/lessons",
      headers: as("bob"),
      payload: { text: "One too many." },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "too_many_lessons" });
    expect(await count(t.db, "sa.agent_lessons")).toBe(30);
    expect(t.updated).toEqual([]);
  });

  it("rejects an unknown sharing value and persists ask", async () => {
    const t = await setup();
    const put = (value: string) =>
      t.app.inject({
        method: "PUT",
        url: "/api/agents/max/sharing",
        headers: as("bob"),
        payload: { share_private_in_chats: value },
      });
    expect((await put("sometimes")).statusCode).toBe(400);
    const ok = await put("ask");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ share_private_in_chats: "ask" });
    const agents = (
      await t.app.inject({ method: "GET", url: "/api/agents", headers: as("bob") })
    ).json() as Agent[];
    expect(agents.find((a) => a.id === "max")?.share_private_in_chats).toBe("ask");
  });
});
