import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadScopeInput } from "../src/memory/scope-input.js";
import { recallScopes, type ScopeInput } from "../src/memory/scopes.js";
import { migrate } from "../src/migrate.js";
import { FakeMemory } from "./fakes/memory-fake.js";

const max = { id: "max", scope: "workspace", ownerUserId: null, share: "always" } as const;
const base = (chat: Partial<ScopeInput["chat"]>): ScopeInput => ({
  agent: max,
  shared: [],
  noTaught: false,
  approverAvailable: true,
  chat: {
    id: "ops",
    kind: "group",
    agentJoinedAt: 1000,
    humans: ["ana", "bob"],
    agents: ["max"],
    ...chat,
  },
});

describe("scope bounds (fix round 1)", () => {
  it("a chat scope starts at the later of the agent's and the requester's join, except shared history", () => {
    const since = (c: Partial<ScopeInput["chat"]>) =>
      recallScopes(base(c)).find((s) => s.namespace === "chat:ops")?.since_ts;
    expect(since({ requesterJoinedAt: 5000 })).toBe(5000);
    expect(since({ requesterJoinedAt: 500 })).toBe(1000);
    expect(since({ requesterJoinedAt: 5000, historyShared: true })).toBe(1000);
    expect(since({ agentJoinedAt: 1000.4 })).toBe(1001);
  });

  it("loadScopeInput reports the requester's join and whether the chat has shared history", async () => {
    const db = await openDb("pglite://memory");
    await migrate(db);
    for (const u of ["ana", "bob"])
      await db.query(
        "insert into sa.users (id, display_name, pin_hash, kind) values ($1,$1,'x','person')",
        [u],
      );
    await db.query(
      "insert into sa.agents (id, name, template, scope) values ('max','max','general','workspace')",
    );
    await db.query(
      "insert into sa.chats (id, title, kind, created_by) values ('ops','ops','group','ana')",
    );
    const add = (t: string, id: string, at: string) =>
      db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ('ops',$1,$2,'member',$3)",
        [t, id, at],
      );
    await add("agent", "max", "2026-01-01T00:00:00Z");
    await add("user", "bob", "2026-01-05T00:00:00Z");
    const inp = await loadScopeInput(db, "max", "ops", { noTaught: false, requesterUserId: "bob" });
    expect(inp?.chat.requesterJoinedAt).toBe(Date.parse("2026-01-05T00:00:00Z"));
    expect(inp?.chat.historyShared).toBe(false);
    await db.query("update sa.chats set history_until_seq = 3 where id = 'ops'");
    expect(
      (await loadScopeInput(db, "max", "ops", { noTaught: false, requesterUserId: "bob" }))?.chat
        .historyShared,
    ).toBe(true);
    await db.close();
  });

  it("include_parts deletes `id.x` parts but not `id0.x` look-alikes (same separator as the store)", async () => {
    const mem = new FakeMemory();
    const put = (id: string) =>
      mem.ingest({
        namespace: "agent:max",
        kind: "knowledge",
        source: { type: "doc", id, ts: 1 },
        text: "budget",
      });
    await put("doc1");
    await put("doc1.x");
    await put("doc10.x");
    expect(
      await mem.deleteSource({
        namespace: "agent:max",
        source_type: "doc",
        source_id: "doc1",
        include_parts: true,
      }),
    ).toBe(2);
    const left = await mem.recall({ scopes: [{ namespace: "agent:max" }], query: "budget" });
    expect(left.map((h) => h.source.id)).toEqual(["doc10.x"]);
  });
});
