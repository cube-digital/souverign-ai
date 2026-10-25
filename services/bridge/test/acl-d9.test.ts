import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginTurn } from "../src/agents/turn-hooks.js";
import { decide } from "../src/approvals/service.js";
import { type Db, openDb } from "../src/db.js";
import { clearRegisteredTools, invokeTool, setToolDeps } from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { registerMemoryTools } from "../src/memory/tools.js";
import { recallsFor } from "../src/memory/turn-recalls.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory } from "./fakes/memory-fake.js";
import { gateWorld, RECALL_DIRECTIVE } from "./share-gate-fixture.js";
import { addPersonalAgent, metaOf, rekey, sleep, textOf, textsFrom } from "./teammates-fixture.js";

const EARLY = "2026-01-02T00:00:00Z";
const MAX_JOINED = "2026-03-01T00:00:00Z";
const BEFORE_MAX = Date.UTC(2026, 1, 15);
const AFTER_MAX = Date.UTC(2026, 3, 1);
const DOC_TS = Date.UTC(2026, 9, 21);

let db: Db;
let toolLog: ToolLog;
let mem: FakeMemory;
let n = 0;

beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  for (const [id, name] of [
    ["ana", "Ana"],
    ["vlad", "Vlad"],
  ])
    await db.query(
      "insert into sa.users (id, display_name, pin_hash, kind) values ($1,$2,'x','person')",
      [id, name],
    );
  for (const [id, name, owner] of [
    ["nora", "Nora", "ana"],
    ["iris", "Iris", "ana"],
    ["max", "Max", "vlad"],
  ])
    await db.query(
      "insert into sa.agents (id, owner_user_id, name, template) values ($1,$2,$3,'general')",
      [id, owner, name],
    );
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template, scope, roster_id) values ('scribe', null, 'Scribe', 'general', 'workspace', 'scribe')",
  );
  const chats: [string, string, string, [string, string, string][]][] = [
    [
      "project",
      "Project",
      "group",
      [
        ["user", "ana", EARLY],
        ["user", "vlad", EARLY],
        ["agent", "nora", EARLY],
        ["agent", "scribe", EARLY],
        ["agent", "max", MAX_JOINED],
      ],
    ],
    [
      "ops",
      "Ops",
      "group",
      [
        ["user", "vlad", EARLY],
        ["agent", "max", EARLY],
      ],
    ],
    [
      "secret",
      "Secret",
      "group",
      [
        ["user", "ana", EARLY],
        ["agent", "scribe", EARLY],
      ],
    ],
    [
      "dm-ana-iris",
      "Iris",
      "dm",
      [
        ["user", "ana", EARLY],
        ["agent", "iris", EARLY],
      ],
    ],
    [
      "dm-vlad-scribe",
      "Scribe",
      "dm",
      [
        ["user", "vlad", EARLY],
        ["agent", "scribe", EARLY],
      ],
    ],
  ];
  for (const [id, title, kind, members] of chats) {
    await db.query("insert into sa.chats (id, title, kind, created_by) values ($1,$2,$3,'ana')", [
      id,
      title,
      kind,
    ]);
    for (const [type, mid, joined] of members)
      await db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ($1,$2,$3,'member',$4)",
        [id, type, mid, joined],
      );
  }
  toolLog = new ToolLog();
  setToolDeps({ db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  mem = new FakeMemory();
  setMemoryForTests(mem);
  registerMemoryTools();
});

afterEach(async () => {
  clearRegisteredTools();
  setMemoryForTests(undefined);
  await db.close();
});

/** Opens a turn for the agent in a chat (what the host does) and returns its id. */
function turn(agentId: string, chatId: string, requester: string, noTaught = false): string {
  const turnId = `turn-${++n}`;
  toolLog.begin(agentId, chatId, { requesterUserId: requester, turnId });
  beginTurn(
    {
      turnId,
      agentId,
      agentName: agentId,
      chatId,
      replyTo: null,
      triggerMessageId: null,
      requesterUserId: requester,
      trigger: "mention",
      prompt: "hi",
      noTaught,
    },
    () => {},
  );
  return turnId;
}
const recall = (agentId: string, query: string) => invokeTool(agentId, "memory_recall", { query });
const message = (chat: string, id: string, text: string, ts: number) =>
  mem.ingest({
    namespace: `chat:${chat}`,
    kind: "conversation",
    origin_chat_id: null,
    source: { type: "message", id, title: "Ana", ts },
    text,
  });
const agentChunk = (agent: string, id: string, text: string, origin: string | null) =>
  mem.ingest({
    namespace: `agent:${agent}`,
    kind: "knowledge",
    origin_chat_id: origin,
    source: { type: origin ? "note" : "doc", id, title: id, ts: DOC_TS },
    text,
  });

describe("D-9 ACL", () => {
  it("(a)+(d) an agent never gets another agent's space, also not in a shared chat or the owner's DM", async () => {
    await agentChunk("nora", "n-doc", "zebra ledger taught by Ana to Nora", null);
    await agentChunk("nora", "n-note", "zebra note Nora took in Project", "project");
    await message("project", "m1", "zebra standup in Project", AFTER_MAX);
    await agentChunk("iris", "i-doc", "zebra memo taught to Iris", null);

    turn("max", "project", "vlad");
    const maxOut = await recall("max", "zebra");
    turn("iris", "dm-ana-iris", "ana");
    const irisOut = await recall("iris", "zebra");

    expect(maxOut).toContain("zebra standup in Project");
    expect(maxOut).not.toContain("Nora");
    expect(irisOut).toBe('[1] "zebra memo taught to Iris"\n    source: i-doc');
  });

  it("(b) an agent added after message M never gets M, but gets what came after", async () => {
    await message("project", "m-old", "kestrel launch codename", BEFORE_MAX);
    await message("project", "m-new", "kestrel retro notes", AFTER_MAX);
    turn("max", "project", "vlad");

    const out = await recall("max", "kestrel");

    expect(out).toContain("kestrel retro notes");
    expect(out).not.toContain("codename");
  });

  it("(c) in Ops an agent gets nothing from chat:project nor its own note born in Project", async () => {
    await message("project", "p1", "falcon update in Project", AFTER_MAX);
    await message("ops", "o1", "falcon watch in Ops", AFTER_MAX);
    turn("max", "project", "vlad");
    await invokeTool("max", "memory_remember", { text: "falcon rollout note" });
    turn("max", "ops", "vlad");

    const out = await recall("max", "falcon");

    expect(out).toContain("falcon watch in Ops");
    expect(out).not.toContain("in Project");
    expect(out).not.toContain("rollout");
  });

  it("(f) with never, recall in a shared chat returns nothing with an empty origin_chat_id", async () => {
    await agentChunk("nora", "n-doc", "retention clause seven years", null);
    await agentChunk("nora", "n-note", "retention clause discussed in Project", "project");
    await db.query("update sa.agents set share_private_in_chats = 'never' where id = 'nora'");
    const id = turn("nora", "project", "ana");

    const out = await recall("nora", "retention clause");

    expect(out).toContain("discussed in Project");
    expect(out).not.toContain("seven years");
    expect(recallsFor(id).map((r) => r.hit.origin_chat_id)).toEqual(["project"]);
  });

  it("D-13 a workspace agent in a person's DM does not return a note from a chat that person is not in", async () => {
    turn("scribe", "secret", "ana");
    await invokeTool("scribe", "memory_remember", { text: "osprey budget cut in Secret" });
    turn("scribe", "project", "ana");
    await invokeTool("scribe", "memory_remember", { text: "osprey budget agreed in Project" });
    turn("scribe", "dm-vlad-scribe", "vlad");

    const out = await recall("scribe", "osprey budget");

    expect(out).toContain("agreed in Project");
    expect(out).not.toContain("Secret");
  });
});

describe("D-9 (e) the ask gate holds the answer", () => {
  let gw: Awaited<ReturnType<typeof gateWorld>> | undefined;
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it("with ask, a reply using taught knowledge creates a pending approval and nothing of it reaches the chat before Approve", async () => {
    gw = await gateWorld();
    const { w, ana, bob, chat } = gw;
    const nora = await addPersonalAgent(w, ana, chat, "Nora");
    await rekey(w, chat, ana, [ana, bob], [nora]);
    await gw.teach(nora.id, "itemA", "ana");
    await gw.setShare(nora.id, "ask");

    await bob.engine.sendText(chat, `@Nora ${RECALL_DIRECTIVE}`);

    await expect.poll(() => textsFrom(bob, nora.device_id).length, { timeout: 8000 }).toBe(1);
    await sleep(400);
    const rows = await gw.approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "share",
      tool: "share_answer",
      status: "pending",
      approver_user_id: "ana",
    });
    const heldMsgs = textsFrom(bob, nora.device_id);
    expect(heldMsgs).toHaveLength(1);
    expect(textOf(heldMsgs[0]!)).toBe(
      "Nora prepared an answer that uses what Ana taught it. Waiting for Ana to approve.",
    );
    expect(metaOf(heldMsgs[0]!)?.held).toBe(rows[0]?.id);
    expect(metaOf(heldMsgs[0]!)?.trace).toBeUndefined();
    expect(metaOf(heldMsgs[0]!)?.citations).toBeUndefined();
    // nothing in anything bob sees (text, draft, trace with tool results) carries the answer
    expect(JSON.stringify(bob.seen.map((m) => m.body))).not.toContain("47 days");

    await decide(rows[0]?.id ?? "", "ana", { decision: "approve" });

    await expect.poll(() => textsFrom(bob, nora.device_id).length, { timeout: 8000 }).toBe(2);
    expect(textOf(textsFrom(bob, nora.device_id)[1]!)).toContain("47 days");
  }, 30000);
});
