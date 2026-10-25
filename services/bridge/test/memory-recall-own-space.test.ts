import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginTurn, clearTurnHooks } from "../src/agents/turn-hooks.js";
import { type Db, openDb } from "../src/db.js";
import { clearRegisteredTools, invokeTool, setToolDeps } from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { registerMemoryTools } from "../src/memory/tools.js";
import { clearRecalls, recallsFor } from "../src/memory/turn-recalls.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory } from "./fakes/memory-fake.js";

const AGENT = "tech";
const T0 = Date.UTC(2026, 9, 20, 14, 5);
let db: Db;
let mem: FakeMemory;
let toolLog: ToolLog;

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query(
    "insert into sa.users (id, display_name, pin_hash, kind) values ('ana','Ana','x','person')",
  );
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, share_private_in_chats) values ($1,'ana','Tech','tech','always')",
    [AGENT],
  );
  await db.query(
    "insert into sa.chats (id, title, kind, created_by) values ('gen','general','group','ana')",
  );
  for (const [type, id] of [
    ["user", "ana"],
    ["agent", AGENT],
  ])
    await db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ('gen',$1,$2,'member','2026-01-02T00:00:00Z')",
      [type, id],
    );
  toolLog = new ToolLog();
  setToolDeps({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  mem = new FakeMemory();
  setMemoryForTests(mem);
  registerMemoryTools();
  toolLog.begin(AGENT, "gen", { requesterUserId: "ana", turnId: "t1" });
  beginTurn(
    {
      turnId: "t1",
      agentId: AGENT,
      agentName: "Tech",
      chatId: "gen",
      replyTo: null,
      triggerMessageId: null,
      requesterUserId: "ana",
      trigger: "mention",
      prompt: "hi",
      noTaught: false,
    },
    () => {},
  );
});

afterEach(async () => {
  clearRecalls("t1");
  clearRecalls("t2");
  clearTurnHooks();
  clearRegisteredTools();
  setMemoryForTests(undefined);
  await db.close();
});

describe("memory_recall keeps the agent's own space", () => {
  it("a taught document is recalled even when more than k chat messages echo every query word", async () => {
    await mem.ingest({
      namespace: `agent:${AGENT}`,
      kind: "knowledge",
      origin_chat_id: null,
      source: { type: "doc", id: "doc1", title: "contract.txt", ts: T0 },
      text: "Termination. Either party may terminate with a notice period of 47 days.",
    });
    for (let i = 1; i <= 6; i++)
      await mem.ingest({
        namespace: "chat:gen",
        kind: "conversation",
        origin_chat_id: null,
        source: { type: "message", id: `m${i}`, title: "Ana", ts: T0 + i * 1000 },
        text: "@Tech what is the contract termination notice period?",
      });

    await invokeTool(AGENT, "memory_recall", { query: "contract termination notice period" });

    const ids = recallsFor("t1").map((r) => r.hit.source.id);
    expect(ids).toHaveLength(5);
    expect(ids.filter((id) => id === "doc1")).toEqual(["doc1"]);
  });

  async function seed() {
    await mem.ingest({
      namespace: `agent:${AGENT}`,
      kind: "knowledge",
      origin_chat_id: null,
      source: { type: "doc", id: "doc1", title: "contract.txt", ts: T0 },
      text: "Termination. Either party may terminate with a notice period of 47 days.",
    });
    for (let i = 1; i <= 6; i++)
      await mem.ingest({
        namespace: "chat:gen",
        kind: "conversation",
        origin_chat_id: null,
        source: { type: "message", id: `m${i}`, title: "Ana", ts: T0 + i * 1000 },
        text: "@Tech what is the contract termination notice period?",
      });
  }

  it("never swaps a taught hit in when the agent does not share private knowledge in chats", async () => {
    await db.query("update sa.agents set share_private_in_chats = 'never' where id = $1", [AGENT]);
    await seed();

    await invokeTool(AGENT, "memory_recall", { query: "contract termination notice period" });

    const ids = recallsFor("t1").map((r) => r.hit.source.id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("doc1");
  });

  it("never swaps a taught hit in on a retry turn that excludes taught knowledge", async () => {
    await seed();
    toolLog.begin(AGENT, "gen", { requesterUserId: "ana", turnId: "t2" });
    beginTurn(
      {
        turnId: "t2",
        agentId: AGENT,
        agentName: "Tech",
        chatId: "gen",
        replyTo: null,
        triggerMessageId: null,
        requesterUserId: "ana",
        trigger: "mention",
        prompt: "hi",
        noTaught: true,
      },
      () => {},
    );

    await invokeTool(AGENT, "memory_recall", { query: "contract termination notice period" });

    const ids = recallsFor("t2").map((r) => r.hit.source.id);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("doc1");
  });
});
