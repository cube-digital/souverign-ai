import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MemoryClient } from "../src/memory/client.js";
import { loadScopeInput } from "../src/memory/scope-input.js";
import { chatSince, recallScopes } from "../src/memory/scopes.js";
import { migrate } from "../src/migrate.js";

const T = (iso: string) => Date.parse(iso);

describe("memory scope bounds", () => {
  it("seeded rooms get no exemption and the bound is the later of agent and requester join", async () => {
    expect(chatSince({ agentJoinedAt: 100, requesterJoinedAt: 300 })).toBe(300);
    const db = await openDb("pglite://memory");
    await migrate(db);
    for (const [id, kind] of [
      ["ana", "person"],
      ["bob", "person"],
    ])
      await db.query(
        "insert into sa.users (id, display_name, pin_hash, kind) values ($1,$1,'x',$2)",
        [id, kind],
      );
    await db.query(
      "insert into sa.agents (id, owner_user_id, name, template) values ('nora','ana','nora','general')",
    );
    await db.query(
      "insert into sa.chats (id, title, kind, created_by, history_until_seq) values ('room','room','room','ana',5)",
    );
    const m = (type: string, id: string, at: string) =>
      db.query(
        "insert into sa.chat_members (chat_id, member_type, member_id, role, joined_at) values ('room',$1,$2,'member',$3)",
        [type, id, at],
      );
    await m("user", "ana", "2026-01-01T00:00:00Z");
    await m("user", "bob", "2026-01-05T00:00:00Z");
    await m("agent", "nora", "2026-01-03T00:00:00Z");

    const bobIn = await loadScopeInput(db, "nora", "room", {
      noTaught: false,
      requesterUserId: "bob",
    });
    expect(bobIn).not.toBeNull();
    if (!bobIn) return;
    const scopes = recallScopes(bobIn);
    expect(
      scopes.every((s) =>
        s.namespace === "agent:nora" && s.origin_chat_ids?.[0] === null
          ? true
          : s.since_ts === T("2026-01-05T00:00:00Z"),
      ),
    ).toBe(true);

    // proactive (no requester) and non-member requester: latest active human join
    for (const requesterUserId of [null, "zed"]) {
      const inp = await loadScopeInput(db, "nora", "room", { noTaught: false, requesterUserId });
      const chat = recallScopes(inp as NonNullable<typeof inp>).find(
        (s) => s.namespace === "chat:room",
      );
      expect(chat?.since_ts).toBe(T("2026-01-05T00:00:00Z"));
    }
    await db.close();
  });

  it("MemoryClient accepts https and loopback http, refuses remote http", () => {
    expect(() => new MemoryClient("https://mem.example.com", "t")).not.toThrow();
    expect(() => new MemoryClient("http://127.0.0.1:8646", "t")).not.toThrow();
    expect(() => new MemoryClient("http://mem.example.com", "t")).toThrow();
  });
});
