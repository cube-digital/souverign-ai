import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addTurnHooks,
  beginTurn,
  clearTurnHooks,
  endTurn,
  runBeforeReply,
  type TurnContext,
} from "../src/agents/turn-hooks.js";
import { type Db, openDb } from "../src/db.js";
import { clearRegisteredTools, invokeTool, setToolDeps } from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { MemoryError, type MemoryScope, setMemoryForTests } from "../src/memory/client.js";
import { registerMemoryTools } from "../src/memory/tools.js";
import { recallsFor } from "../src/memory/turn-recalls.js";
import { migrate } from "../src/migrate.js";
import { plugin } from "../src/plugins/memory-tools.js";
import { FakeMemory } from "./fakes/memory-fake.js";

const JOINED = "2026-01-02T00:00:00Z";
const T_MSG = Date.UTC(2026, 9, 20, 14, 5);
const T_DOC = Date.UTC(2026, 9, 21, 9, 30);
const AGENT = "nora";
const log = () => {};

let db: Db;
let toolLog: ToolLog;
let mem: FakeMemory;
let n = 0;

beforeAll(() => {
  process.env.TZ = "UTC";
});

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["bob", "Bob"],
  ])
    await db.query(
      "insert into sa.users (id, display_name, pin_hash, kind) values ($1,$2,'x','person')",
      [id, name],
    );
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana','Nora','general')",
    [AGENT],
  );
  for (const [id, title] of [
    ["chatx", "Ops"],
    ["chaty", "Other"],
  ]) {
    await db.query(
      "insert into sa.chats (id, title, kind, created_by) values ($1,$2,'group','ana')",
      [id, title],
    );
    for (const [type, mid] of [
      ["user", "ana"],
      ["user", "bob"],
      ["agent", AGENT],
    ])
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ($1,$2,$3,'member',$4)",
        [id, type, mid, JOINED],
      );
  }
  toolLog = new ToolLog();
  setToolDeps({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  mem = new FakeMemory();
  setMemoryForTests(mem);
  registerMemoryTools();
  await plugin.init?.({ db } as never);
});

afterEach(async () => {
  clearTurnHooks();
  clearRegisteredTools();
  setMemoryForTests(undefined);
  await db.close();
});

/** Opens a turn for the agent in a chat (what the host does) and returns its id. */
function turn(chatId: string, over: Partial<TurnContext> = {}): string {
  const turnId = `turn-${++n}`;
  toolLog.begin(AGENT, chatId, { requesterUserId: "ana", turnId });
  beginTurn(
    {
      turnId,
      agentId: AGENT,
      agentName: "Nora",
      chatId,
      replyTo: null,
      triggerMessageId: null,
      requesterUserId: "ana",
      trigger: "mention",
      prompt: "hi",
      noTaught: false,
      ...over,
    },
    log,
  );
  return turnId;
}
const recall = (query: string) => invokeTool(AGENT, "memory_recall", { query });
const message = (chat: string, id: string, title: string, text: string, ts = T_MSG) =>
  mem.ingest({
    namespace: `chat:${chat}`,
    kind: "conversation",
    origin_chat_id: null,
    source: { type: "message", id, title, ts },
    text,
  });
const teach = (id: string, title: string, text: string, ts = T_DOC) =>
  mem.ingest({
    namespace: `agent:${AGENT}`,
    kind: "knowledge",
    origin_chat_id: null,
    source: { type: "doc", id, title, ts },
    text,
  });
const teachItem = (id: string) =>
  db.query(
    "insert into sa.knowledge_items (id, agent_id, kind, title, taught_by) values ($1,$2,'document','contract.pdf','ana')",
    [id, AGENT],
  );

describe("memory tools and citations (T6)", () => {
  it("memory_recall returns a numbered block with a source label built from the chat title, sender and receipt time", async () => {
    await message("chatx", "m1", "Bob", "budget review moves to Thursday");
    turn("chatx");

    const out = await recall("budget");

    expect(out).toBe(
      '[1] "budget review moves to Thursday"\n    source: #Ops · Bob · 20 Oct 14:05',
    );
  });

  it("numbering continues in the same turn and an already numbered source is not repeated", async () => {
    await message("chatx", "m1", "Bob", "budget review moves to Thursday", T_MSG);
    await message("chatx", "m2", "Ana", "budget owner is Ana", T_MSG + 60_000);
    const id = turn("chatx");

    const first = await recall("budget review thursday");
    await message("chatx", "m3", "Bob", "invoice budget approved", T_MSG + 120_000);
    const second = await recall("budget invoice");

    expect(first.startsWith('[1] "budget review moves to Thursday"')).toBe(true);
    expect(first).toContain('[2] "budget owner is Ana"');
    expect(second).toBe('[3] "invoice budget approved"\n    source: #Ops · Bob · 20 Oct 14:07');
    expect(recallsFor(id).map((r) => [r.n, r.hit.source.id])).toEqual([
      [1, "m1"],
      [2, "m2"],
      [3, "m3"],
    ]);
  });

  it("with share never an origin-null doc chunk is hidden in a shared chat, with always it shows 'taught by Ana'", async () => {
    await teach("itemA", "contract.pdf", "payment terms net thirty");
    await teachItem("itemA");
    await db.query("update sa.agents set share_private_in_chats = 'never' where id = $1", [AGENT]);
    turn("chatx");
    const hidden = await recall("payment terms");

    await db.query("update sa.agents set share_private_in_chats = 'always' where id = $1", [AGENT]);
    turn("chatx");
    const shown = await recall("payment terms");

    expect(hidden).toBe("No memories matched.");
    expect(shown).toBe('[1] "payment terms net thirty"\n    source: contract.pdf · taught by Ana');
  });

  it("memory_remember stores the note with this chat as origin and a recall in another chat does not return it; a failed ingest removes the row", async () => {
    turn("chatx");
    const saved = await invokeTool(AGENT, "memory_remember", {
      text: "Quarterly freeze starts on the 5th",
      tags: ["ops", "freeze"],
    });
    const rows = await db.query<{
      id: string;
      origin_chat_id: string | null;
      taught_by: string | null;
      title: string;
      kind: string;
      tags: string[];
      parts: unknown;
    }>("select id, origin_chat_id, taught_by, title, kind, tags, parts from sa.knowledge_items");
    const inX = await recall("freeze");
    turn("chaty");
    const inY = await recall("freeze");

    expect(saved).toBe("Remembered. Members of this chat can see it on my Knowledge tab.");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin_chat_id: "chatx",
      taught_by: null,
      kind: "note",
      title: "Quarterly freeze starts on the 5th",
      tags: ["ops", "freeze"],
      parts: [{ label: null, text: "Quarterly freeze starts on the 5th" }],
    });
    expect(mem.ingested).toHaveLength(1);
    expect(mem.ingested[0]).toMatchObject({
      namespace: `agent:${AGENT}`,
      kind: "knowledge",
      origin_chat_id: "chatx",
      source: { type: "note", id: rows[0]?.id },
      text: "Quarterly freeze starts on the 5th\n(tags: ops, freeze)",
    });
    expect(inX).toContain("Quarterly freeze starts on the 5th");
    expect(inY).toBe("No memories matched.");

    setMemoryForTests({
      ...mem,
      ingest: async () => {
        throw new MemoryError(500, "boom");
      },
    } as never);
    turn("chatx");
    const failed = await invokeTool(AGENT, "memory_remember", { text: "never stored" });
    const after = await db.query("select id from sa.knowledge_items");
    expect(failed).toBe("I could not save that.");
    expect(after).toHaveLength(1);
  });

  it("beforeReply attaches a citation per recalled source, marks only [n] in the reply as cited, and onTurnEnd clears the recalls", async () => {
    await teach("itemA.p3", "contract.pdf · p. 3", "payment terms net thirty");
    await teachItem("itemA");
    await message("chatx", "m1", "Bob", "payment reminder sent");
    await message("chaty", "y1", "Bob", "payment terms net thirty secret other chat");
    const id = turn("chatx");
    await recall("payment terms");
    const ctx = { turnId: id, agentId: AGENT, chatId: "chatx" } as TurnContext;

    const out = await runBeforeReply(ctx, { text: "Terms are net thirty [2].", meta: {} }, log);

    expect(out.held).toBe(false);
    expect(out.meta.citations).toEqual([
      {
        n: 1,
        space: "agent",
        kind: "knowledge",
        source_type: "doc",
        source_id: "itemA.p3",
        title: "contract.pdf · p. 3",
        ts: T_DOC,
        agent_id: AGENT,
        item_id: "itemA",
        page: 3,
        taught_by: "Ana",
        cited: false,
      },
      {
        n: 2,
        space: "chat",
        kind: "conversation",
        source_type: "message",
        source_id: "m1",
        title: "Bob",
        ts: T_MSG,
        chat_id: "chatx",
        message_id: "m1",
        cited: true,
      },
    ]);

    endTurn(AGENT, log);
    const empty = await runBeforeReply(ctx, { text: "No sources here.", meta: {} }, log);
    expect(recallsFor(id)).toEqual([]);
    expect(empty.meta.citations).toBeUndefined();
  });

  it("answers plainly when memory is off, and fails closed with no unscoped recall when the service is down", async () => {
    setMemoryForTests(null);
    turn("chatx");
    const off = await recall("budget");

    const scopesSeen: MemoryScope[][] = [];
    setMemoryForTests({
      ...mem,
      recall: async (req: { scopes: MemoryScope[] }) => {
        scopesSeen.push(req.scopes);
        throw new MemoryError(503, "memory service down");
      },
    } as never);
    const id = turn("chatx");
    const down = await recall("budget");

    expect(off).toBe("Memory is off on this Mac.");
    expect(down).toMatch(/^(No memories matched\.|error: )/);
    expect(recallsFor(id)).toEqual([]);
    expect(scopesSeen).toHaveLength(1);
    expect(scopesSeen[0]?.length).toBeGreaterThan(0);
    expect(scopesSeen[0]?.map((s) => s.namespace).sort()).toEqual([
      "agent:nora",
      "agent:nora",
      "chat:chatx",
    ]);
  });
});
