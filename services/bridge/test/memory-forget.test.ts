import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginTurn, clearTurnHooks } from "../src/agents/turn-hooks.js";
import { decide, initApprovals } from "../src/approvals/service.js";
import { clearRegisteredTools, invokeTool, setToolDeps } from "../src/mcp/registry.js";
import { ToolLog } from "../src/mcp/tool-log.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { plugin } from "../src/plugins/gated-tools.js";
import { approvalsWorld } from "./approvals-fixture.js";
import { FakeMemory } from "./fakes/memory-fake.js";

type World = Awaited<ReturnType<typeof approvalsWorld>>;
let w: World;
let mem: FakeMemory;
let toolLog: ToolLog;
let n = 0;

beforeEach(async () => {
  w = await approvalsWorld();
  // c2: the agent's other chat, without Bob.
  await w.db.query(
    "insert into sa.chats (id, title, kind, created_by) values ('c2','Ops','group','ana')",
  );
  for (const [type, id] of [
    ["user", "ana"],
    ["agent", "nora"],
  ])
    await w.db.query(
      "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('c2',$1,$2,'member')",
      [type, id],
    );
  mem = new FakeMemory();
  setMemoryForTests(mem);
  toolLog = new ToolLog();
  setToolDeps({ db: w.db, opsSimUrl: "http://127.0.0.1:1", toolLog });
  initApprovals({ db: w.db, agentHost: w.host, opsSimUrl: "http://127.0.0.1:1", log: () => {} });
  await plugin.init?.({
    db: w.db,
    relayAdmin: { setMember: async () => {} },
    relayInternalUrl: "http://127.0.0.1:1",
    ticketFor: async () => "",
    opsSimUrl: "http://127.0.0.1:1",
    agentHost: w.host,
    log: () => {},
  });
});

afterEach(async () => {
  clearTurnHooks();
  clearRegisteredTools();
  setMemoryForTests(undefined);
  await w.db.close();
});

async function forget(about: string, requester: string): Promise<string> {
  const turnId = `turn-${++n}`;
  toolLog.begin("nora", "c1", { requesterUserId: requester, turnId });
  beginTurn(
    {
      turnId,
      agentId: "nora",
      agentName: "Nora",
      chatId: "c1",
      replyTo: "root1",
      triggerMessageId: "root1",
      requesterUserId: requester,
      trigger: "mention",
      prompt: "forget",
      noTaught: false,
    },
    () => {},
  );
  return invokeTool("nora", "memory_forget", { about });
}

/** A knowledge item row plus its memory entries (one per part id). */
async function item(opts: {
  id: string;
  kind: "document" | "note";
  title: string;
  text: string;
  taughtBy: string | null;
  origin: string | null;
  parts?: string[];
}) {
  await w.db.query(
    "insert into sa.knowledge_items (id, agent_id, kind, title, taught_by, origin_chat_id) values ($1,'nora',$2,$3,$4,$5)",
    [opts.id, opts.kind, opts.title, opts.taughtBy, opts.origin],
  );
  for (const sid of [opts.id, ...(opts.parts ?? [])])
    await mem.ingest({
      namespace: "agent:nora",
      kind: "knowledge",
      origin_chat_id: opts.origin,
      source: {
        type: opts.kind === "document" ? "doc" : "note",
        id: sid,
        title: opts.title,
        ts: 1,
      },
      text: opts.text,
    });
}
const items = async () =>
  (await w.db.query<{ id: string }>("select id from sa.knowledge_items order by id")).map(
    (r) => r.id,
  );
const recallAll = (query: string) =>
  mem.recall({ scopes: [{ namespace: "agent:nora" }], query, k: 8 });

describe("memory_forget (T9)", () => {
  it("deletes the agent's own note at once, from the table and from memory, without an approval", async () => {
    await item({
      id: "n1",
      kind: "note",
      title: "Parking spot",
      text: "Parking spot is level 3",
      taughtBy: null,
      origin: "c1",
    });

    const out = await forget("parking spot", "bob");

    expect(out).toContain("Parking spot");
    expect(await items()).toEqual([]);
    expect(await recallAll("parking")).toEqual([]);
    const approvals = await w.db.query("select id from sa.approvals");
    expect(approvals).toEqual([]);
  });

  it("forgetting a document Ana taught, asked by Bob, waits for Ana and then deletes every part", async () => {
    await item({
      id: "d1",
      kind: "document",
      title: "pricing.pdf",
      text: "pricing tiers for enterprise customers",
      taughtBy: "ana",
      origin: null,
      parts: ["d1.p1", "d1.p2"],
    });

    const out = await forget("pricing tiers", "bob");

    expect(out).toContain("Ana");
    expect(await items()).toEqual(["d1"]);
    const rows = await w.db.query<{ id: string; approver_user_id: string; status: string }>(
      "select id, approver_user_id, status from sa.approvals where tool = 'memory_forget'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approver_user_id: "ana", status: "pending" });
    expect((await recallAll("pricing")).length).toBe(3);

    const byRequester = await decide(rows[0]?.id as string, "bob", { decision: "approve" });
    expect(byRequester.ok).toBe(false);
    expect(await items()).toEqual(["d1"]);

    const byTeacher = await decide(rows[0]?.id as string, "ana", { decision: "approve" });
    expect(byTeacher.ok && byTeacher.approval.status).toBe("executed");
    expect(await items()).toEqual([]);
    expect(await recallAll("pricing")).toEqual([]);
  });

  it("cannot reach a note born in another chat", async () => {
    await item({
      id: "n2",
      kind: "note",
      title: "Salary talk",
      text: "salary negotiation notes for Zoe",
      taughtBy: null,
      origin: "c2",
    });

    const out = await forget("salary negotiation", "bob");

    expect(out).toBe("Nothing I know here matches that.");
    expect(await items()).toEqual(["n2"]);
    expect((await recallAll("salary")).length).toBe(1);
  });
});
